/**
 * Operations on the daemon itself: who it is, what happened (events, receipts), how healthy the agents are, and
 * who listens to a job.
 */

import { AGENTS, BASE_CWD, getAgent, pool } from '../../core/agent-pool.mjs';
import { EPOCH, RING_MAX, eventsSince, subscribe, unsubscribe } from '../events.mjs';
import { readReceipts } from '../receipts.mjs';

/** @param {{ protocol: number, startedAt: string, idleInstanceMs: number }} ctx */
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
  };
}
