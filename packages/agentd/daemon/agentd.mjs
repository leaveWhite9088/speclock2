#!/usr/bin/env node
/**
 * agentd — the scheduler daemon.
 *
 * Holds the single AgentPool (one resident ACP process per agent) so that agent
 * lifetime stops being tied to a pi session. Any number of front ends (the pi
 * extension, ad-hoc scripts) connect over one local endpoint and
 * share the same connections, session registry and job registry.
 *
 * Transport: Windows named pipe (default `\\.\pipe\pi-agentd`), or TCP
 * `127.0.0.1:AGENTD_PORT` when AGENTD_PORT is set. Both are local-only.
 *
 * Protocol: newline-delimited JSON.
 *   client -> daemon  {"id":"1","op":"run","args":{...}}
 *   daemon -> client  {"id":"1","ok":true,"result":{...}}
 *                     {"id":"1","ok":false,"error":"..."}
 *   daemon -> client  {"event":"progress","jobId":"...","chars":12,...}
 *                     {"event":"done","jobId":"...","result":{...}}
 *
 * Lifecycle: started on demand by the client; exits after AGENTD_IDLE_MIN
 * minutes with no connections and no running jobs.
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  writeFileSync,
  readFileSync,
  appendFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENTS,
  BASE_CWD,
  CONFIG,
  pool,
  getAgent,
  createInstance,
  removeInstance,
  listInstances,
  readTranscript,
  aliveCount,
  MAX_PROCESSES,
} from '../core/agent-pool.mjs';
import { Dispatcher } from '../core/dispatcher.mjs';
import * as projects from '../core/projects.mjs';
import { addProvider, removeProvider, listProviders, agentDir } from '../core/pi-models.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const PIPE_NAME = process.env.AGENTD_PIPE || '\\\\.\\pipe\\pi-agentd';
const PORT = process.env.AGENTD_PORT ? Number(process.env.AGENTD_PORT) : null;
const ENDPOINT_FILE = join(ROOT, 'data', 'agentd.endpoint.json');
/** Append-only log of finished runs, so receipts survive restarts and idle gaps. */
const RECEIPTS_FILE = join(ROOT, 'data', 'receipts.jsonl');
const IDLE_MS = Number(process.env.AGENTD_IDLE_MIN || 30) * 60_000;
const PROTOCOL = 3;
/** Project instances and dispatchers idle for this long are stopped. */
const IDLE_INSTANCE_MS = Number(process.env.AGENTD_INSTANCE_IDLE_MIN || CONFIG?.limits?.idleMinutes || 15) * 60_000;

const log = (...a) => process.stderr.write(`[agentd] ${a.join(' ')}\n`);
const startedAt = new Date().toISOString();

// ---------------------------------------------------------------------------
// Event stream: identity, ring buffer, delivery
// ---------------------------------------------------------------------------
//
// Every durable event gets `<epoch>-<seq>`:
//   epoch  changes when the daemon restarts, so a stale Last-Event-ID is detected
//   seq    is monotonic within one daemon lifetime
//
// Semantic events (job.started / job.done / agent.exit) are kept in a bounded
// ring so a consumer can resume with `events.since`. High-frequency `progress`
// events are delivered live but never ringed and never get an id: replaying a
// cumulative char count would be meaningless.

const EPOCH = randomUUID().slice(0, 8);
const RING_MAX = 2000;
const ring = [];
let seq = 0;

/** @type {Map<string, Set<import('node:net').Socket>>} */
const subscribers = new Map();
/** Sockets that asked for every event (the web bridge will do this). */
const allSubscribers = new Set();
/** Every connected socket: system events (no jobId) go to all of them. */
const clients = new Set();
function writeAll(socks, payload) {
  const line = JSON.stringify(payload) + '\n';
  for (const sock of socks) {
    try {
      sock.write(line);
    } catch {
      /* a broken socket is cleaned up by its own handler */
    }
  }
}

/** Allocate the next durable event id. */
function allocEvent(type, payload = {}) {
  seq += 1;
  return { id: `${EPOCH}-${seq}`, seq, epoch: EPOCH, event: type, ts: new Date().toISOString(), ...payload };
}

