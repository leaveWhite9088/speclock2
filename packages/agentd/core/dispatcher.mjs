/**
 * Dispatcher: the pi that decides which agent does the work.
 *
 * The dispatcher is a resident `pi --mode rpc` process with the agent-router
 * extension loaded. Its LLM reads the user's request and calls the extension's
 * tools (`agent_run` and the others), and the tools talk back to agentd.
 * This is different from the `pi` agent in the pool: that one runs with
 * `--no-extensions` and is only a worker.
 *
 * agentd owns the process, so a dashboard can drive the dispatcher without a TUI:
 * send a prompt, watch the events, change its model, add a new LLM.
 *
 * pi keeps the conversation history on disk. agentd does not copy it; the
 * `messages` method reads it from pi.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { usableProviders } from './pi-models.mjs';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const NODE_BIN = process.env.PI_NODE_BIN || process.env.MCODE_NODE_BIN || 'D:/Environment/nodejs/node.exe';
const PI_CLI =
  process.env.PI_CLI ||
  'D:/Environment/nodejs/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';
const EXTENSION = process.env.DISPATCHER_EXTENSION || join(ROOT, 'extension', 'agent-router.ts');
const SESSION_DIR = process.env.DISPATCHER_SESSION_DIR || join(ROOT, 'data', 'dispatcher-sessions');

const log = (...a) => process.stderr.write(`[dispatcher] ${a.join(' ')}\n`);

/** Dialog methods wait for a reply. Nobody is at a TUI, so we cancel them. */
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

/** Largest event we forward whole. Bigger ones are cut to a marker. */
const MAX_EVENT_BYTES = 20_000;

export class Dispatcher {
  /**
   * @param {{ cwd: string, project?: string|null, sessionDir?: string, onEvent?: (ev: object) => void }} opts
   *
   * With `project` set, the extension runs scoped: every tool call it makes carries
   * that project, and agentd refuses anything outside it.
   */
  constructor({ cwd, project = null, sessionDir = SESSION_DIR, onEvent }) {
    this.cwd = cwd;
    this.project = project;
    this.sessionDir = sessionDir;
    this.lastActive = Date.now();
    this.onEvent = onEvent ?? (() => {});
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.spawnCount = 0;
    this.streaming = false;
    this.lastError = null;
    this.stderrTail = '';
    /** Session file to return to after a restart. */
    this.resumeFile = null;
  }

  get busy() {
    return this.streaming;
  }

  // -- process ------------------------------------------------------------

  async ensureStarted() {
    if (this.child) return;
    mkdirSync(this.cwd, { recursive: true });
    mkdirSync(this.sessionDir, { recursive: true });

    // --no-extensions plus -e: load exactly one extension, whatever the user
    // installed globally. --no-mcp avoids loading a project's MCP servers.
    const args = [
      PI_CLI,
      '--mode',
      'rpc',
      '--no-extensions',
      '-e',
      EXTENSION,
      '--no-mcp',
      '--session-dir',
      this.sessionDir,
    ];
    this.spawnCount += 1;
    log(`spawning pi rpc (spawn #${this.spawnCount}, cwd=${this.cwd})`);

    const env = { ...process.env };
    if (this.project) env.AGENTD_PROJECT = this.project;
    else delete env.AGENTD_PROJECT;
    const child = spawn(NODE_BIN, args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.buf = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let i;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this._onRecord(line);
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
      log(`pi exited (code=${code})`);
      const wasStreaming = this.streaming;
      this.child = null;
      this.streaming = false;
      for (const { reject } of this.pending.values()) reject(new Error('dispatcher pi exited'));
      this.pending.clear();
      this.onEvent({ type: 'dispatcher_exit', code, wasStreaming, spawns: this.spawnCount });
    });

