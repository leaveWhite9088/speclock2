/**
 * Agent pool: the scheduler core.
 *
 * Holds one resident ACP process per agent (mcode / dsh / pi), owns the session
 * registry (labels, model choice, live set) and the run/job bookkeeping used for
 * streaming and metrics.
 *
 * This module is deliberately free of pi-extension and transport concerns so
 * every front end (daemon, extension, tests) can reuse it unchanged.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendEntry, readTranscript } from './transcripts.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NODE_BIN = process.env.MCODE_NODE_BIN || 'D:/Environment/nodejs/node.exe';
const NODE_MODULES = 'D:/Environment/nodejs/node_modules';

/** Base working directory for every agent session. */
const BASE_CWD = process.env.AGENTD_BASE_CWD || 'D:/Project2/code-261013-speclock2/speclock2';

const LABELS_FILE =
  process.env.AGENTD_LABELS_FILE ||
  join(dirname(dirname(fileURLToPath(import.meta.url))), 'data', 'session-labels.json');

/** One log file per run, so output can be tailed externally while it streams. */
const RUNS_DIR =
  process.env.AGENTD_RUNS_DIR || join(dirname(dirname(fileURLToPath(import.meta.url))), 'data', 'runs');

/** Registry: add an entry to support another ACP-capable CLI. */
const AGENTS = {
  mcode: {
    label: 'MiniMax Code',
    cmd: NODE_BIN,
    args: [`${NODE_MODULES}/@minimax-ai/code/cli.js`, 'acp'],
    description: 'MiniMax Code agent. Slower to start, strong at multi-step coding.',
    defaultCwd: process.env.AGENTD_CWD_MCODE || null,
  },
  dsh: {
    label: 'DeepSeek Harness',
    cmd: NODE_BIN,
    args: [`${NODE_MODULES}/@deepseek-ai/dsh/lib/bin.js`, '--profile', 'acp'],
    description: 'DeepSeek Harness agent. Fast startup and short answers.',
    defaultCwd: process.env.AGENTD_CWD_DSH || null,
  },
  pi: {
    label: 'independent process',
    cmd: NODE_BIN,
    args: [join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'pi-acp-adapter.mjs')],
    description:
      'A separate pi instance, exposed through an ACP adapter over pi RPC mode. ' +
      'Runs with --no-mcp so it cannot call back into this server.',
    defaultCwd: process.env.AGENTD_CWD_PI || null,
  },
};

const log = (...a) => process.stderr.write(`[agent-pool] ${a.join(' ')}\n`);

const DEFAULT_AGENT = process.env.AGENTD_DEFAULT_AGENT || 'mcode';

/**
 * Optional per-agent startup configuration: `agentd.config.json` next to this
 * lab, or AGENTD_CONFIG to point elsewhere.
 *
 *   { "agents": { "mcode": { "cwd": "D:/work/project-a" },
 *                 "dsh":   { "cwd": "D:/work/project-b" } } }
 *
 * Precedence: explicit cwd on the request > AGENTD_CWD_<AGENT> env > this file >
 * the agent's built-in default > BASE_CWD.
 */
const CONFIG_FILE =
  process.env.AGENTD_CONFIG || join(dirname(dirname(fileURLToPath(import.meta.url))), 'agentd.config.json');

/** Parsed `agentd.config.json`; the dispatcher reads its own section from it. */
let CONFIG = {};

(function applyConfig() {
  let cfg = {};
  try {
    if (existsSync(CONFIG_FILE)) cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) ?? {};
  } catch (err) {
    log('agentd.config.json unreadable, ignoring:', err.message);
  }
  CONFIG = cfg;
  for (const [name, spec] of Object.entries(AGENTS)) {
    spec.type = name;
    const fromEnv = process.env[`AGENTD_CWD_${name.toUpperCase()}`];
    const fromFile = cfg?.agents?.[name]?.cwd;
    spec.defaultCwd = fromEnv || fromFile || spec.defaultCwd || null;
    if (spec.defaultCwd) {
      // A configured workspace that does not exist yet would fail session/new.
      try {
        mkdirSync(spec.defaultCwd, { recursive: true });
      } catch (err) {
        log(`could not create cwd for ${name}:`, err.message);
      }
    }
  }
})();


// ---------------------------------------------------------------------------
// Session label store (sidecar; agents have no rename API)
// ---------------------------------------------------------------------------

/** @type {Record<string, Record<string, {label?: string, cwd?: string, updatedAt?: string, note?: string}>>} */
let store = {};

function loadStore() {
  try {
    if (existsSync(LABELS_FILE)) store = JSON.parse(readFileSync(LABELS_FILE, 'utf8')) ?? {};
  } catch (err) {
    log('labels file unreadable, starting empty:', err.message);
    store = {};
  }
}

