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
  seedContexts,
} from '../core/agent-pool.mjs';
import { Dispatcher, savedContext } from '../core/dispatcher.mjs';
import { createHandoffs } from '../core/handoff.mjs';
import * as projects from '../core/projects.mjs';
import { EPOCH, RING_MAX, addClient, allocEvent, dropClient, eventsSince, publish, publishEphemeral, publishLive, subscribe, unsubscribe } from './events.mjs';
import { scopeArgs, viewRows } from './guard.mjs';
import { appendReceipt, readReceipts } from './receipts.mjs';
import { clearInterrupted, journalEnd, journalStart, reconcileJournal } from '../core/journal.mjs';
import { endRun, planRun, recordRun } from '../core/tasks.mjs';
import { appendEntry, findJobSession } from '../core/transcripts.mjs';
import { addProvider, removeProvider, listProviders, agentDir } from '../core/pi-models.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const PIPE_NAME = process.env.AGENTD_PIPE || '\\\\.\\pipe\\pi-agentd';
const PORT = process.env.AGENTD_PORT ? Number(process.env.AGENTD_PORT) : null;
const ENDPOINT_FILE = join(ROOT, 'data', 'agentd.endpoint.json');
const IDLE_MS = Number(process.env.AGENTD_IDLE_MIN || 30) * 60_000;
const PROTOCOL = 3;
/** Project instances and dispatchers idle for this long are stopped. */
const IDLE_INSTANCE_MS = Number(process.env.AGENTD_INSTANCE_IDLE_MIN || CONFIG?.limits?.idleMinutes || 15) * 60_000;

const log = (...a) => process.stderr.write(`[agentd] ${a.join(' ')}\n`);
const startedAt = new Date().toISOString();

// Tasks the last daemon never finished: record them now, announce them once the socket is up.
const lostJobs = reconcileJournal();
for (const j of lostJobs) {
  endRun(j.jobId, 'interrupted');
  const error = 'the daemon stopped while this task was queued or running; the executor may have done part of it';
  appendReceipt(
    j.agent,
    { sessionId: null, metrics: { jobId: j.jobId, outcome: 'interrupted', error, health: 'error', attention: [{ code: 'interrupted', severity: 'error', source: 'system', text: error }] } },
    j.prompt,
    null,
    j,
  );
  // The executor's own conversation must say so too: without this the person sees their message and then nothing.
  const sid = findJobSession(j.agent, j.jobId);
  if (sid) {
    appendEntry(j.agent, sid, {
      role: 'error',
      jobId: j.jobId,
      taskId: j.taskId,
      attempt: j.attempt,
      interrupted: true,
      error: '这次任务因服务重启被中断，没有得到回复。执行者可能已经做了一部分，请先检查文件，再决定要不要重发。',
    });
  }
}

// ---------------------------------------------------------------------------
// Progress sink: every agent forwards its stream updates to subscribers.
// ---------------------------------------------------------------------------