function deliver(ev) {
  // System events have no jobId and are relevant to every connected client.
  if (!ev.jobId) return writeAll(clients, ev);
  if (subscribers.has(ev.jobId)) writeAll(subscribers.get(ev.jobId), ev);
  if (allSubscribers.size) writeAll(allSubscribers, ev);
}

/** Store a durable event and deliver it. */
function publish(ev) {
  ring.push(ev);
  while (ring.length > RING_MAX) ring.shift();
  deliver(ev);
  return ev;
}

/** Deliver a live-only event (progress). Never ringed, no id. */
function publishEpehemeral(jobId, payload) {
  const ev = { event: 'progress', jobId, ts: new Date().toISOString(), ...payload };
  if (subscribers.has(jobId)) writeAll(subscribers.get(jobId), ev);
  if (allSubscribers.size) writeAll(allSubscribers, ev);
}

/**
 * Deliver a live-only event to the connections that asked for everything
 * (subscribe to '*'). Used for the dispatcher stream.
 */
function publishLive(event, payload) {
  if (!allSubscribers.size) return;
  writeAll(allSubscribers, { event, ts: new Date().toISOString(), ...payload });
}

function subscribe(sock, jobId) {
  if (jobId === '*') {
    allSubscribers.add(sock);
    return;
  }
  if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
  subscribers.get(jobId).add(sock);
}

function unsubscribe(sock, jobId) {
  if (jobId === '*') {
    allSubscribers.delete(sock);
    return;
  }
  const set = subscribers.get(jobId);
  if (!set) return;
  set.delete(sock);
  if (set.size === 0) subscribers.delete(jobId);
}

/** Replay ringed events after `afterId`. Detects a daemon restart via epoch. */
function eventsSince(afterId, limit = 500) {
  if (!afterId) return { reset: false, epoch: EPOCH, events: ring.slice(-limit), hasMore: ring.length > limit };

  const dash = String(afterId).lastIndexOf('-');
  const epoch = dash > 0 ? String(afterId).slice(0, dash) : null;
  const fromSeq = dash > 0 ? Number(String(afterId).slice(dash + 1)) : NaN;

  if (epoch !== EPOCH || !Number.isFinite(fromSeq)) {
    // Different daemon lifetime: the caller must reload history from receipts.
    return { reset: true, epoch: EPOCH, events: [], reason: 'epoch-mismatch' };
  }

  const events = ring.filter((e) => e.seq > fromSeq).slice(0, limit);
  return { reset: false, epoch: EPOCH, events, hasMore: events.length === limit };
}

// ---------------------------------------------------------------------------
// Progress sink: every agent forwards its stream updates to subscribers.
// ---------------------------------------------------------------------------

function wireAgent(agent) {
  agent.setProgressSink((jobId, p) => publishEpehemeral(jobId, p));
  // An unexpected exit is a health event even when no run is in flight.
  agent.onExit = (info) => {
    publish(allocEvent('agent.exit', { ...info }));
  };
}
for (const agent of pool.values()) wireAgent(agent);

// ---------------------------------------------------------------------------
// Dispatcher: the pi that picks the agent. Started on first use.
// ---------------------------------------------------------------------------

/** One dispatcher per project, plus the global one under the key ''. */
const dispatchers = new Map();

function getDispatcher(project = null) {
  const key = project || '';
  let d = dispatchers.get(key);
  if (d) return d;
  if (project) {
    d = new Dispatcher({
      cwd: projects.projectRoot(project),
      project,
      sessionDir: join(ROOT, 'data', 'dispatcher-sessions', project),
      onEvent: (ev) => publishLive('dispatcher.event', { project, data: ev }),
    });
  } else {
    d = new Dispatcher({
      cwd: process.env.AGENTD_CWD_DISPATCHER || CONFIG?.dispatcher?.cwd || BASE_CWD,
      onEvent: (ev) => publishLive('dispatcher.event', { project: null, data: ev }),
    });
  }
  dispatchers.set(key, d);
  return d;
}

const anyDispatcherBusy = () => [...dispatchers.values()].some((d) => d.busy);