function saveStore() {
  try {
    mkdirSync(dirname(LABELS_FILE), { recursive: true });
    writeFileSync(LABELS_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    log('failed to save labels:', err.message);
  }
}

function entry(agent, sessionId) {
  store[agent] ??= {};
  store[agent][sessionId] ??= {};
  return store[agent][sessionId];
}

function noteSession(agent, sessionId, patch) {
  if (!sessionId) return;
  Object.assign(entry(agent, sessionId), patch);
  saveStore();
}

loadStore();

/** Options may be flat or grouped: {group, name, options: [...]}. */
/** Compare directories regardless of slash style, case and trailing slash. */
function normPath(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function flattenOptions(opts = []) {
  return opts.flatMap((o) =>
    Array.isArray(o.options) ? flattenOptions(o.options) : [{ value: o.value, name: o.name, description: o.description }],
  );
}

// ---------------------------------------------------------------------------
// AcpClient: one resident ACP child per agent
// ---------------------------------------------------------------------------

class AcpClient {
  constructor(name, spec) {
    /** Instance id. For the built-in instances it equals the agent type. */
    this.name = name;
    this.spec = spec;
    /** Which CLI this instance runs: mcode, dsh or pi. */
    this.type = spec.type ?? name;
    /** True for instances created at run time (not mcode / dsh / pi themselves). */
    this.custom = Boolean(spec.custom);
    /** Project this instance belongs to (null for the global instances). */
    this.project = spec.project ?? null;
    /** Name inside its project. The pool key is `<project>~<shortId>`. */
    this.shortId = spec.shortId ?? name;
    /** What this instance is for. The dispatcher's LLM reads it when choosing. */
    this.role = spec.role ?? CONFIG?.roles?.[spec.type ?? name] ?? null;
    /** Model this instance should use (config value); applied to sessions that have no choice of their own. */
    this.preferModel = spec.model ?? CONFIG?.defaultModels?.[spec.type ?? name] ?? null;
    /** Session to come back to: the one chosen at creation, then whichever was last active. */
    this.preferSession = spec.sessionId ?? null;
    this.onSession = spec.onSession ?? null;
    /** Last time work was queued or finished, for idle recycling. */
    this.lastActive = Date.now();
    /** Set while we stop the process on purpose, so it is not reported as a crash. */
    this.stopping = false;

    this.child = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;

    this.sessionId = null;
    this.cwd = BASE_CWD;
    this.initPromise = null;

    this.streamedText = '';
    this.spawnCount = 0;
    this.lastError = null;

    this.queue = Promise.resolve();
    this.agentInfo = null;
    this.capabilities = null;
    this.models = null;

    /**
     * Sessions known to be live in this process. `dsh` keeps every session it
     * created active, so `session/resume` on one of them fails with
     * "session is already active". Tracking them lets us switch by simply
     * pointing `sessionId` at the right one.
     */
    this.live = new Set();
    this.sessionConfig = new Map();

    /** Latest `configOptions` for the active session (model, effort, permissions). */
    this.configOptions = [];

    // -- streaming / metrics --
    /** Active run: { jobId, startedAt, firstChunkAt, text, chunks, context, cost, tokens } */
    this.run = null;
    /** Completed runs, newest last. Bounded. */
    this.jobs = new Map();
    /** Progress sink set by whichever front end is attached (daemon broadcasts it). */
    this.progressSink = null;
    this._lastProgressAt = 0;

    /** Rolling run durations, used to flag abnormally slow runs. */
    this.durationHistory = [];
    /** Called when the agent process exits unexpectedly. */
    this.onExit = null;
  }

  // -- process ------------------------------------------------------------

  _spawn() {
    if (this.child) return;
    if (aliveCount() >= MAX_PROCESSES) {
      throw new Error(
        `process limit reached (${MAX_PROCESSES} agent processes are running); stop an idle instance or raise limits.maxProcesses`,
      );
    }
    this.spawnCount += 1;
    log(`[${this.name}] spawning (spawn #${this.spawnCount})`);

    // The pi adapter reads its start directory from AGENTD_BASE_CWD, so each pi
    // instance gets its own. Custom pi instances also get their own session dir,
    // because the adapter keeps a session map file there.
    const env = { ...process.env, ...(this.spec.env ?? {}) };
    if (this.type === 'pi' && this.spec.defaultCwd) env.AGENTD_BASE_CWD = this.spec.defaultCwd;

    const child = spawn(this.spec.cmd, this.spec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
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
        if (line) this._onMessage(line);
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
      // A replacement process may already be running (stopped, then used again at once).
      if (this.child && this.child !== child) {
        this.stopping = false;
        return;
      }
      const wasRunning = Boolean(this.run);
      this.child = null;
      this.initPromise = null;
      this.sessionId = null;
      this.live.clear();
      for (const { reject } of this.pending.values()) reject(new Error(`${this.name} ACP exited`));
      this.pending.clear();
      if (this.stopping) {
        this.stopping = false;
        return;
      }
      try {
        this.onExit?.({ agent: this.name, code, wasRunning, spawns: this.spawnCount });
      } catch {
        /* listener errors must not break the pool */
      }
    });
  }

  _onMessage(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return log(`[${this.name}] non-json:`, line.slice(0, 120));
    }

    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }

    if (msg.id != null && msg.method) {
      if (msg.method === 'session/request_permission') {
        const opts = msg.params?.options ?? [];
        const picked = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? '')) ?? opts[0];
        this._write({
          jsonrpc: '2.0',
          id: msg.id,
          result: picked ? { optionId: picked.optionId } : {},
        });
      } else {
        this._write({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `unsupported: ${msg.method}` },
        });
      }
      return;
    }

    if (msg.method === 'session/update') {
      const u = msg.params?.update;
      if (!u) return;

      if (u.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
        this.streamedText += u.content.text;
        this._recordChunk(u.content.text);
        return;
      }

      // Reasoning chunks are not answer text, but they are the only sign of life
      // some agents give during long think phases (mcode: up to ~17s).
      if (u.sessionUpdate === 'agent_thought_chunk' && u.content?.text) {
        this._recordThought(u.content.text);
        return;
      }

      if (u.sessionUpdate === 'usage_update') {
        const run = this.run;
        const ctx = {
          used: u.used ?? null,
          size: u.size ?? null,
          percent: u.used != null && u.size ? +((u.used / u.size) * 100).toFixed(1) : null,
        };
        if (run) {
          run.context = ctx;
          if (u.cost) run.cost = u.cost;
          if (u.tokens) run.tokens = u.tokens;
        }
        this.lastUsage = { ...ctx, cost: u.cost ?? null, tokens: u.tokens ?? null };
        return;
      }

      if (u.sessionUpdate === 'config_option_update' && Array.isArray(u.configOptions)) {
        this.configOptions = u.configOptions;
      }

      // Tool activity goes into the transcript. A call is recorded when it starts
      // and again when it ends, so the transcript shows what the agent did.
      const run = this.run;
      if (run?.sessionId) {
        if (u.sessionUpdate === 'tool_call') {
          appendEntry(this.name, run.sessionId, {
            role: 'tool',
            jobId: run.jobId,
            toolCallId: u.toolCallId ?? null,
            title: u.title ?? null,
            kind: u.kind ?? null,
            status: u.status ?? 'started',
          });
        } else if (
          u.sessionUpdate === 'tool_call_update' &&
          (u.status === 'completed' || u.status === 'failed')
        ) {
          appendEntry(this.name, run.sessionId, {
            role: 'tool',
            jobId: run.jobId,
            toolCallId: u.toolCallId ?? null,
            title: u.title ?? null,
            kind: u.kind ?? null,
            status: u.status,
          });
        }
      }
    }
  }

  /** Append a streamed chunk to the active run and push progress upstream. */
  _recordChunk(text) {
    const run = this.run;
    if (!run) return;
    if (run.firstChunkAt == null) run.firstChunkAt = Date.now();
    run.text += text;
    run.chunks += 1;

    if (run.logFile) {
      try {
        appendFileSync(run.logFile, text, 'utf8');
      } catch {
        /* logging is best-effort */
      }
    }

    const now = Date.now();
    if (this.progressSink && now - this._lastProgressAt >= 500) {
      this._lastProgressAt = now;
      this.progressSink(run.jobId, {
        chars: run.text.length,
        thinkingChars: run.thoughtChars,
        elapsedMs: now - run.startedAt,
      });
    }
  }

  /** Reasoning text: counted for progress only, never returned as output. */
  _recordThought(text) {
    const run = this.run;
    if (!run) return;
    if (run.firstChunkAt == null) run.firstChunkAt = Date.now();
    run.thoughtChars += text.length;

    const now = Date.now();
    if (this.progressSink && now - this._lastProgressAt >= 500) {
      this._lastProgressAt = now;
      this.progressSink(run.jobId, {
        chars: run.text.length,
        thinkingChars: run.thoughtChars,
        elapsedMs: now - run.startedAt,
      });
    }
  }

  _write(obj) {
    try {
      this.child?.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      log(`[${this.name}] write failed:`, err.message);
    }
  }

  _request(method, params, { timeoutMs = 300_000 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms`));
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
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  _enqueue(task) {
    this.lastActive = Date.now();
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => {
        this.lastActive = Date.now();
      },
      () => {
        this.lastActive = Date.now();
      },
    );
    return run;
  }

  /**
   * Run a session-management operation in the same order as prompts.
   * Front-end calls can arrive concurrently, so anything that reads or mutates the
   * active session must serialize behind an in-flight prompt.
   */
  serialized(fn) {
    return this._enqueue(fn);
  }

  /** Record the config options returned by session/new, resume or set_config_option. */
  _captureConfig(result) {
    const opts = result?.configOptions;
    if (Array.isArray(opts)) this.configOptions = opts;
  }

  /** Current model id, if the agent exposes one. */
  currentModel() {
    return this.configOptions?.find((o) => o.id === 'model')?.currentValue ?? null;
  }

  /**
   * Re-apply the model a session was last given.
   *
   * `mcode` stores the choice in its own session state, but `dsh` resets to the
   * default after a process restart (verified), so we keep our own copy and push
   * it back on resume.
   */
  async _reapplyStoredConfig() {
    const saved = store[this.name]?.[this.sessionId]?.config;
    if (!saved) return [];
    const applied = [];
    for (const [configId, value] of Object.entries(saved)) {
      const opt = this.configOptions?.find((o) => o.id === configId);
      if (!opt || opt.currentValue === value) continue;
      try {
        const r = await this._request('session/set_config_option', {
          sessionId: this.sessionId,
          configId,
          value,
        });
        this._captureConfig(r);
        applied.push({ configId, value });
        log(`[${this.name}] re-applied ${configId}=${value}`);
      } catch (err) {
        log(`[${this.name}] could not re-apply ${configId}: ${err.message}`);
      }
    }
    return applied;
  }

  // -- lifecycle ----------------------------------------------------------

  /**
   * Spawn + initialize once.
   *
   * Starts of the same CLI type are serialized (two mcode processes starting at the same
   * moment were seen to kill each other), and a process that dies while starting is retried
   * with a short backoff. The final error carries the tail of the child's stderr.
   */
  async _init() {
    if (this.child && this.initPromise) return this.initPromise;
    this.initPromise = withStartLock(this.type, async () => {
      let lastErr;
      for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
        try {
          this._spawn();
          const init = await this._request('initialize', {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          });
          this.agentInfo = init?.agentInfo ?? null;
          this.capabilities = init?.agentCapabilities ?? null;
          return this.capabilities;
        } catch (err) {
          lastErr = err;
          if (!/ACP exited/.test(err.message) || attempt === START_ATTEMPTS) break;
          log(`[${this.name}] died while starting (attempt ${attempt}/${START_ATTEMPTS}); retrying`);
          await new Promise((r) => setTimeout(r, attempt * 1500));
        }
      }
      const tail = (this.stderrTail ?? []).join(' | ');
      throw new Error(`${this.name} could not start: ${lastErr.message}${tail ? ` (${tail})` : ''}`);
    }).catch((err) => {
      this.initPromise = null;
      this.lastError = err.message;
      throw err;
    });
    return this.initPromise;
  }

  /** Remember which session is active, so a recycled process comes back to it. */
  _noteActive() {
    if (!this.sessionId || this.preferSession === this.sessionId) return;
    this.preferSession = this.sessionId;
    try {
      this.onSession?.(this.sessionId);
    } catch (err) {
      log(`[${this.name}] onSession failed: ${err.message}`);
    }
  }

  /** Give a session the instance's model unless it already has a choice of its own. */
  async _applyPreferredModel() {
    const want = this.preferModel;
    const opt = this.configOptions?.find((o) => o.id === 'model');
    if (!want || !opt || opt.currentValue === want || !this.sessionId) return;
    if (store[this.name]?.[this.sessionId]?.config?.model) return;
    try {
      const r = await this._request('session/set_config_option', {
        sessionId: this.sessionId,
        configId: 'model',
        value: want,
      });
      this._captureConfig(r);
      const meta = entry(this.name, this.sessionId);
      meta.config = { ...(meta.config ?? {}), model: want };
      if (!meta.cwd) meta.cwd = this.cwd;
      saveStore();
      log(`[${this.name}] applied instance model ${want}`);
    } catch (err) {
      log(`[${this.name}] could not apply instance model ${want}: ${err.message}`);
    }
  }

  /** Init + ensure an active session for `cwd`. */
  async ensureReady(cwd) {
    await this._init();
    const wantCwd = cwd || this.spec.defaultCwd || this.cwd || BASE_CWD;
    if (this.sessionId && wantCwd === this.cwd) return this.sessionId;

    // First use after a (re)start: go back to the chosen / last active session.
    if (!this.sessionId && this.preferSession) {
      try {
        await this._attach(this.preferSession, wantCwd);
        return this.sessionId;
      } catch (err) {
        log(`[${this.name}] could not resume ${this.preferSession}: ${err.message}; starting a new session`);
        this.preferSession = null;
      }
    }

    const t0 = Date.now();
    const sess = await this._request('session/new', { cwd: wantCwd, mcpServers: [] });
    this.sessionId = sess?.sessionId;
    this.cwd = wantCwd;
    if (this.sessionId) this.live.add(this.sessionId);
    this._captureConfig(sess);
    this.sessionConfig.set(this.sessionId, this.configOptions);
    noteSession(this.name, this.sessionId, { cwd: wantCwd, updatedAt: new Date().toISOString() });
    log(`[${this.name}] new session ${this.sessionId} in ${Date.now() - t0}ms`);
    await this._applyPreferredModel();
    this._noteActive();
    return this.sessionId;
  }

  /**
   * Attach to an existing session. If it is already live in this process we just
   * retarget the pointer; otherwise resume it from disk.
   */
  async _attach(sessionId, cwd) {
    const res = await this._attachRaw(sessionId, cwd);
    await this._applyPreferredModel();
    this._noteActive();
    return res;
  }

  async _attachRaw(sessionId, cwd) {
    const wantCwd = cwd || store[this.name]?.[sessionId]?.cwd || this.cwd || BASE_CWD;

    if (this.live.has(sessionId)) {
      this.sessionId = sessionId;
      this.cwd = wantCwd;
      if (this.sessionConfig.has(sessionId)) this.configOptions = this.sessionConfig.get(sessionId);
      const reApplied = await this._reapplyStoredConfig();
      return { sessionId, cwd: wantCwd, resumed: false, live: true, reApplied };
    }

    try {
      const res = await this._request('session/resume', { sessionId, cwd: wantCwd });
      this.sessionId = res?.sessionId ?? sessionId;
      this.cwd = wantCwd;
      this.models = res?.models ?? this.models;
      this.live.add(this.sessionId);
      this._captureConfig(res);
      this.sessionConfig.set(this.sessionId, this.configOptions);
      noteSession(this.name, this.sessionId, { cwd: wantCwd, updatedAt: new Date().toISOString() });
      const reApplied = await this._reapplyStoredConfig();
      return { sessionId: this.sessionId, cwd: wantCwd, resumed: true, live: true, reApplied };
    } catch (err) {
      // Some agents report an already-active session instead of resuming it.
      if (/already active/i.test(err.message)) {
        this.sessionId = sessionId;
        this.cwd = wantCwd;
        this.live.add(sessionId);
        const reApplied = await this._reapplyStoredConfig();
        return { sessionId, cwd: wantCwd, resumed: false, live: true, reApplied };
      }
      throw err;
    }
  }

  /** Set a config option (model, effort, permission) for a session and remember it. */
  async setConfigOption(configId, value, sessionId) {
    return this._enqueue(async () => {
      await this._init();
      if (sessionId && sessionId !== this.sessionId) await this._attach(sessionId);
      else if (!this.sessionId) await this.ensureReady();

      const r = await this._request('session/set_config_option', {
        sessionId: this.sessionId,
        configId,
        value,
      });
      this._captureConfig(r);

      const meta = entry(this.name, this.sessionId);
      meta.config = { ...(meta.config ?? {}), [configId]: value };
      if (!meta.cwd) meta.cwd = this.cwd;
      saveStore();

      return { sessionId: this.sessionId, configOptions: this.configOptions };
    });
  }

  /** Describe the config options and their current values for a session. */
  async describeModels(sessionId) {
    return this._enqueue(async () => {
      await this._init();
      if (sessionId && sessionId !== this.sessionId) await this._attach(sessionId);
      else await this.ensureReady();
      // Agents may nest options in provider groups (dsh). Normalise so every
      // front end sees one flat list per config option.
      return {
        sessionId: this.sessionId,
        configOptions: this.configOptions.map((opt) => ({
          ...opt,
          options: flattenOptions(opt.options),
        })),
      };
    });
  }

  /** Reattach to an existing session. Requires cwd for both agents. */
  async useSession(sessionId, cwd) {
    return this._enqueue(async () => {
      await this._init();
      return this._attach(sessionId, cwd);
    });
  }

  async newSession(cwd) {
    return this._enqueue(async () => {
      await this._init();
      this.sessionId = null;
      this.preferSession = null; // an explicit "new" must not fall back to the remembered session
      return this.ensureReady(cwd);
    });
  }

  /** Blocking convenience wrapper. Returns the finished run payload. */
  prompt(text, opts = {}) {
    return this.startPrompt(text, opts).done;
  }

  /**
   * Start a prompt and return `{ jobId, done }` immediately, so the caller can
   * report the job id before the run finishes (async / streaming mode).
   */
  /** Front ends register one sink; it receives (jobId, progressPayload). */
  setProgressSink(fn) {
    this.progressSink = fn;
  }

  startPrompt(text, { timeoutMs = 300_000, cwd, reset, sessionId } = {}) {
    const jobId = `${this.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const done = this._enqueue(async () => {
      const run = this._beginRun(jobId);
      try {
        if (sessionId && sessionId !== this.sessionId) {
          await this._init();
          await this._attach(sessionId, cwd);
        } else if (reset) {
          this.sessionId = null;
          this.preferSession = null;
        }
        await this.ensureReady(cwd);
        this.streamedText = '';
        run.sessionId = this.sessionId;
        run.model = this.currentModel();
        // Spawning is expected here; only a restart after this point is abnormal.
        run.spawnsAtStart = this.spawnCount;

        appendEntry(this.name, this.sessionId, {
          role: 'user',
          jobId,
          text,
          model: run.model,
        });

        const res = await this._request(
          'session/prompt',
          { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
          { timeoutMs },
        );

        run.stopReason = res?.stopReason ?? null;
        noteSession(this.name, this.sessionId, { updatedAt: new Date().toISOString() });
        appendEntry(this.name, this.sessionId, {
          role: 'assistant',
          jobId,
          text: this.streamedText.trim(),
          stopReason: run.stopReason,
          model: run.model,
        });
        return {
          text: this.streamedText.trim(),
          stopReason: res?.stopReason,
          sessionId: this.sessionId,
          metrics: this._finishRun(run),
        };
      } catch (err) {
        run.error = err.message;
        // Record the failure and any partial answer, so the transcript has no gap.
        appendEntry(this.name, run.sessionId, {
          role: 'error',
          jobId,
          text: run.text.trim() || null,
          error: err.message,
        });
        // Keep the metrics on the error: a crashed run still produces a receipt
        // with duration, model and inferred attention.
        err.metrics = this._finishRun(run);
        err.sessionId = run.sessionId;
        throw err;
      } finally {
        /* nothing to detach: the sink is per-agent */
      }
    });

    return { jobId, done };
  }

  // -- runs / metrics -----------------------------------------------------

  _beginRun(jobId) {
    const run = {
      jobId,
      agent: this.name,
      startedAt: Date.now(),
      firstChunkAt: null,
      endedAt: null,
      text: '',
      chunks: 0,
      thoughtChars: 0,
      sessionId: this.sessionId,
      model: this.currentModel(),
      context: null,
      cost: null,
      tokens: null,
      stopReason: null,
      error: null,
      spawnsAtStart: null, // set after the agent is ready
      logFile: join(RUNS_DIR, `${jobId}.log`),
    };
    try {
      mkdirSync(RUNS_DIR, { recursive: true });
      writeFileSync(run.logFile, '', 'utf8');
    } catch {
      run.logFile = null;
    }
    this.run = run;
    this._lastProgressAt = 0;
    this.jobs.set(jobId, run);
    // keep the map bounded
    while (this.jobs.size > 30) this.jobs.delete(this.jobs.keys().next().value);
    return run;
  }

  _finishRun(run) {
    run.endedAt = Date.now();
    this.run = null;
    const metrics = this._metrics(run);
    // Feed the rolling window only once per finished run, so a run is never its
    // own baseline and repeated metric reads do not skew it.
    if (!run.error) {
      this.durationHistory.push(metrics.durationMs);
      while (this.durationHistory.length > 20) this.durationHistory.shift();
    }
    return metrics;
  }

  /** Numeric view of a run. Token counts are only present when the agent reports them. */
  _metrics(run) {
    const ended = run.endedAt ?? Date.now();
    const durationMs = ended - run.startedAt;
    const seconds = durationMs / 1000;
    const ttftMs = run.firstChunkAt ? run.firstChunkAt - run.startedAt : null;

    const tokens = run.tokens ?? null;
    const outputTokens = tokens?.output ?? null;
    const tps = outputTokens != null && seconds > 0 ? +(outputTokens / seconds).toFixed(1) : null;
    const charsPerSecond = run.text.length && seconds > 0 ? +(run.text.length / seconds).toFixed(1) : null;

    const metrics = {
      jobId: run.jobId,
      durationMs,
      timeToFirstTokenMs: ttftMs,
      chars: run.text.length,
      chunks: run.chunks,
      thinkingChars: run.thoughtChars,
      stopReason: run.stopReason,
      model: run.model,
      modelName: this._modelName(run.model),
      tokens,
      tokensSource: tokens ? 'agent' : 'unavailable',
      tokensPerSecond: tps,
      charsPerSecond,
      context: run.context,
      cost: run.cost,
      logFile: run.logFile,
      error: run.error,
    };

    const attention = this._deriveAttention(run, metrics);
    metrics.attention = attention;
    metrics.health = attention.some((a) => a.severity === 'error')
      ? 'error'
      : attention.some((a) => a.severity === 'warn')
        ? 'warn'
        : 'ok';

    return metrics;
  }

  /**
   * Health signals the scheduler can infer on its own.
   *
   * These deliberately need no cooperation from the agent: they come from the
   * protocol result, our own timers and the context usage the agent reports.
   * `source: 'system'` marks them as inferred, so a future agent-reported signal
   * can be told apart from these.
   */
  _deriveAttention(run, m) {
    const out = [];
    const add = (code, severity, text) => out.push({ code, severity, source: 'system', text });

    if (run.error) {
      if (/timed out|did not finish within/i.test(run.error)) {
        add('timeout', 'error', `run did not finish in time: ${run.error}`);
      } else {
        add('run_failed', 'error', run.error);
      }
    }

    if (m.stopReason === 'refusal') add('refused', 'error', 'agent refused the task');
    if (m.stopReason === 'cancelled') add('cancelled', 'warn', 'run was cancelled before finishing');

    if (!run.error && run.stopReason !== 'cancelled' && !run.text.trim()) {
      add(
        'empty_output',
        'warn',
        run.thoughtChars > 0
          ? `agent produced no answer text (${run.thoughtChars} chars of reasoning only)`
          : 'agent produced no output at all',
      );
    }

    if (m.context?.percent != null && m.context.percent >= 80) {
      add(
        'context_pressure',
        m.context.percent >= 95 ? 'error' : 'warn',
        `context window ${m.context.percent}% full (${m.context.used}/${m.context.size}); compaction is near`,
      );
    }

    if (run.spawnsAtStart != null && this.spawnCount > run.spawnsAtStart) {
      add('agent_restarted', 'error', 'the agent process restarted during this run');
    }

    if (m.durationMs > 30_000 && this.durationHistory.length >= 5) {
      const sorted = [...this.durationHistory].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
      if (p95 > 0 && m.durationMs > p95 * 2) {
        add('slow_run', 'info', `took ${(m.durationMs / 1000).toFixed(1)}s, more than twice the p95 (${(p95 / 1000).toFixed(1)}s)`);
      }
    }

    return out;
  }

  _modelName(value) {
    if (!value) return null;
    const opt = this.configOptions?.find((o) => o.id === 'model');
    return flattenOptions(opt?.options).find((o) => o.value === value)?.name ?? null;
  }

  /** Snapshot for `agent_tail`. */
  tail(jobId) {
    const run = jobId ? this.jobs.get(jobId) : this.run ?? [...this.jobs.values()].pop();
    if (!run) return null;
    return {
      jobId: run.jobId,
      agent: run.agent,
      running: !run.endedAt,
      elapsedMs: (run.endedAt ?? Date.now()) - run.startedAt,
      chars: run.text.length,
      chunks: run.chunks,
      thinkingChars: run.thoughtChars,
      text: run.text,
      sessionId: run.sessionId,
      logFile: run.logFile,
      metrics: this._metrics(run),
    };
  }

  /** `session/list`; merged with local labels. */
  async listSessions() {
    await this._init();
    let remote = [];
    let remoteError = null;
    try {
      const res = await this._request('session/list', {}, { timeoutMs: 60_000 });
      remote = res?.sessions ?? (Array.isArray(res) ? res : []);
    } catch (err) {
      remoteError = err.message;
    }

    const local = store[this.name] ?? {};
    const byId = new Map();

    for (const s of remote) {
      // An agent lists every session of its CLI. A custom instance only owns the
      // ones in its own directory, so two instances of one CLI do not mix.
      if (this.custom && s.cwd && normPath(s.cwd) !== normPath(this.spec.defaultCwd)) continue;
      // The built-in instance leaves out the sessions that belong to a created one.
      if (!this.custom && s.cwd && ownedByInstance(this, s.cwd)) continue;
      byId.set(s.sessionId, {
        sessionId: s.sessionId,
        cwd: s.cwd ?? local[s.sessionId]?.cwd ?? null,
        title: s.title ?? null,
        updatedAt: s.updatedAt ?? local[s.sessionId]?.updatedAt ?? null,
        label: local[s.sessionId]?.label ?? null,
        source: 'agent',
      });
    }
    for (const [id, meta] of Object.entries(local)) {
      if (byId.has(id)) continue;
      byId.set(id, {
        sessionId: id,
        cwd: meta.cwd ?? null,
        title: null,
        updatedAt: meta.updatedAt ?? null,
        label: meta.label ?? null,
        source: 'local',
      });
    }
    // Sessions created in this process may be too new for the agent's list.
    for (const id of this.live) {
      if (byId.has(id)) continue;
      byId.set(id, {
        sessionId: id,
        cwd: local[id]?.cwd ?? this.cwd,
        title: null,
        updatedAt: local[id]?.updatedAt ?? null,
        label: local[id]?.label ?? null,
        source: 'live',
      });
    }
    // The active session may be too new to appear in the agent's list.
    if (this.sessionId && !byId.has(this.sessionId)) {
      byId.set(this.sessionId, {
        sessionId: this.sessionId,
        cwd: this.cwd,
        title: null,
        updatedAt: local[this.sessionId]?.updatedAt ?? null,
        label: local[this.sessionId]?.label ?? null,
        source: 'local',
      });
    }

    const rows = [...byId.values()].map((r) => ({ ...r, active: r.sessionId === this.sessionId }));
    rows.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
    return { sessions: rows, remoteError };
  }

  renameSession(sessionId, label) {
    const id = sessionId || this.sessionId;
    if (!id) throw new Error('no active session to rename');
    const e = entry(this.name, id);
    if (label === null || label === '') delete e.label;
    else e.label = label;
    if (!e.cwd) e.cwd = this.cwd;
    saveStore();
    return { sessionId: id, label: e.label ?? null };
  }

  status() {
    const lastRun = [...this.jobs.values()].pop();
    const lastAttention = lastRun ? this._metrics(lastRun).attention : [];
    return {
      agent: this.name,
      type: this.type,
      custom: this.custom,
      label: this.spec.label,
      alive: Boolean(this.child),
      sessionId: this.sessionId,
      sessionLabel: this.sessionId ? (store[this.name]?.[this.sessionId]?.label ?? null) : null,
      model: this.currentModel(),
      modelName: this._modelName(this.currentModel()),
      cwd: this.cwd,
      defaultCwd: this.spec.defaultCwd ?? null,
      spawns: this.spawnCount,
      liveSessions: [...this.live],
      pid: this.child?.pid ?? null,
      agentInfo: this.agentInfo,
      lastError: this.lastError,
      lastJobId: lastRun?.jobId ?? null,
      attention: lastAttention,
      health: lastAttention.some((a) => a.severity === 'error')
        ? 'error'
        : lastAttention.some((a) => a.severity === 'warn')
          ? 'warn'
          : 'ok',
    };
  }

  /** Ask the agent to stop the in-flight prompt. ACP sends this as a notification. */
  cancel() {
    if (!this.sessionId) return { cancelled: false, reason: 'no active session' };
    this._write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
    if (this.run) this.run.cancelRequested = true;
    return { cancelled: true, sessionId: this.sessionId };
  }

  get busy() {
    return Boolean(this.run);
  }

  async shutdown() {
    if (!this.child) return;
    this.stopping = true;
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {
      /* ignore */
    }
    this.child = null;
  }
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

const pool = new Map();

/** Upper bound on live agent processes, so many projects cannot exhaust memory. */
const MAX_PROCESSES = Number(process.env.AGENTD_MAX_PROCESSES) || CONFIG?.limits?.maxProcesses || 12;

/** Model a type uses when an instance names none (agentd.config.json defaultModels). */
function defaultModelFor(type) {
  return CONFIG?.defaultModels?.[type] ?? null;
}

const START_ATTEMPTS = 3;
const startChains = new Map();

/** Run `fn` after the previous start of the same CLI type has finished. */
function withStartLock(key, fn) {
  const prev = startChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  startChains.set(key, next.catch(() => {}));
  return next;
}

function aliveCount(filter = () => true) {
  let n = 0;
  for (const a of pool.values()) if (a.child && filter(a)) n += 1;
  return n;
}

/** True when `cwd` is the directory of a created instance of the same CLI type. */
function ownedByInstance(agent, cwd) {
  for (const other of pool.values()) {
    if (other === agent || !other.custom || other.type !== agent.type) continue;
    if (normPath(other.spec.defaultCwd) === normPath(cwd)) return true;
  }
  return false;
}
for (const [name, spec] of Object.entries(AGENTS)) pool.set(name, new AcpClient(name, spec));

// ---------------------------------------------------------------------------
// Instances
//
// An instance is one resident process of a CLI type, pinned to one directory.
// mcode, dsh and pi exist from the start (id equals type). More can be created at
// run time, for example two `dsh` processes in two different projects. Created
// instances are saved in data/instances.json and come back after a daemon restart.
// ---------------------------------------------------------------------------

const DATA_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'data');
const INSTANCES_FILE = process.env.AGENTD_INSTANCES_FILE || join(DATA_DIR, 'instances.json');
const INSTANCE_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** @type {Array<{id: string, type: string, cwd: string, createdAt: string}>} */
let savedInstances = [];

function saveInstances() {
  try {
    mkdirSync(dirname(INSTANCES_FILE), { recursive: true });
    writeFileSync(INSTANCES_FILE, JSON.stringify({ instances: savedInstances }, null, 2));
  } catch (err) {
    log('failed to save instances:', err.message);
  }
}

function buildInstance({ id, type, cwd, project = null, shortId = id, role = null, model = null, sessionId = null, onSession = null }) {
  const base = AGENTS[type];
  const spec = {
    ...base,
    type,
    model,
    sessionId,
    onSession,
    custom: true,
    project,
    shortId,
    role,
    label: `${base.label} (${shortId})`,
    defaultCwd: cwd,
    env: type === 'pi' ? { PI_SESSION_DIR: join(DATA_DIR, 'pi-sessions', id) } : undefined,
  };
  return new AcpClient(id, spec);
}

(function restoreInstances() {
  try {
    if (!existsSync(INSTANCES_FILE)) return;
    const data = JSON.parse(readFileSync(INSTANCES_FILE, 'utf8'));
    for (const rec of data?.instances ?? []) {
      if (!rec?.id || pool.has(rec.id) || !AGENTS[rec.type] || !rec.cwd) continue;
      savedInstances.push(rec);
      pool.set(rec.id, buildInstance(rec));
    }
  } catch (err) {
    log('instances file unreadable, ignoring:', err.message);
  }
})();

/** Create another instance of `type` in `cwd`. Returns the new AcpClient. */
function createInstance({ id, type, cwd }) {
  if (!INSTANCE_ID_RE.test(String(id ?? ''))) {
    throw new Error('instance id must start with a letter and use only a-z, 0-9, "-" or "_" (max 32)');
  }
  if (!AGENTS[type]) throw new Error(`unknown type "${type}"; available: ${Object.keys(AGENTS).join(', ')}`);
  if (pool.has(id)) throw new Error(`instance "${id}" already exists`);
  if (!cwd || typeof cwd !== 'string') throw new Error('cwd is required');

  mkdirSync(cwd, { recursive: true });
  const rec = { id, type, cwd, createdAt: new Date().toISOString() };
  const agent = buildInstance(rec);
  pool.set(id, agent);
  savedInstances.push(rec);
  saveInstances();
  return agent;
}

/** Stop and forget a created instance. The built-in ones cannot be removed. */
async function removeInstance(id) {
  const agent = pool.get(id);
  if (!agent) throw new Error(`unknown instance "${id}"`);
  if (!agent.custom) throw new Error(`"${id}" is a built-in instance and cannot be removed`);
  if (agent.busy) throw new Error(`instance "${id}" is running a prompt; cancel it first`);

  await agent.shutdown();
  pool.delete(id);
  savedInstances = savedInstances.filter((r) => r.id !== id);
  saveInstances();
  return { id, removed: true };
}

/** One row per instance, for dashboards and the `instances` op. */
function listInstances() {
  return [...pool.values()].map((a) => ({
    id: a.name,
    project: a.project,
    shortId: a.shortId,
    role: a.role,
    preferModel: a.preferModel,
    preferSession: a.preferSession,
    lastActive: a.lastActive,
    type: a.type,
    custom: a.custom,
    label: a.spec.label,
    cwd: a.spec.defaultCwd ?? null,
    alive: Boolean(a.child),
    busy: a.busy,
    lastError: a.child ? null : (a.lastError ?? null),
    sessionId: a.sessionId,
    model: a.currentModel(),
  }));
}

function getAgent(name) {
  const key = name || DEFAULT_AGENT;
  const agent = pool.get(key);
  if (!agent) throw new Error(`unknown agent "${key}"; available: ${[...pool.keys()].join(', ')}`);
  return agent;
}

function formatMetrics(m, agent) {
  if (!m) return '';
  const lines = ['---'];
  lines.push(`agent: ${agent.name} (${agent.spec.label})   session: ${agent.sessionId}`);
  lines.push(`model: ${m.modelName ?? m.model ?? '(unknown)'}`);
  lines.push(
    `duration: ${m.durationMs}ms` +
      (m.timeToFirstTokenMs != null ? `   first token: ${m.timeToFirstTokenMs}ms` : ''),
  );
  if (m.tokens) {
    const t = m.tokens;
    lines.push(
      `tokens: in ${t.input ?? '?'} / out ${t.output ?? '?'}` +
        (t.cacheRead != null ? ` / cache-read ${t.cacheRead}` : '') +
        (t.total != null ? ` / total ${t.total}` : ''),
    );
    if (m.tokensPerSecond != null) lines.push(`tps: ${m.tokensPerSecond} tok/s (output)`);
  } else {
    lines.push('tokens: not exposed by this agent over ACP');
  }
  if (m.charsPerSecond != null) {
    lines.push(`throughput: ${m.charsPerSecond} chars/s, ${m.chars} chars in ${m.chunks} chunks`);
  }
  if (m.thinkingChars) lines.push(`thinking: ${m.thinkingChars} chars of reasoning`);
  if (m.context) {
    lines.push(
      `context: ${m.context.used ?? '?'} / ${m.context.size ?? '?'}` +
        (m.context.percent != null ? ` (${m.context.percent}%)` : ''),
    );
  }
  if (m.cost) lines.push(`cost: ${m.cost.amount ?? '?'} ${m.cost.currency ?? ''}`.trim());
  if (m.logFile) lines.push(`log: ${m.logFile}`);
  lines.push(`spawns: ${agent.spawnCount}`);
  return lines.join('\n');
}

export {
  AGENTS,
  BASE_CWD,
  CONFIG,
  DEFAULT_AGENT,
  pool,
  getAgent,
  createInstance,
  removeInstance,
  buildInstance,
  aliveCount,
  defaultModelFor,
  MAX_PROCESSES,
  listInstances,
  readTranscript,
  flattenOptions,
  formatMetrics,
};
