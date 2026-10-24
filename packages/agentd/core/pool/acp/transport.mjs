/**
 * The wire to one ACP agent process: start it, read its lines, answer what it asks of us, send requests and wait for
 * their answers with a deadline. It knows nothing about sessions, runs or models: what the agent announces
 * (`session/update`) goes to `onNotification`, how the process ended goes to `onClose`.
 */

import { spawn } from 'node:child_process';
import { CANCEL_GRACE_MS, log } from '../config.mjs';
import { killTree } from '../process.mjs';

export class AcpTransport {
  /**
   * `onNotification(msg)`: a message from the agent that is neither an answer nor a request (session/update).
   * `onClose({ code, replaced })`: the process ended on its own, or was replaced by a newer one (`replaced`).
   */
  constructor({ name, onNotification, onClose }) {
    this.name = name;
    this.onNotification = onNotification;
    this.onClose = onClose;
    this.child = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    /** Children we stopped on purpose, so their `close` is not reported as a crash. */
    this.killed = new WeakSet();
    this.stderrTail = [];
    this.lastError = null;
  }

  spawn({ cmd, args, env }) {
    if (this.child) return;
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    this.child = child;
    this.buf = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (this.child !== child) return; // output of a process we already dropped
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this._onLine(line);
      }
    });

    child.stderr.setEncoding('utf8');
    this.stderrTail = [];
    child.stderr.on('data', (d) => {
      for (const line of d.split('\n')) {
        const plain = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (plain) this.stderrTail = [...this.stderrTail, plain.slice(0, 160)].slice(-4);
        if (/ERROR|error:/.test(line)) {
          const clean = line.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 200);
          this.lastError = clean;
          log(`[${this.name}] stderr:`, clean);
        }
      }
    });

    child.on('error', (err) => {
      this.lastError = err.message;
      log(`[${this.name}] child error:`, err.message);
    });

    child.on('close', (code) => {
      log(`[${this.name}] child closed (code=${code})`);
      if (this.killed.has(child)) return; // already cleaned up by `abandon`
      // A replacement process may already be running (stopped, then used again at once).
      if (this.child && this.child !== child) return this.onClose({ code, replaced: true });
      this.child = null;
      for (const { reject } of this.pending.values()) reject(new Error(`${this.name} ACP exited`));
      this.pending.clear();
      this.onClose({ code, replaced: false });
    });
  }

  write(obj) {
    try {
      this.child?.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      log(`[${this.name}] write failed:`, err.message);
    }
  }

  _onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return log(`[${this.name}] non-json:`, line.slice(0, 120));
    }

    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        // The CLI itself answered with an error: that is its message, and it is passed on as it came.
        const err = new Error(msg.error.message ?? JSON.stringify(msg.error));
        err.source = 'cli';
        err.code = msg.error.code;
        reject(err);
      } else resolve(msg.result);
      return;
    }

    if (msg.id != null && msg.method) {
      if (msg.method === 'session/request_permission') {
        const opts = msg.params?.options ?? [];
        const picked = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? '')) ?? opts[0];
        this.write({
          jsonrpc: '2.0',
          id: msg.id,
          // The ACP shape; some adapters (claude) treat anything else as a refusal.
          result: { outcome: picked ? { outcome: 'selected', optionId: picked.optionId } : { outcome: 'cancelled' } },
        });
      } else {
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `unsupported: ${msg.method}` } });
      }
      return;
    }

    if (msg.method) this.onNotification(msg);
  }

  /**
   * Send a request and wait for its answer.
   *
   * With `idleMs` there is no fixed deadline: it fails when the agent has said nothing for `idleMs` (waiting on a running
   * tool is not silence; `quiet` tells), and `timeoutMs` is the hard ceiling for the whole request. Without it,
   * `timeoutMs` is the deadline. A prompt that expires is told to cancel first; if the agent still does not answer
   * within the grace period, `forceStop(reason)` is asked to end its process (it returns whether it did).
   */
  request(method, params, { timeoutMs = 300_000, idleMs = null, quiet = null, forceStop = () => false } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer);
        clearInterval(watch);
      };
      let timer = null;
      let watch = null;
      let expired = null;
      const fail = (message) => {
        // The agent is told to stop first. Dropping the wait alone would leave it working,
        // and the next prompt to the same session would then be refused as "already in flight".
        expired = new Error(message);
        expired.kind = 'timeout';
        clear();
        if (method === 'session/prompt' && params?.sessionId) {
          this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: params.sessionId } });
        }
        timer = setTimeout(
          () => {
            this.pending.delete(id);
            // Still no answer after the grace period: the agent is stuck and would refuse every later prompt as
            // "already in flight". Stop the process; the next task starts a fresh one in the same session.
            if (method === 'session/prompt' && forceStop(`no answer ${CANCEL_GRACE_MS / 1000}s after the cancel`)) {
              expired.forced = true;
              expired.message += `; it did not answer the cancel, so its process was stopped (a new one starts with the next task). Check what it was working on before sending the task again`;
            }
            reject(expired);
          },
          method === 'session/prompt' ? CANCEL_GRACE_MS : 0,
        );
      };
      if (idleMs) {
        quiet?.begin();
        const started = Date.now();
        watch = setInterval(() => {
          if (Date.now() - started > timeoutMs) fail(`ACP ${method} timed out: still running after ${Math.round(timeoutMs / 60000)} min, cancelled`);
          else if (quiet && !quiet.quiet().waitingOnTool && quiet.quiet().forMs > idleMs) {
            fail(`ACP ${method} timed out: no activity for ${Math.round(idleMs / 1000)}s, cancelled`);
          }
        }, Math.max(100, Math.min(5_000, idleMs / 4)));
      } else {
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.pending.set(id, {
        resolve: (v) => {
          clear();
          if (expired) reject(expired);
          else resolve(v);
        },
        reject: (e) => {
          clear();
          reject(expired ?? e);
        },
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * Drop the process for good: it is not reported as a crash, every request still waiting fails with `makeError()`, and
   * the process tree is killed. False when there was no process.
   */
  abandon(makeError) {
    const child = this.child;
    if (!child) return false;
    this.killed.add(child);
    this.child = null;
    for (const { reject } of this.pending.values()) reject(makeError());
    this.pending.clear();
    killTree(child);
    return true;
  }

  /** End the process politely (stdin closed), then make sure. Its `close` is reported to `onClose`. */
  stop() {
    if (!this.child) return;
    try {
      this.child.stdin.end();
      killTree(this.child);
    } catch {
      /* ignore */
    }
    this.child = null;
  }
}
