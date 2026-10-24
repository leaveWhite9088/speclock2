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

import { join } from 'node:path';
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
import { DATA_DIR } from '../core/data-dir.mjs';
import { savedContext } from '../core/dispatcher.mjs';
import { listTemplates, removeTemplate, saveTemplate } from '../core/templates.mjs';
import * as projects from '../core/projects.mjs';
import { DISPATCHER_ID, anyDispatcherBusy, dispatchers, getDispatcher, handoffs, noteRunOutcome, restartRunningDispatchers, wireAgent } from './dispatchers.mjs';
import { EPOCH, RING_MAX, allocEvent, eventsSince, publish, subscribe, unsubscribe } from './events.mjs';
import { scopeArgs, viewRows } from './guard.mjs';
import { startLifecycle } from './lifecycle.mjs';
import { appendReceipt, readReceipts } from './receipts.mjs';
import { startServer } from './server.mjs';
import { recordInterruptedJobs } from './startup.mjs';
import { clearInterrupted, journalEnd, journalStart } from '../core/journal.mjs';
import { endRun, planRun, recordRun } from '../core/tasks.mjs';
import { addProvider, removeProvider, listProviders, agentDir } from '../core/pi-models.mjs';

const PIPE_NAME = process.env.AGENTD_PIPE || '\\\\.\\pipe\\pi-agentd';
const PORT = process.env.AGENTD_PORT ? Number(process.env.AGENTD_PORT) : null;
const ENDPOINT_FILE = join(DATA_DIR, 'agentd.endpoint.json');
const IDLE_MS = Number(process.env.AGENTD_IDLE_MIN || 30) * 60_000;
const PROTOCOL = 3;
/** Project instances and dispatchers idle for this long are stopped. */
const IDLE_INSTANCE_MS = Number(process.env.AGENTD_INSTANCE_IDLE_MIN || CONFIG?.limits?.idleMinutes || 15) * 60_000;

const log = (...a) => process.stderr.write(`[agentd] ${a.join(' ')}\n`);
const startedAt = new Date().toISOString();

// Tasks the last daemon never finished: record them now, announce them once the socket is up.
const lostJobs = recordInterruptedJobs();

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
      dispatcher: { alive: Boolean(dispatchers.get(p.id)?.child), busy: Boolean(dispatchers.get(p.id)?.busy), compactAt: projects.dispatcherCompactAt(p.id), compactions: dispatchers.get(p.id)?.compactions() ?? 0, queued: (dispatchers.get(p.id)?.queue ?? []).map((m) => m.slice(0, 300)), context: (dispatchers.get(p.id)?.child ? dispatchers.get(p.id)?.context : null) ?? savedContext(join(DATA_DIR, 'dispatcher-sessions', p.id)) },
    })),
    limits: { maxProcesses: MAX_PROCESSES, alive: aliveCount(), global: aliveCount((a) => !a.project), idleMinutes: IDLE_INSTANCE_MS / 60_000 },
  }),

  /** The size at which the project's dispatcher compacts its conversation (null: never). */
  'project.updateDispatcher': ({ project, compactAt }) => {
    const value = projects.setDispatcherCompactAt(project, compactAt);
    const d = dispatchers.get(project);
    if (d) d.compactAt = value;
    return { project, compactAt: value };
  },

  'project.create': (args) => {
    const p = projects.createProject(args);
    for (const a of projects.instancesOf(p.id)) wireAgent(a);
    return p;
  },

  'project.addInstance': ({ project, id, type, dir, role, model, sessionId, compactAt, template }) => {
    const r = projects.addInstance(project, { id, type, dir, role, model, sessionId, compactAt, template });
    wireAgent(pool.get(r.key));
    return r;
  },

  /** Models a CLI type offers (cached per type). */
  'project.models': ({ type, refresh }) => projects.probeModels(type, { refresh: refresh === true }),

  /** Existing sessions of a CLI type in a project directory, to pick from when creating an instance. */
  'project.sessions': ({ project, type, dir }) => projects.probeSessions(project, type, dir),

  /** Edit an instance: role and preferred model. A running instance with a session switches model now. */
  'project.updateInstance': async ({ project, id, role, model, name, dir, compactAt, template }) => {
    const r = await projects.updateInstance(project, id, { role, model, name, dir, compactAt, template });
    const agent = pool.get(r.key);
    wireAgent(agent);
    if (model && agent.child && agent.sessionId && !agent.busy) {
      await agent.setConfigOption('model', model, agent.sessionId).catch(() => {});
    }
    return r;
  },

  // -- executor templates (markdown files in contexts/templates) --

  'template.list': () => ({ templates: listTemplates().map((t) => ({ ...t, usedBy: projects.templateUsers(t.id) })) }),

  'template.save': (args) => {
    const t = saveTemplate(args);
    return { ...t, usedBy: projects.templateUsers(t.id) };
  },

  'template.remove': ({ id }) => {
    const users = projects.templateUsers(id);
    return { ...removeTemplate(id), usedBy: users };
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
      noteRunOutcome(a, failed, error?.message ?? result?.metrics?.error ?? '');
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
// Server and lifecycle
// ---------------------------------------------------------------------------

const endpointFile = ENDPOINT_FILE;
const { stats } = startServer({
  ops: OPS,
  scopeArgs,
  pipe: PIPE_NAME,
  port: PORT,
  endpointFile,
  info: { protocol: PROTOCOL, startedAt, baseCwd: BASE_CWD },
  onListening: (endpoint) => {
    seedContexts(readReceipts(500)); // the newest figure of a session wins
    for (const j of lostJobs) publish(allocEvent('job.interrupted', { ...j }));
    if (lostJobs.length) log(`interrupted by the last shutdown: ${lostJobs.map((j) => `${j.agent}/${j.jobId}`).join(', ')}`);
    log(`listening on ${endpoint} (pid ${process.pid})`);
    log(`base cwd: ${BASE_CWD}; instances: ${[...pool.keys()].join(', ')}`);
  },
  log,
});

startLifecycle({ endpointFile, pool, dispatchers, sweepIdle: projects.sweepIdle, stats, idleMs: IDLE_MS, idleInstanceMs: IDLE_INSTANCE_MS, log });