/** Dispatchers that are running now get a restart after models.json changed. */
async function restartRunningDispatchers() {
  const out = [];
  for (const [key, d] of dispatchers) {
    if (!d.child) continue;
    out.push({ project: key || null, ...(await d.restart()) });
  }
  return out;
}

/**
 * Requests from a project's dispatcher carry `project`. Everything it names is
 * resolved inside that project, and a name that already points elsewhere is refused.
 */
const AGENT_ARG_OPS = new Set([
  'status', 'sessions', 'use', 'new', 'rename', 'models', 'setModel', 'run', 'tail', 'wait', 'cancel', 'transcript',
]);

function scopeArgs(op, args) {
  const project = args?.project;
  if (!project || !AGENT_ARG_OPS.has(op)) return args;
  if (!projects.hasProject(project)) throw new Error(`unknown project "${project}"`);
  const agent = args.agent;
  if (!agent) throw new Error('agent is required inside a project');
  if (String(agent).includes(projects.SEP)) throw new Error(`agent "${agent}" is outside project "${project}"`);
  const scoped = { ...args, agent: `${project}${projects.SEP}${agent}` };
  // A directory the dispatcher names must stay inside the project root.
  if (args.cwd) scoped.cwd = projects.resolveInside(projects.projectRoot(project), args.cwd);
  return scoped;
}

/** Rows of one project, with short names when the caller is that project's dispatcher. */
function viewRows(rows, project, short) {
  const mine = rows.filter((r) => (project ? r.project === project : true));
  if (!short) return mine;
  return mine.map((r) => ({ ...r, key: r.id ?? r.name, ...(r.id ? { id: r.shortId } : { name: r.shortId }) }));
}

// ---------------------------------------------------------------------------
// Receipts: one line per finished run
// ---------------------------------------------------------------------------

function appendReceipt(agent, result, prompt, eventId = null) {
  const m = result?.metrics ?? {};
  const receipt = {
    ts: new Date().toISOString(),
    eventId,
    jobId: m.jobId ?? null,
    agent,
    sessionId: result?.sessionId ?? null,
    status: m.error ? 'failed' : m.stopReason === 'cancelled' ? 'cancelled' : 'done',
    stopReason: m.stopReason ?? null,
    durationMs: m.durationMs ?? null,
    health: m.health ?? 'ok',
    attention: m.attention ?? [],
    model: m.modelName ?? m.model ?? null,
    tokens: m.tokens ?? null,
    context: m.context ?? null,
    chars: m.chars ?? 0,
    prompt: typeof prompt === 'string' ? prompt.slice(0, 160) : null,
  };
  try {
    mkdirSync(dirname(RECEIPTS_FILE), { recursive: true });
    appendFileSync(RECEIPTS_FILE, JSON.stringify(receipt) + '\n', 'utf8');
  } catch (err) {
    log('could not write receipt:', err.message);
  }
  return receipt;
}

