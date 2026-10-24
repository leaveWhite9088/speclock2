/**
 * agentd client.
 *
 * Connects to the scheduler daemon and starts it on first use. Deliberately
 * dependency-free so the pi extension, the daemon and test scripts can all
 * share it.
 *
 *   const c = await connect();          // auto-spawns agentd if needed
 *   await c.call('run', { agent:'dsh', prompt:'hi' });
 *   const off = c.on('progress', (ev) => ...);
 */

import net from 'node:net';
import { spawn } from 'node:child_process';
import { openSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../core/data-dir.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE_BIN = process.env.MCODE_NODE_BIN || 'D:/Environment/nodejs/node.exe';
const DAEMON = join(ROOT, 'daemon', 'agentd.mjs');
const LOG = join(DATA_DIR, 'agentd.log');
const PIPE_NAME = process.env.AGENTD_PIPE || '\\\\.\\pipe\\pi-agentd';
const PORT = process.env.AGENTD_PORT ? Number(process.env.AGENTD_PORT) : null;
const ENDPOINT_FILE = join(DATA_DIR, 'agentd.endpoint.json');
const PROTOCOL = 3;

/**
 * Find the daemon the same way for every client.
 *
 * The endpoint file wins, so a daemon started from PowerShell is found by a
 * client launched from WSL (and vice versa). Env vars are only a fallback for
 * the very first start, which is what keeps a single daemon instead of one per
 * shell configuration.
 */
function resolveEndpoint() {
  try {
    if (existsSync(ENDPOINT_FILE)) {
      const ep = JSON.parse(readFileSync(ENDPOINT_FILE, 'utf8'));
      if (ep?.transport === 'tcp' && ep.port) return { port: ep.port };
      if (ep?.transport === 'pipe' && ep.path) return { path: ep.path };
    }
  } catch {
    /* stale or unreadable: fall through */
  }
  if (PORT) return { port: PORT };
  return { path: PIPE_NAME };
}

const log = (...a) => process.stderr.write(`[agentd-client] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class AgentdClient {
  constructor(socket) {
    this.socket = socket;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    /** Bounded per-type history, so a fast event cannot be missed. */
    this.recent = new Map();
    /** Last durable event id seen, for resuming after a reconnect. */
    this.lastEventId = null;
    this.epoch = null;
    this.closed = false;

    // Do not keep the host process alive just because the socket is open.
    // In-flight calls are held open by their own timeout timers.
    socket.unref?.();
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this._onLine(line);
      }
    });
    socket.on('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('agentd connection closed'));
      this.pending.clear();
    });
    socket.on('error', (err) => {
      if (!this.closed) log('socket error:', err.message);
    });
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event) {
      if (msg.id) this.lastEventId = msg.id;
      const ring = this.recent.get(msg.event) ?? [];
      ring.push(msg);
      while (ring.length > 100) ring.shift();
      this.recent.set(msg.event, ring);
      for (const fn of this.listeners.get(msg.event) ?? []) fn(msg);
      return;
    }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.ok) resolve(msg.result);
      else reject(new Error(msg.error ?? 'agentd error'));
    }
  }

  call(op, args = {}, { timeoutMs = 900_000 } = {}) {
    if (this.closed) return Promise.reject(new Error('agentd connection closed'));
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`agentd ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.socket.write(JSON.stringify({ id, op, args }) + '\n');
    });
  }

  /**
   * Durable events after `afterId` (defaults to the last one seen).
   * Returns `{ reset, epoch, events }`; `reset: true` means the daemon restarted
   * and the caller must reload history from receipts instead.
   */
  eventsSince(afterId = this.lastEventId, limit = 500) {
    return this.call('events.since', { afterId, limit });
  }

  /**
   * Resolve with the first matching event, including one that already arrived.
   *
   * A run can finish between the `run` response and the caller installing a
   * listener; the recent-event buffer closes that window.
   */
  waitFor(event, predicate, timeoutMs = 300_000) {
    const already = (this.recent.get(event) ?? []).find(predicate);
    if (already) return Promise.resolve(already);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${event}`));
      }, timeoutMs);
      const off = this.on(event, (ev) => {
        if (!predicate(ev)) return;
        clearTimeout(timer);
        off();
        resolve(ev);
      });
    });
  }

  on(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(fn);
    this._refreshRef();
    return () => {
      this.listeners.get(event)?.delete(fn);
      this._refreshRef();
    };
  }

  /**
   * Keep the host process alive only while something is actually waiting.
   * An idle client must not stop pi from exiting; a pending event listener must.
   */
  _refreshRef() {
    let waiting = this.pending.size;
    for (const set of this.listeners.values()) waiting += set.size;
    if (waiting > 0) this.socket.ref?.();
    else this.socket.unref?.();
  }

  close() {
    this.listeners.clear();
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    this.closed = true;
  }
}

function tryConnect(timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.createConnection(resolveEndpoint());
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.removeAllListeners('error');
      resolve(v);
    };
    const timer = setTimeout(() => {
      sock.destroy();
      done(null);
    }, timeoutMs);
    sock.once('connect', () => done(sock));
    sock.once('error', () => {
      sock.destroy();
      done(null);
    });
  });
}

function spawnDaemon() {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
  } catch {
    /* ignore */
  }
  let out = 'ignore';
  try {
    out = openSync(LOG, 'a');
  } catch {
    /* fall back to silence */
  }
  log('starting agentd in the background');
  const child = spawn(NODE_BIN, [DAEMON], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  return child;
}

/**
 * Connect to the daemon, spawning it if it is not running.
 * `spawnOnDemand: false` makes this a pure probe.
 */
export async function connect({ spawnOnDemand = true, attempts = 40, delayMs = 150 } = {}) {
  let sock = await tryConnect();
  if (!sock && spawnOnDemand) {
    spawnDaemon();
    for (let i = 0; i < attempts && !sock; i++) {
      await sleep(delayMs);
      sock = await tryConnect();
    }
  }
  if (!sock) throw new Error('could not connect to agentd');

  const client = new AgentdClient(sock);
  const hello = await client.call('hello');
  client.epoch = hello.epoch ?? null;
  if (hello.protocol !== PROTOCOL) {
    client.close();
    throw new Error(
      `agentd protocol mismatch: daemon=${hello.protocol} client=${PROTOCOL}. ` +
        'Stop the daemon (or let it idle out) and retry.',
    );
  }
  return client;
}

export async function isRunning() {
  const sock = await tryConnect(300);
  if (!sock) return null;
  sock.destroy();
  return true;
}

export { PIPE_NAME, PORT, ENDPOINT_FILE };
