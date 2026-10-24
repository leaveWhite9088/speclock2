/**
 * Operations on the executors: the pool (listing, creating, removing), a single executor (sessions, models, start,
 * cancel, recover, tail) and what it has said (the transcript).
 */

import { AGENTS, createInstance, getAgent, listInstances, pool, readTranscript, removeInstance } from '../../core/agent-pool.mjs';
import * as projects from '../../core/projects.mjs';
import { wireAgent } from '../dispatchers.mjs';
import { allocEvent, publish } from '../events.mjs';
import { viewRows } from '../guard.mjs';
import { withInterrupted } from '../startup.mjs';

/** @param {{ protocol: number, startedAt: string, idleInstanceMs: number }} ctx */
export function executorOps(ctx) {
  return {
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
      instances: viewRows(withInterrupted(listInstances()), project, short),
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
  };
}
