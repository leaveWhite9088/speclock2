/**
 * Holds the connection to agentd.
 *
 * agentd exits after being idle and may be restarted, so the connection is opened
 * on demand and replaced when it closes. The backend subscribes to '*' once per
 * connection and fans the live events out to its own listeners (the SSE clients).
 */

import { connect } from '@speclock/agentd/client/agentd-client.mjs';

const LIVE_EVENTS = ['progress', 'job.done', 'job.started', 'agent.exit', 'dispatcher.event', 'handoff.changed', 'agent.compacted'];

let client = null;
let opening = null;
const listeners = new Set();

/** Receive every live event as `(name, payload)`. Returns an unsubscribe function. */
export function onLive(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function open() {
  const c = await connect();
  for (const name of LIVE_EVENTS) {
    c.on(name, (ev) => {
      for (const fn of listeners) fn(name, ev);
    });
  }
  await c.call('subscribe', { jobId: '*' });
  client = c;
  return c;
}

export async function daemon() {
  if (client && !client.closed) return client;
  opening ??= open().finally(() => {
    opening = null;
  });
  return opening;
}

export async function call(op, args = {}, opts) {
  const c = await daemon();
  return c.call(op, args, opts);
}

export function close() {
  client?.close();
  client = null;
}
