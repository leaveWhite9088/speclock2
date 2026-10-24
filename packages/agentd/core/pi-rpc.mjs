/**
 * Talking to pi in RPC mode: the one place that knows how.
 *
 * pi runs as `pi --mode rpc`: JSON lines on stdin and stdout. We send `{ id, type, ...params }`, pi answers with
 * `{ type: 'response', id, success, data | error }` and pushes events (`agent_start`, `message_update`,
 * `tool_execution_*`, `agent_settled`, ...) in between.
 *
 * Two things use it: the project dispatcher (core/dispatcher.mjs) and the adapter that makes a pi look like an ACP
 * agent (server/pi-acp-adapter.mjs, a separate process). Both used to carry their own copy of this, and the copies
 * drifted: one read the context figure wrongly, one did not implement cancel, only one could compact. Everything
 * that is the same for both lives here; what differs (session files, queues, ACP) stays with them.
 *
 * Node built-ins only, because the adapter loads this too.
 */

import { spawn } from 'node:child_process';

const defaultLog = (...a) => process.stderr.write(`[pi-rpc] ${a.join(' ')}\n`);

export class PiRpc {
  /**
   * @param {{ label?: string, log?: (...a: any[]) => void }} [opts]
   *   label: how errors name pi ("dispatcher", "pi"), e.g. `dispatcher get_state failed: ...`
   */
  constructor({ label = 'pi', log = defaultLog } = {}) {
    this.label = label;
    this.log = log;
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.settledWaiters = [];
    /** A turn is running: from `agent_start` to `agent_settled` (and while pi is gone: false). */
    this.streaming = false;
    this.stderrTail = '';
    this.lastError = null;
    /** Called when the process ends, after its pending requests were failed. */
    this.onClose = null;
  }

  get running() {
    return Boolean(this.child);
  }

  // -- process --------------------------------------------------------------

  /** Start `cmd args...`. The caller decides every flag: pi is started differently for a dispatcher and an executor. */
  start({ cmd, args, cwd, env }) {
    if (this.child) throw new Error(`${this.label} is already running`);
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    this.buf = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this._onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    child.on('error', (err) => {
      this.lastError = err.message;
    });
    child.on('close', (code) => {
      this.log(`pi exited (code=${code})`);
      if (this.child === child) this.child = null;
      this.streaming = false;
      for (const { reject } of this.pending.values()) reject(new Error(`${this.label} pi rpc exited`));
      this.pending.clear();
      for (const w of this.settledWaiters.splice(0)) w(false);
      this.onClose?.(code);
    });
    return child;
  }

  /** End the process: close its input, then kill it. */
  stop() {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.end();
      child.kill();
    } catch {
      /* already gone */
    }
  }

  // -- messages -------------------------------------------------------------

  /**
   * Every record that is not the answer to a command goes to these, as the parsed object. A listener runs for the
   * life of the process; call the function this returns to remove it.
   */
  addListener(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _onLine(line) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    this.handle(rec);
  }

  /** One parsed record from pi (also the entry point for a test that plays pi). */
  handle(rec) {
    if (rec.type === 'response' && rec.id != null && this.pending.has(rec.id)) {
      const { resolve } = this.pending.get(rec.id);
      this.pending.delete(rec.id);
      resolve(rec);
      return;
    }
    if (rec.type === 'agent_start') this.streaming = true;
    if (rec.type === 'agent_settled') {
      this.streaming = false;
      for (const w of this.settledWaiters.splice(0)) w(true);
    }
    for (const fn of this.listeners) {
      try {
        fn(rec);
      } catch (err) {
        this.log(`a listener failed: ${err.message}`);
      }
    }
  }

  write(obj) {
    try {
      this.child?.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      this.log('write failed:', err.message);
    }
  }

  /** Send a command; resolves with the `data` of pi's answer, rejects when it fails, times out or pi exits. */
  command(type, params = {}, timeoutMs = 60_000) {
    if (!this.child) return Promise.reject(new Error(`${this.label} is not running`));
    const id = `rpc-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label} ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (rec) => {
          clearTimeout(timer);
          if (!rec.success) reject(new Error(`${this.label} ${type} failed: ${rec.error ?? 'unknown error'}`));
          else resolve(rec.data);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.write({ id, type, ...params });
    });
  }

  /** Resolves at the next `agent_settled`. Rejects after `timeoutMs`, or when pi exits first. */
  waitSettled(timeoutMs = 600_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.settledWaiters.indexOf(done);
        if (i >= 0) this.settledWaiters.splice(i, 1);
        reject(new Error(`${this.label} run did not settle within ${timeoutMs}ms`));
      }, timeoutMs);
      const done = (settled) => {
        clearTimeout(timer);
        if (settled === false) reject(new Error(`${this.label} pi rpc exited before the run settled`));
        else resolve();
      };
      this.settledWaiters.push(done);
    });
  }

  // -- what pi can do, by name ---------------------------------------------------

  state() {
    return this.command('get_state', {}, 60_000);
  }

  /** pi's own statistics: `{ contextUsage, tokens, cost, ... }`. */
  stats(timeoutMs = 30_000) {
    return this.command('get_session_stats', {}, timeoutMs);
  }

  /** How full the conversation is: `{ used, size, percent }`, or null when pi does not say. */
  async context() {
    return PiRpc.contextOf(await this.stats());
  }

  static contextOf(stats) {
    const c = stats?.contextUsage;
    return c && c.percent != null ? { used: c.tokens ?? null, size: c.contextWindow ?? null, percent: +c.percent.toFixed(1) } : null;
  }

  /** Ask pi to compact the conversation (summarise the older part). */
  compact(timeoutMs = 600_000) {
    return this.command('compact', {}, timeoutMs);
  }

  /** Stop the turn that is running, and its running tool. */
  abort(timeoutMs = 30_000) {
    return this.command('abort', {}, timeoutMs);
  }

  newSession() {
    return this.command('new_session', {}, 60_000);
  }

  switchSession(sessionPath) {
    return this.command('switch_session', { sessionPath }, 60_000);
  }

  setModel(provider, modelId) {
    return this.command('set_model', { provider, modelId }, 60_000);
  }

  setThinking(level) {
    return this.command('set_thinking_level', { level }, 60_000);
  }

  models() {
    return this.command('get_available_models', {}, 60_000);
  }

  thinkingLevels() {
    return this.command('get_available_thinking_levels', {}, 30_000);
  }

  messages() {
    return this.command('get_messages', {}, 60_000);
  }
}