function readReceipts(limit = 50) {
  try {
    const lines = readFileSync(RECEIPTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Refuse while something of the project runs (unless forced), then stop its dispatcher. */
async function stopProjectProcesses(project, force) {
  const d = dispatchers.get(project);
  const busy = [
    ...projects.instancesOf(project).filter((a) => a.busy).map((a) => a.shortId),
    ...(d?.busy ? ['(dispatcher)'] : []),
  ];
  if (busy.length && !force) throw new Error(`still running: ${busy.join(', ')}`);
  if (d?.busy) await d.abort().catch(() => {});
  await d?.shutdown();
}

const OPS = {
  hello: () => ({
    protocol: PROTOCOL,
    epoch: EPOCH,
    pid: process.pid,
    startedAt,
    baseCwd: BASE_CWD,
    agents: [...pool.keys()],
    types: Object.keys(AGENTS),
  }),

  /** Every instance in the pool, built-in and created. */
  agents: ({ project, short } = {}) => ({
    agents: viewRows([...pool.entries()].map(([name, a]) => ({
      name,
      project: a.project,
      shortId: a.shortId,
      role: a.role,
      type: a.type,
      custom: a.custom,
      label: a.spec.label,
      description: a.spec.description,
      cwd: a.spec.defaultCwd ?? null,
      alive: Boolean(a.child),
      spawns: a.spawnCount,
      sessionId: a.sessionId,
      busy: a.busy,
    })), project, short),
  }),

  instances: ({ project, short } = {}) => ({
    instances: viewRows(listInstances(), project, short),
    types: Object.keys(AGENTS),
  }),

  'instance.create': ({ id, type, cwd, dir, role, project }) => {
    // Inside a project the directory is relative to the project root.
    if (project) {
      const r = projects.addInstance(project, { id, type, dir: dir ?? cwd ?? '.', role });
      wireAgent(pool.get(r.key));
      return { id: r.id, type: r.type, cwd: r.cwd, key: r.key, role: r.role };
    }
    const agent = createInstance({ id, type, cwd });
    wireAgent(agent);
    return { id: agent.name, type: agent.type, cwd: agent.spec.defaultCwd };
  },

  'instance.remove': ({ id }) => removeInstance(id),

  /**
   * Conversation record of one session, as agentd saw it. Without sessionId it
   * reads the instance's active session. Cursor: pass the last seq as `afterSeq`.
   */
  transcript: ({ agent, sessionId, afterSeq, limit, tail }) => {
    const a = getAgent(agent);
    const sid = sessionId || a.sessionId;
    if (!sid) throw new Error(`${a.name} has no active session; pass sessionId`);
    return readTranscript(a.name, sid, { afterSeq, limit, tail });
  },

  // -- dispatcher (the pi that chooses agents) ---------------------------

  'dispatcher.state': ({ project } = {}) => getDispatcher(project).state(),
  'dispatcher.models': ({ project } = {}) => getDispatcher(project).models(),
  'dispatcher.setModel': ({ project, value }) => getDispatcher(project).setModel(value),
  'dispatcher.setThinking': ({ project, level }) => getDispatcher(project).setThinking(level),
  'dispatcher.prompt': ({ project, message }) => getDispatcher(project).prompt(message),
  'dispatcher.abort': ({ project } = {}) => getDispatcher(project).abort(),
  'dispatcher.new': ({ project } = {}) => getDispatcher(project).newSession(),
  'dispatcher.sessions': ({ project } = {}) => getDispatcher(project).sessions(),
  'dispatcher.use': ({ project, sessionFile }) => getDispatcher(project).switchSession(sessionFile),
  'dispatcher.messages': ({ project } = {}) => getDispatcher(project).messages(),
  'dispatcher.restart': ({ project } = {}) => getDispatcher(project).restart(),

  // -- LLMs of pi (models.json is shared by every dispatcher) ------------

  'dispatcher.customModels': () => ({ agentDir: agentDir(), ...listProviders() }),

  /**
   * Add an LLM: write it to models.json, then restart every dispatcher that is
   * running so pi reads the new file. Refused while any of them is working.
   */
  'dispatcher.addModel': async (spec) => {
    if (anyDispatcherBusy()) throw new Error('a dispatcher is working on a prompt; abort it first');
    const written = addProvider(spec);
    return { ...written, dispatchers: await restartRunningDispatchers() };
  },

  'dispatcher.removeModel': async ({ provider, modelIds }) => {
    if (anyDispatcherBusy()) throw new Error('a dispatcher is working on a prompt; abort it first');
    const removed = removeProvider(provider, modelIds);
    return { ...removed, dispatchers: await restartRunningDispatchers() };
  },

  // -- projects -------------------------------------------------------------

  projects: () => ({
    projects: projects.listProjects().map((p) => ({
      ...p,
      dispatcher: { alive: Boolean(dispatchers.get(p.id)?.child), busy: Boolean(dispatchers.get(p.id)?.busy) },
    })),
    limits: { maxProcesses: MAX_PROCESSES, alive: aliveCount(), idleMinutes: IDLE_INSTANCE_MS / 60_000 },
  }),

  'project.create': (args) => {
    const p = projects.createProject(args);
    for (const a of projects.instancesOf(p.id)) wireAgent(a);
    return p;
  },

  'project.addInstance': ({ project, id, type, dir, role }) => {
    const r = projects.addInstance(project, { id, type, dir, role });
    wireAgent(pool.get(r.key));
    return r;
  },

  'project.removeInstance': ({ project, id, force }) => projects.removeInstance(project, id, { force }),

  /** Close a project: stop its processes. Configuration and sessions stay. */
  'project.stop': async ({ project, force }) => {
    await stopProjectProcesses(project, force);
    return projects.stopInstances(project, { force: true });
  },

  'project.remove': async ({ project, force }) => {
    await stopProjectProcesses(project, force);
    dispatchers.delete(project);
    return projects.removeProject(project, { force: true });
  },

  status: ({ agent }) => getAgent(agent).status(),

  sessions: async ({ agent }) => getAgent(agent).serialized(() => getAgent(agent).listSessions()),

  use: async ({ agent, sessionId, cwd }) => getAgent(agent).useSession(sessionId, cwd),

  new: async ({ agent, cwd }) => {
    const a = getAgent(agent);
    const sessionId = await a.newSession(cwd);
    return { agent: a.name, sessionId, cwd: a.cwd };
  },

  rename: ({ agent, sessionId, label }) => getAgent(agent).renameSession(sessionId, label),

  models: async ({ agent, sessionId }) => getAgent(agent).describeModels(sessionId),

  setModel: async ({ agent, value, configId, sessionId }) => {
    const a = getAgent(agent);
    return a.setConfigOption(configId || 'model', value, sessionId);
  },

  /**
   * Blocking run unless `async` is set. In async mode the caller gets the jobId
   * immediately and should `subscribe` to stream progress.
   */
  run: async (
    { agent, prompt, cwd, timeoutMs, reset, sessionId, model, async: isAsync, subscribe: wantSub },
    sock,
  ) => {
    const a = getAgent(agent);
    if (model) await a.setConfigOption('model', model, sessionId);
    const started = a.startPrompt(prompt, { timeoutMs, cwd, reset, sessionId });

    // Subscribe before the run can finish. A fast agent could otherwise complete
    // between the caller receiving the jobId and its separate subscribe call,
    // and the `done` event would be broadcast to nobody.
    if (wantSub && sock) subscribe(sock, started.jobId);

    publish(
      allocEvent('job.started', {
        jobId: started.jobId,
        agent: a.name,
        sessionId: a.sessionId,
        prompt: typeof prompt === 'string' ? prompt.slice(0, 160) : null,
      }),
    );

    const finish = (result, error) => {
      const ev = allocEvent('job.done', {
        jobId: started.jobId,
        agent: a.name,
        ...(error
          ? { error: error.message, metrics: error.metrics ?? { error: error.message, attention: [], health: 'error' } }
          : { result }),
      });
      // The receipt embeds the event id, so history and stream can be joined.
      ev.receipt = appendReceipt(
        a.name,
        error ? { metrics: ev.metrics, sessionId: error.sessionId ?? null } : result,
        prompt,
        ev.id,
      );
      publish(ev);
      return ev;
    };

    if (isAsync) {
      started.done.then((r) => finish(r)).catch((e) => finish(null, e));
      return { jobId: started.jobId, async: true };
    }

    try {
      const r = await started.done;
      const ev = finish(r);
      return { ...r, jobId: started.jobId, receipt: ev.receipt };
    } catch (e) {
      finish(null, e);
      throw e;
    }
  },

  /** Replay durable events after a known id (Last-Event-ID semantics). */
  'events.since': ({ afterId, limit } = {}) => eventsSince(afterId, Math.min(Number(limit) || 500, RING_MAX)),

  /** Recent receipts, newest last. */
  receipts: ({ limit } = {}) => ({ receipts: readReceipts(Math.min(Number(limit) || 50, 500)) }),

  /** Agent health view: liveness + last run's inferred attention. */
  health: async () => {
    const agents = [];
    for (const name of [...pool.keys()]) {
      agents.push(await getAgent(name).serialized(() => getAgent(name).status()));
    }
    return { agents };
  },

  tail: ({ agent, jobId }) => getAgent(agent).tail(jobId),
  wait: ({ agent, jobId }) => getAgent(agent).tail(jobId),

  cancel: ({ agent }) => getAgent(agent).cancel(),

  subscribe: ({ jobId }, sock) => {
    if (jobId) subscribe(sock, jobId);
    return { subscribed: jobId ?? null };
  },

  unsubscribe: ({ jobId }, sock) => {
    if (jobId) unsubscribe(sock, jobId);
    return { subscribed: null };
  },
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

let connections = 0;
let lastActivity = Date.now();

const server = net.createServer((sock) => {
  connections += 1;
  clients.add(sock);
  lastActivity = Date.now();
  let buf = '';
  sock.setEncoding('utf8');

  sock.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        sock.write(JSON.stringify({ ok: false, error: 'invalid json' }) + '\n');
        continue;
      }
      lastActivity = Date.now();
      const op = OPS[msg.op];
      if (!op) {
        sock.write(JSON.stringify({ id: msg.id, ok: false, error: `unknown op: ${msg.op}` }) + '\n');
        continue;
      }
      Promise.resolve()
        .then(() => op(scopeArgs(msg.op, msg.args ?? {}), sock))
        .then((result) => sock.write(JSON.stringify({ id: msg.id, ok: true, result }) + '\n'))
        .catch((err) =>
          sock.write(JSON.stringify({ id: msg.id, ok: false, error: err?.message ?? String(err) }) + '\n'),
        );
    }
  });

  const cleanup = () => {
    connections = Math.max(0, connections - 1);
    clients.delete(sock);
    allSubscribers.delete(sock);
    for (const [jobId, set] of subscribers) {
      set.delete(sock);
      if (set.size === 0) subscribers.delete(jobId);
    }
  };
  sock.on('close', cleanup);
  sock.on('error', cleanup);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log('another agentd is already listening; exiting');
    process.exit(0);
  }
  log('server error:', err.message);
  process.exit(1);
});

