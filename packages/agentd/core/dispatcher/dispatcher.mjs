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

import { compactIfNeeded } from '../pool/compaction.mjs';
import { saved } from '../pool/store.mjs';
import { PiRpc } from '../pi-rpc.mjs';
import { dispatcherRules } from '../rules.mjs';
import { injectionFor } from '../pool/system-prompt.mjs';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentDir, usableProviders } from '../pi-models.mjs';
import { fileURLToPath } from 'node:url';
import { SessionStore } from './sessions.mjs';
import { TurnQueue } from './turn-queue.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
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

/** The last context figure saved for a dispatcher session directory, or null. */
export function savedContext(sessionDir) {
  try {
    return JSON.parse(readFileSync(join(sessionDir, 'context.json'), 'utf8'));
  } catch {
    return null;
  }
}

export class Dispatcher {
  /**
   * @param {{ cwd: string, project?: string|null, sessionDir?: string, onEvent?: (ev: object) => void }} opts
   *
   * With `project` set, the extension runs scoped: every tool call it makes carries
   * that project, and agentd refuses anything outside it.
   */
  constructor({ cwd, project = null, sessionDir = SESSION_DIR, onEvent, compactAt = null }) {
    this.cwd = cwd;
    this.project = project;
    this.sessionDir = sessionDir;
    /** The conversations on disk. */
    this.store = new SessionStore(sessionDir);
    this.lastActive = Date.now();
    this.onEvent = onEvent ?? (() => {});
    /** The pi process and how to talk to it: the one shared client. */
    this.pi = new PiRpc({ label: 'dispatcher', log });
    this.pi.onClose = (code) => this._onClose(code);
    this.pi.addListener((rec) => this._onRecord(rec));
    this.spawnCount = 0;
    /** Whether a turn runs and the messages that wait for it (see turn-queue.mjs). */
    this.turns = new TurnQueue({
      send: (message) => this.command('prompt', { message }, 120_000),
      onChange: (queued) => this.onEvent({ type: 'dispatcher_queue', queued }),
      log,
    });
    this.context = null;
    /** Compact the conversation once it holds this many tokens (null: never), checked when a turn ends. */
    this.compactAt = compactAt;
    this._compacting = false;
    /** Called after a compaction, like an executor's. */
    this.onCompact = null;
    /** Session file to return to after a restart. */
    this.resumeFile = null;
  }

  get busy() {
    return this.turns.busy;
  }

  /** The same, under the names the daemon and the tests use. */
  get streaming() {
    return this.turns.busy;
  }

  /** Messages waiting for the turn to end, oldest first. */
  get queue() {
    return this.turns.items;
  }

  /** The process, while it runs. */
  get child() {
    return this.pi.child;
  }

  get lastError() {
    return this.pi.lastError;
  }

  get stderrTail() {
    return this.pi.stderrTail;
  }

  // -- process ------------------------------------------------------------

  /**
   * Resolves when the process is up AND back on its previous conversation. Callers that arrive while it is still
   * starting wait for the same start, so none of them reads the empty default conversation.
   */
  ensureStarted() {
    if (this._starting) return this._starting;
    if (this.child) return Promise.resolve();
    this._starting = this._start().finally(() => {
      this._starting = null;
    });
    return this._starting;
  }

  async _start() {
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
    // The project's rules for the dispatcher go in as extra system instructions, not as a file in the project.
    if (this.project) {
      const rules = injectionFor('pi', dispatcherRules(), `dispatcher-${this.project}`);
      if (rules.file) args.push('--append-system-prompt', rules.file);
    }
    this.spawnCount += 1;
    this.startedAt = Date.now();
    log(`spawning pi rpc (spawn #${this.spawnCount}, cwd=${this.cwd})`);

    const env = { ...process.env };
    if (this.project) env.AGENTD_PROJECT = this.project;
    else delete env.AGENTD_PROJECT;
    this.pi.start({ cmd: NODE_BIN, args, cwd: this.cwd, env });

    // After a daemon restart nothing is remembered in memory: go back to the newest conversation.
    if (!this.resumeFile) this.resumeFile = this.store.list().sessions[0]?.file ?? null;
    if (this.resumeFile && existsSync(this.resumeFile)) {
      try {
        await this.command('switch_session', { sessionPath: this.resumeFile }, 60_000);
      } catch (err) {
        log(`could not return to the previous session: ${err.message}`);
      }
    }
    this._refreshContext();
  }

  _onRecord(rec) {
    if (rec.type === 'extension_ui_request') {
      if (DIALOG_METHODS.has(rec.method)) {
        this.pi.write({ type: 'extension_ui_response', id: rec.id, cancelled: true });
      }
      return;
    }

    if (rec.type === 'agent_start') this.turns.began();
    if (rec.type === 'agent_settled') {
      this._refreshContext();
      this.turns.settled();
    }

    this.onEvent(compact(rec));
  }

  /** The process ended (pi's client already failed what was pending). */
  _onClose(code) {
    const wasStreaming = this.turns.busy;
    this.turns.closed();
    this.onEvent({ type: 'dispatcher_exit', code, wasStreaming, spawns: this.spawnCount });
  }

  /** How full the conversation is, from pi's own session statistics. Never throws. */
  _refreshContext() {
    this.command('get_session_stats', {}, 30_000)
      .then((stats) => {
        this.context = PiRpc.contextOf(stats);
        // Kept on disk so the figure is still there when the process is idle-reaped or the daemon restarts.
        if (this.context) writeFileSync(join(this.sessionDir, 'context.json'), JSON.stringify(this.context));
        void this._maybeCompact();
      })
      .catch(() => {});
  }

