/** Event stream: identity, ring buffer and delivery to connected sockets. */

import { randomUUID } from 'node:crypto';

// Every durable event gets `<epoch>-<seq>`:
//   epoch  changes when the daemon restarts, so a stale Last-Event-ID is detected
//   seq    is monotonic within one daemon lifetime
//
// Semantic events (job.started / job.done / agent.exit) are kept in a bounded
// ring so a consumer can resume with `events.since`. High-frequency `progress`
// events are delivered live but never ringed and never get an id: replaying a
// cumulative char count would be meaningless.

export const EPOCH = randomUUID().slice(0, 8);
export const RING_MAX = 2000;
const ring = [];
let seq = 0;

/** @type {Map<string, Set<import('node:net').Socket>>} */
const subscribers = new Map();
/** Sockets that asked for every event (the web bridge will do this). */
export const allSubscribers = new Set();
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
export function allocEvent(type, payload = {}) {
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
export function publish(ev) {
  ring.push(ev);
  while (ring.length > RING_MAX) ring.shift();
  deliver(ev);
  return ev;
}

/** Deliver a live-only event (progress). Never ringed, no id. */
export function publishEphemeral(jobId, payload) {
  const ev = { event: 'progress', jobId, ts: new Date().toISOString(), ...payload };
  if (subscribers.has(jobId)) writeAll(subscribers.get(jobId), ev);
  if (allSubscribers.size) writeAll(allSubscribers, ev);
}

/**
 * Deliver a live-only event to the connections that asked for everything
 * (subscribe to '*'). Used for the dispatcher stream.
 */
export function publishLive(event, payload) {
  if (!allSubscribers.size) return;
  writeAll(allSubscribers, { event, ts: new Date().toISOString(), ...payload });
}

export function subscribe(sock, jobId) {
  if (jobId === '*') {
    allSubscribers.add(sock);
    return;
  }
  if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
  subscribers.get(jobId).add(sock);
}

export function unsubscribe(sock, jobId) {
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
export function eventsSince(afterId, limit = 500) {
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

/** A socket connected. */
export const addClient = (sock) => clients.add(sock);

/** A socket went away: forget it everywhere. */
export function dropClient(sock) {
  clients.delete(sock);
  allSubscribers.delete(sock);
  for (const [jobId, set] of subscribers) {
    set.delete(sock);
    if (set.size === 0) subscribers.delete(jobId);
  }
}