    if (this.resumeFile && existsSync(this.resumeFile)) {
      try {
        await this.command('switch_session', { sessionPath: this.resumeFile }, 60_000);
      } catch (err) {
        log(`could not return to the previous session: ${err.message}`);
      }
    }
  }

  _onRecord(line) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }

    if (rec.type === 'response' && rec.id != null && this.pending.has(rec.id)) {
      const { resolve } = this.pending.get(rec.id);
      this.pending.delete(rec.id);
      resolve(rec);
      return;
    }

    if (rec.type === 'extension_ui_request') {
      if (DIALOG_METHODS.has(rec.method)) {
        this._write({ type: 'extension_ui_response', id: rec.id, cancelled: true });
      }
      return;
    }

    if (rec.type === 'agent_start') this.streaming = true;
    if (rec.type === 'agent_settled') this.streaming = false;

    this.onEvent(compact(rec));
  }

  _write(obj) {
    try {
      this.child?.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      log('write failed:', err.message);
    }
  }

  async command(type, params = {}, timeoutMs = 60_000) {
    if (!this.child) throw new Error('dispatcher is not running');
    this.lastActive = Date.now();
    const id = `d-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dispatcher ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (rec) => {
          clearTimeout(timer);
          if (!rec.success) reject(new Error(`dispatcher ${type} failed: ${rec.error ?? 'unknown error'}`));
          else resolve(rec.data);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this._write({ id, type, ...params });
    });
  }

  // -- state --------------------------------------------------------------

  async state() {
    if (!this.child) {
      return { alive: false, cwd: this.cwd, spawns: this.spawnCount, lastError: this.lastError };
    }
    const st = await this.command('get_state');
    if (st?.sessionFile) this.resumeFile = st.sessionFile;
    return {
      alive: true,
      cwd: this.cwd,
      spawns: this.spawnCount,
      pid: this.child?.pid ?? null,
      model: st?.model ? modelRef(st.model) : null,
      thinkingLevel: st?.thinkingLevel ?? null,
      isStreaming: Boolean(st?.isStreaming),
      sessionFile: st?.sessionFile ?? null,
      sessionId: st?.sessionId ?? null,
      sessionName: st?.sessionName ?? null,
      messageCount: st?.messageCount ?? 0,
      lastError: this.lastError,
    };
  }

  // -- models -------------------------------------------------------------

  /** Models the dispatcher can use now, with the current choice. */
  async models() {
    await this.ensureStarted();
    const [list, st] = await Promise.all([this.command('get_available_models'), this.command('get_state')]);
    let levels = null;
    try {
      levels = (await this.command('get_available_thinking_levels'))?.levels ?? null;
    } catch {
      /* optional */
    }
    const cur = st?.model ? `${st.model.provider}/${st.model.id}` : null;
    // pi lists every model it knows. Only the ones with credentials can answer.
    const usable = usableProviders();
    const all = list?.models ?? [];
    const shown = all.filter((m) => usable.has(m.provider) || `${m.provider}/${m.id}` === cur);
    return {
      current: cur,
      thinkingLevel: st?.thinkingLevel ?? null,
      thinkingLevels: levels,
      hiddenWithoutCredentials: all.length - shown.length,
      usableProviders: [...usable],
      models: shown.map((m) => ({
        value: `${m.provider}/${m.id}`,
        provider: m.provider,
        id: m.id,
        name: m.name ?? m.id,
        reasoning: Boolean(m.reasoning),
        contextWindow: m.contextWindow ?? null,
      })),
    };
  }

  async setModel(value) {
    await this.ensureStarted();
    const slash = String(value ?? '').indexOf('/');
    if (slash < 1) throw new Error(`model must be "provider/modelId", got "${value}"`);
    const provider = value.slice(0, slash);
    const modelId = value.slice(slash + 1);
    await this.command('set_model', { provider, modelId });
    return this.state();
  }

  async setThinking(level) {
    await this.ensureStarted();
    await this.command('set_thinking_level', { level });
    return this.state();
  }

  // -- conversation -------------------------------------------------------

  /** Start a turn. Returns at once; progress arrives through onEvent. */
  async prompt(message) {
    await this.ensureStarted();
    if (this.streaming) throw new Error('dispatcher is already working on a prompt');
    if (typeof message !== 'string' || !message.trim()) throw new Error('message is required');
    const r = await this.command('prompt', { message }, 120_000);
    return { disposition: r?.disposition ?? null };
  }

  async abort() {
    if (!this.child) return { aborted: false, reason: 'not running' };
    await this.command('abort');
    return { aborted: true };
  }

  async newSession() {
    await this.ensureStarted();
    await this.command('new_session', {}, 60_000);
    return this.state();
  }

  async switchSession(sessionFile) {
    await this.ensureStarted();
    if (!isInside(this.sessionDir, sessionFile)) throw new Error('session file is outside the dispatcher session directory');
    await this.command('switch_session', { sessionPath: sessionFile }, 60_000);
    return this.state();
  }

  /** Full history, as pi stores it. */
  async messages() {
    await this.ensureStarted();
    const data = await this.command('get_messages', {}, 60_000);
    return { messages: data?.messages ?? [] };
  }

  /** Session files of the dispatcher, newest first. */
  sessions() {
    const rows = [];
    const walk = (dir) => {
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl')) {
          let header = null;
          try {
            header = JSON.parse(readFileSync(p, 'utf8').split('\n', 1)[0]);
          } catch {
            /* a file without a readable header is still listed */
          }
          rows.push({
            file: p,
            sessionId: header?.id ?? null,
            cwd: header?.cwd ?? null,
            updatedAt: statSync(p).mtime.toISOString(),
            size: statSync(p).size,
            active: Boolean(this.resumeFile) && resolve(p) === resolve(this.resumeFile),
          });
        }
      }
    };
    walk(this.sessionDir);
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions: rows };
  }

  /**
   * Restart the process. Used after models.json changes, because pi reads that
   * file when it starts. The conversation returns through the session file.
   */
  async restart() {
    if (this.streaming) throw new Error('dispatcher is working on a prompt; abort it first');
    if (this.child) {
      try {
        const st = await this.command('get_state');
        if (st?.sessionFile) this.resumeFile = st.sessionFile;
      } catch {
        /* keep the last known file */
      }
    }
    await this.shutdown();
    await this.ensureStarted();
    return this.state();
  }

  async shutdown() {
    const child = this.child;
    if (!child) return;
    const closed = new Promise((resolve) => child.once('close', resolve));
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    const timer = setTimeout(() => child.kill(), 3000);
    await closed;
    clearTimeout(timer);
  }
}

function modelRef(m) {
  return { value: `${m.provider}/${m.id}`, provider: m.provider, id: m.id, name: m.name ?? m.id };
}

function isInside(dir, file) {
  const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
  return typeof file === 'string' && norm(file).startsWith(norm(dir).replace(/\/+$/, '') + '/');
}

/**
 * Keep events small. Streaming text is cut down to the delta, and any other
 * event over the size limit is replaced by a marker.
 */
function compact(rec) {
  if (rec.type === 'message_update') {
    const ev = rec.assistantMessageEvent;
    if (ev?.type === 'text_delta' || ev?.type === 'thinking_delta') {
      return { type: 'message_update', kind: ev.type, delta: ev.delta ?? '' };
    }
    return { type: 'message_update', kind: ev?.type ?? null };
  }
  const size = JSON.stringify(rec).length;
  if (size > MAX_EVENT_BYTES) return { type: rec.type, truncated: true, bytes: size };
  return rec;
}