  /** The name this conversation is recorded under (compactions, last size), next to the executors'. */
  get recordName() {
    return `dispatcher:${this.project ?? ''}`;
  }

  /** Past the set size, between turns: pi compacts the conversation. Messages that arrive meanwhile wait their turn. */
  async _maybeCompact() {
    if (!this.compactAt || this.turns.busy || !this.pi.running) return;
    let sessionKey = null;
    try {
      const st = await this.command('get_state');
      sessionKey = st?.sessionFile ?? null;
      if (sessionKey) this.resumeFile = sessionKey; // so the count and the record follow this conversation
    } catch {
      return;
    }
    await compactIfNeeded({
      name: this.recordName,
      owner: this,
      compactAt: this.compactAt,
      busy: this.turns.busy,
      sessionKey,
      context: () => this.context,
      compact: () => this.turns.hold(() => this.command('compact', {}, 600_000)), // what is sent meanwhile waits
      contextAfter: async () => {
        try {
          this.context = PiRpc.contextOf(await this.command('get_session_stats', {}, 30_000));
          if (this.context) writeFileSync(join(this.sessionDir, 'context.json'), JSON.stringify(this.context));
        } catch {
          /* keep the old figure */
        }
        return this.context;
      },
      onCompact: (info) => this.onCompact?.({ ...info, project: this.project }),
    });
  }

  /** How many times the current conversation was compacted. */
  compactions() {
    return saved(this.recordName, this.resumeFile)?.compactions ?? 0;
  }

  /**
   * The dispatcher seen as something a handoff can move to a fresh conversation (core/handoff.mjs asks for exactly
   * this much): it can be busy, take a prompt and return its reply, start a new conversation and name it.
   */
  asHandoffTarget() {
    const d = this;
    return {
      name: this.recordName,
      get busy() {
        return d.turns.busy;
      },
      get cwd() {
        return d.cwd;
      },
      get sessionId() {
        return d.resumeFile;
      },
      get preferSession() {
        return d.resumeFile;
      },
      startPrompt: (text, opts) => d._promptAndWait(text, opts),
      newSession: async () => {
        await d.ensureStarted();
        await d.command('new_session', {}, 60_000);
        return (await d.state())?.sessionFile ?? null;
      },
      renameSession: (file, label) => d.renameSession(file, label, { mustExist: false }),
    };
  }

  /** Send a prompt as a turn of its own, and give back what the dispatcher answered: `{ jobId, done }`. */
  _promptAndWait(text, { timeoutMs = 300_000 } = {}) {
    const done = (async () => {
      await this.ensureStarted();
      const settled = this.pi.waitSettled(timeoutMs);
      settled.catch(() => {});
      const r = await this.turns.start(text);
      if (r.disposition !== 'handled') await settled;
      const msgs = (await this.command('get_messages', {}, 60_000))?.messages ?? [];
      const last = [...msgs].reverse().find((m) => m.role === 'assistant');
      const reply = (last?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return { text: reply, sessionId: this.resumeFile };
    })();
    return { jobId: `dispatcher-${Date.now().toString(36)}`, done };
  }

  async command(type, params = {}, timeoutMs = 60_000) {
    this.lastActive = Date.now();
    return this.pi.command(type, params, timeoutMs);
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
  /** pi reads models.json and auth.json once, at start. True when either changed after that. */
  _configChanged() {
    if (!this.child || !this.startedAt) return false;
    return ['models.json', 'auth.json'].some((n) => {
      try {
        return statSync(join(agentDir(), n)).mtimeMs > this.startedAt;
      } catch {
        return false;
      }
    });
  }

  async models() {
    // A provider added to pi outside agentd shows up here: restart (when idle) so pi reloads its files.
    if (this._configChanged() && !this.turns.busy) {
      log('pi config changed since start, restarting the dispatcher to pick it up');
      await this.restart().catch((err) => log(`restart for new config failed: ${err.message}`));
    }
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
    if (typeof message !== 'string' || !message.trim()) throw new Error('message is required');
    // A turn is running: the message waits its turn (first come, first served).
    return this.turns.submit(message);
  }

  /** Take a waiting message back (a person changed their mind). */
  dequeue(index) {
    return this.turns.take(index);
  }

  async abort() {
    if (!this.child) return { aborted: false, reason: 'not running' };
    // Stop means stop: what was waiting behind the turn is dropped too.
    this.turns.clear();
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
    if (!this.store.contains(sessionFile)) throw new Error('session file is outside the dispatcher session directory');
    await this.command('switch_session', { sessionPath: sessionFile }, 60_000);
    return this.state();
  }

  /** Full history, as pi stores it. */
  async messages() {
    await this.ensureStarted();
    const data = await this.command('get_messages', {}, 60_000);
    return { messages: data?.messages ?? [], turns: await this._turns() };
  }

  /** How long each turn of the conversation in use took (see SessionStore.turns). */
  async _turns() {
    try {
      const file = (await this.state())?.sessionFile;
      return this.store.turns(file, { running: this.turns.busy });
    } catch {
      return [];
    }
  }

  /** Name a conversation (pi has no rename of its own); an empty label removes the name. */
  renameSession(file, label, opts) {
    return this.store.rename(file, label, opts);
  }

  /** Delete a conversation and its name. The one in use cannot be deleted. */
  deleteSession(file) {
    return this.store.remove(file, this.resumeFile);
  }

  /** Conversation files of the dispatcher, newest first. */
  sessions() {
    return this.store.list(this.resumeFile);
  }

  /**
   * Restart the process. Used after models.json changes, because pi reads that
   * file when it starts. The conversation returns through the session file.
   */
  async restart() {
    if (this.turns.busy) throw new Error('dispatcher is working on a prompt; abort it first');
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