const endpoint = PORT ? `127.0.0.1:${PORT}` : PIPE_NAME;
server.listen(PORT ?? PIPE_NAME, () => {
  // Publish the real endpoint so every client finds the same daemon regardless of
  // which shell (PowerShell, WSL, cmd) started it or what env it inherited.
  try {
    mkdirSync(dirname(ENDPOINT_FILE), { recursive: true });
    writeFileSync(
      ENDPOINT_FILE,
      JSON.stringify(
        {
          protocol: PROTOCOL,
          transport: PORT ? 'tcp' : 'pipe',
          path: PORT ? undefined : PIPE_NAME,
          port: PORT ?? undefined,
          pid: process.pid,
          startedAt,
          baseCwd: BASE_CWD,
          endpoint,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    log('could not publish endpoint file:', err.message);
  }
  log(`listening on ${endpoint} (pid ${process.pid})`);
  log(`base cwd: ${BASE_CWD}; instances: ${[...pool.keys()].join(', ')}`);
});

// Idle recycling: project instances and dispatchers that were not used for a while
// are stopped. Their sessions stay on disk and come back on the next use.
setInterval(async () => {
  try {
    const stopped = await projects.sweepIdle(IDLE_INSTANCE_MS);
    for (const [key, d] of dispatchers) {
      if (d.child && !d.busy && Date.now() - d.lastActive > IDLE_INSTANCE_MS) {
        await d.shutdown();
        stopped.push(`dispatcher:${key || 'global'}`);
      }
    }
    if (stopped.length) log(`idle, stopped: ${stopped.join(', ')}`);
  } catch (err) {
    log('idle sweep failed:', err.message);
  }
}, 60_000).unref();

// Idle shutdown: no clients, nothing running.
setInterval(() => {
  const busy = [...pool.values()].some((a) => a.busy) || anyDispatcherBusy();
  if (connections === 0 && !busy && Date.now() - lastActivity > IDLE_MS) {
    log('idle; shutting down');
    shutdown(0);
  }
}, 30_000).unref();

async function shutdown(code) {
  try {
    rmSync(ENDPOINT_FILE, { force: true });
  } catch {
    /* ignore */
  }
  await Promise.all([
    ...[...pool.values()].map((a) => a.shutdown()),
    ...[...dispatchers.values()].map((d) => d.shutdown()),
  ]);
  process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
process.on('uncaughtException', (e) => {
  log('uncaught:', e?.stack ?? String(e));
});
