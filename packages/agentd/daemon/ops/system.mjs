/**
 * Operations on the daemon itself: who it is, what happened (events, receipts), how healthy the agents are, and
 * who listens to a job.
 */

import { AGENTS, BASE_CWD, getAgent, pool } from '../../core/agent-pool.mjs';
import { dispatchers } from '../dispatchers.mjs';
import { EPOCH, RING_MAX, eventsSince, subscribe, unsubscribe } from '../events.mjs';
import { readReceipts } from '../receipts.mjs';

/** @param {{ protocol: number, startedAt: string, idleInstanceMs: number, shutdown: (code: number) => Promise<void> }} ctx */
export function systemOps(ctx) {
  return {
    hello: () => ({
      protocol: ctx.protocol,
      epoch: EPOCH,
      pid: process.pid,
      startedAt: ctx.startedAt,
      baseCwd: BASE_CWD,
      agents: [...pool.keys()],
      types: Object.keys(AGENTS),
    }),

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

    subscribe: ({ jobId }, sock) => {
      if (jobId) subscribe(sock, jobId);
      return { subscribed: jobId ?? null };
    },

    unsubscribe: ({ jobId }, sock) => {
      if (jobId) unsubscribe(sock, jobId);
      return { subscribed: null };
    },

    /**
     * End the daemon, cleanly: the same shutdown as when it is idle or gets a signal. Refused while anything is working
     * or waiting, so it never takes a person's task down. The next request starts a fresh daemon (new code, new state).
     */
    'daemon.shutdown': () => {
      const busy = [
        ...[...pool.values()].filter((a) => a.busy || a.inflight > 0).map((a) => a.name),
        ...[...dispatchers].filter(([, d]) => d.busy || d.queue.length).map(([key]) => `${key || 'global'} dispatcher`),
      ];
      if (busy.length) throw new Error(`not stopping: still working on ${busy.join(', ')}`);
      // After the answer has gone out.
      setTimeout(() => void ctx.shutdown(0), 200);
      return { stopping: true, pid: process.pid };
    },
  };
}