function wireAgent(agent) {
  agent.setProgressSink((jobId, p) => publishEphemeral(jobId, p));
  // A prompt that waited behind another really starts now.
  agent.onRunStart = ({ jobId }) => publish(allocEvent('job.running', { jobId, agent: agent.name }));
  agent.onCompact = (info) => {
    publish(allocEvent('agent.compacted', info));
    suggestHandoff(agent, `这个会话已经压缩了 ${info.compactions} 次`, `压缩 ${info.compactions} 次；最近一次从约 ${info.before?.used} 降到 ${info.after?.used} token`, info.compactions >= COMPACTIONS_BEFORE_HANDOFF);
  };
  // Killed for ignoring a cancel: the person should know, and may need to recover it.
  agent.onForcedStop = (info) => publish(allocEvent('agent.forced-stop', { ...info }));
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

const handoffs = createHandoffs({
  getAgent: (key) => getAgent(key),
  keyOf: (project, id) => `${project}${projects.SEP}${id}`,
  onChange: (p) => publishLive('handoff.changed', { project: p.project, data: p }),
});

/**
 * Objective drift signals. Crossing one only raises a proposal; a person still has to confirm it. Context size alone
 * is never a signal: compaction deals with that.
 */
const COMPACTIONS_BEFORE_HANDOFF = 3;
const FAILURES_BEFORE_HANDOFF = 3;
const failStreak = new Map();
function suggestHandoff(agent, reason, evidence, when = true) {
  if (!when || !agent.project) return;
  try {
    handoffs.propose({ project: agent.project, agent: agent.shortId, reason, evidence });
  } catch (err) {
    log('handoff proposal skipped:', err.message);
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
  /** The dispatcher may only propose; a person generates, reviews and applies. */
  'handoff.propose': (a) => handoffs.propose(a),
  'handoff.list': (a) => handoffs.list(a),
  'handoff.generate': (a) => handoffs.generate(a),
  'handoff.apply': (a) => handoffs.apply(a),
  'handoff.cancel': (a) => handoffs.cancel(a),

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
  'dispatcher.dequeue': ({ project, index }) => getDispatcher(project).dequeue(index),
  'dispatcher.new': ({ project } = {}) => getDispatcher(project).newSession(),
  'dispatcher.sessions': ({ project } = {}) => getDispatcher(project).sessions(),
  'dispatcher.deleteSession': ({ project, sessionFile }) => getDispatcher(project).deleteSession(sessionFile),
  'project.dirs': ({ project }) => projects.listDirs(project),
  'dispatcher.renameSession': ({ project, sessionFile, label }) => getDispatcher(project).renameSession(sessionFile, label),
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
      dispatcher: { alive: Boolean(dispatchers.get(p.id)?.child), busy: Boolean(dispatchers.get(p.id)?.busy), queued: (dispatchers.get(p.id)?.queue ?? []).map((m) => m.slice(0, 300)), context: (dispatchers.get(p.id)?.child ? dispatchers.get(p.id)?.context : null) ?? savedContext(join(ROOT, 'data', 'dispatcher-sessions', p.id)) },
    })),
    limits: { maxProcesses: MAX_PROCESSES, alive: aliveCount(), global: aliveCount((a) => !a.project), idleMinutes: IDLE_INSTANCE_MS / 60_000 },
  }),

  'project.create': (args) => {
    const p = projects.createProject(args);
    for (const a of projects.instancesOf(p.id)) wireAgent(a);
    return p;
  },

  'project.addInstance': ({ project, id, type, dir, role, model, sessionId, compactAt }) => {
    const r = projects.addInstance(project, { id, type, dir, role, model, sessionId, compactAt });
    wireAgent(pool.get(r.key));
    return r;
  },

  /** Models a CLI type offers (cached per type). */
  'project.models': ({ type, refresh }) => projects.probeModels(type, { refresh: refresh === true }),

  /** Existing sessions of a CLI type in a project directory, to pick from when creating an instance. */
  'project.sessions': ({ project, type, dir }) => projects.probeSessions(project, type, dir),

  /** Edit an instance: role and preferred model. A running instance with a session switches model now. */
  'project.updateInstance': async ({ project, id, role, model, name, dir, compactAt }) => {
    const r = await projects.updateInstance(project, id, { role, model, name, dir, compactAt });
    const agent = pool.get(r.key);
    wireAgent(agent);
    if (model && agent.child && agent.sessionId && !agent.busy) {
      await agent.setConfigOption('model', model, agent.sessionId).catch(() => {});
    }
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

  /** Start the process now (manual retry after a failed start). */
  start: async ({ agent }) => {
    const a = getAgent(agent);
    await a.serialized(() => a.ensureReady());
    return a.status();
  },

  use: async ({ agent, sessionId, cwd }) => getAgent(agent).useSession(sessionId, cwd),

  new: async ({ agent, cwd }) => {
    const a = getAgent(agent);
    const sessionId = await a.newSession(cwd);
    return { agent: a.name, sessionId, cwd: a.cwd };
  },

  deleteSession: ({ agent, sessionId }) => getAgent(agent).deleteSession(sessionId),

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
    { agent, prompt, cwd, timeoutMs, reset, sessionId, model, async: isAsync, subscribe: wantSub, retryOf, caller },
    sock,
  ) => {
    const a = getAgent(agent);
    // Which task is this an attempt at? Refused here when the task has used up its attempts.
    const plan = planRun({ agent: a.name, prompt, retryOf, counted: caller === 'dispatcher' });
    const task = { taskId: plan.taskId, attempt: plan.attempt, retryOf: plan.retryOf, maxAttempts: plan.maxAttempts };
    if (model) await a.setConfigOption('model', model, sessionId);
    const started = a.startPrompt(prompt, { timeoutMs, cwd, reset, sessionId, meta: { taskId: task.taskId, attempt: task.attempt, retryOf: task.retryOf } });
    recordRun(plan, started.jobId);

    // Subscribe before the run can finish. A fast agent could otherwise complete
    // between the caller receiving the jobId and its separate subscribe call,
    // and the `done` event would be broadcast to nobody.
    if (wantSub && sock) subscribe(sock, started.jobId);

    task.queued = started.ahead > 0;
    task.ahead = started.ahead;
    journalStart({ jobId: started.jobId, agent: a.name, project: a.project, prompt, ...task });
    clearInterrupted(a.name);
    publish(
      allocEvent('job.started', {
        jobId: started.jobId,
        ...task,
        agent: a.name,
        sessionId: a.sessionId,
        prompt: typeof prompt === 'string' ? prompt.slice(0, 160) : null,
      }),
    );

    const finish = (result, error) => {
      journalEnd(started.jobId);
      endRun(started.jobId, error ? (error.metrics?.outcome ?? 'failed') : (result?.metrics?.outcome ?? 'done'));
      const ev = allocEvent('job.done', {
        jobId: started.jobId,
        ...task,
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
        task,
      );
      publish(ev);
      const failed = (!!error || !!result?.metrics?.error) && error?.metrics?.outcome !== 'cancelled';
      const streak = failed ? (failStreak.get(a.name) ?? 0) + 1 : 0;
      failStreak.set(a.name, streak);
      suggestHandoff(a, `连续 ${streak} 次任务失败`, `最近 ${streak} 次运行都失败了：${error?.message ?? result?.metrics?.error ?? ''}`, streak >= FAILURES_BEFORE_HANDOFF);
      return ev;
    };

    if (isAsync) {
      started.done.then((r) => finish(r)).catch((e) => finish(null, e));
      return { jobId: started.jobId, async: true, ...task };
    }

    try {
      const r = await started.done;
      const ev = finish(r);
      return { ...r, jobId: started.jobId, ...task, receipt: ev.receipt };
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

  /** With a `jobId`: that run only (waiting or running); without: whatever the executor is running now. */
  cancel: ({ agent, jobId }) => getAgent(agent).cancel(jobId),

  /** A person has looked at an executor marked unstable: let it take work again. */
  'agent.recover': ({ agent }) => {
    const r = getAgent(agent).recover();
    publish(allocEvent('agent.recovered', { agent }));
    return r;
  },

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
  addClient(sock);
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
    dropClient(sock);
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
  seedContexts(readReceipts(500)); // the newest figure of a session wins
  for (const j of lostJobs) publish(allocEvent('job.interrupted', { ...j }));
  if (lostJobs.length) log(`interrupted by the last shutdown: ${lostJobs.map((j) => `${j.agent}/${j.jobId}`).join(', ')}`);
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
