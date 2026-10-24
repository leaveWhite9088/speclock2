/** AcpClient: one resident ACP child per agent. Sessions, runs, model choice and the JSON-RPC plumbing live here. */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendEntry } from '../transcripts.mjs';
import { COMPACT_PROMPT, maybeCompact } from './compaction.mjs';
import { BASE_CWD, CANCEL_GRACE_MS, CONFIG, FORCED_STOP_LIMIT, FORCED_STOP_WINDOW_MS, IDLE_RUN_MS, MAX_RUN_MS, RUNS_DIR, flattenOptions, log, normPath } from './config.mjs';
import { modelName, runMetrics } from './metrics.mjs';
import { killTree } from './process.mjs';
import { PromptQueue } from './prompt-queue.mjs';
import { injectionFor } from './system-prompt.mjs';
import { inputText, outputText } from './tool-text.mjs';
import { MAX_PROCESSES, START_ATTEMPTS, aliveCount, defaultModelFor, ownedByInstance, withStartLock } from './registry.mjs';
import { entry, noteSession, saveStore, saved, savedAll } from './store.mjs';

export class AcpClient {
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
    /** Compact the conversation once it holds this many tokens (null: never). Checked when a run ends. */
    this.compactAt = spec.compactAt ?? null;
    this.onCompact = null;
    this._compacting = false;
    /** Last time work was queued or finished, for idle recycling. */
    this.lastActive = Date.now();
    /** Set while we stop the process on purpose, so it is not reported as a crash. */
    this.stopping = false;

    this.child = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;

    this.sessionId = null;
    /** Where it works. Before the first start this is the directory it will start in, not the global base. */
    this.cwd = spec.defaultCwd || BASE_CWD;
    this.initPromise = null;

    this.streamedText = '';
    this.spawnCount = 0;
    this.lastError = null;

    this.line = new PromptQueue({ touch: () => (this.lastActive = Date.now()) });
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
    this.lastSignal = Date.now();
    this.openTools = new Set();
    /** Completed runs, newest last. Bounded. */
    this.jobs = new Map();
    /** Progress sink set by whichever front end is attached (daemon broadcasts it). */
    this.progressSink = null;
    this._lastProgressAt = 0;

    /** Rolling run durations, used to flag abnormally slow runs. */
    this.durationHistory = [];
    /** Called when the agent process exits unexpectedly. */
    this.onExit = null;
    /** Times (ms) this process had to be killed because it ignored a cancel; drives the `unstable` flag. */
    this.forcedStops = [];
    /** Children we killed on purpose, so their `close` is not reported as a crash. */
    this.killed = new WeakSet();
    /** Called when a process is killed for ignoring a cancel. */
    this.onForcedStop = null;
    /** Called when a prompt really starts, after any that were ahead of it. */
    this.onRunStart = null;
    /** Rules this agent must follow, given to it through its CLI's own channel (see system-prompt.mjs). */
    this.rules = spec.systemPrompt ?? null;
    this._injection = null;
    /** Sessions whose first prompt already carried the rules (only for a CLI with no other channel). */
    this.primed = new Set();
  }

  /** How the rules reach this CLI. Worked out once; writes the rules file in agentd's data directory. */
  _inj() {
    return (this._injection ??= injectionFor(this.type, this.rules, this.name));
  }

  _viaRules() {
    const i = this._inj();
    return i.prefix ? 'first message' : i.args.length ? i.args[0] : Object.keys(i.env)[0] ?? (i.meta ? `_meta.${Object.keys(i.meta)[0]}` : null);
  }

  /** The `_meta` of session requests, for the CLIs that take the rules there. */
  _meta() {
    const meta = this._inj().meta;
    return meta ? { _meta: meta } : {};
  }

  /** A CLI with no channel gets the rules in front of the first prompt of a session, and again after a compaction. */
  _withRules(text) {
    if (!this._inj().prefix || !this.sessionId || this.primed.has(this.sessionId)) return text;
    this.primed.add(this.sessionId);
    return `${this.rules.trim()}\n\n---\n\n${text}`;
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
    const inj = this._inj();
    const env = { ...process.env, ...(this.spec.env ?? {}), ...(this.spec.envFn?.() ?? {}), ...inj.env };
    if (this.type === 'pi' && this.spec.defaultCwd) env.AGENTD_BASE_CWD = this.spec.defaultCwd;

    const child = spawn(this.spec.cmd, [...this.spec.args, ...inj.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
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
      if (this.killed.has(child)) return; // already cleaned up by _forceStop
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
      if (msg.error) {
        // The CLI itself answered with an error: that is its message, and it is passed on as it came.
        const err = new Error(msg.error.message ?? JSON.stringify(msg.error));
        err.source = 'cli';
        err.code = msg.error.code;
        reject(err);
      }
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
          // The ACP shape; some adapters (claude) treat anything else as a refusal.
          result: { outcome: picked ? { outcome: 'selected', optionId: picked.optionId } : { outcome: 'cancelled' } },
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
      this._noteSignal(u);
      if (this.run && (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')) {
        if (u.sessionUpdate === 'tool_call') {
          this.run.toolCalls = (this.run.toolCalls ?? 0) + 1;
          this.run.lastTool = u.title ?? u.kind ?? null;
        }
        this._progress(this.run, u.sessionUpdate === 'tool_call');
      }

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
        // Some agents send the arguments and a readable title only in later updates, so each call is followed
        // from its start: the latest title (not a placeholder) and the first arguments that are not empty.
        const done = u.status === 'completed' || u.status === 'failed';
        let tool = null;
        if (u.toolCallId && (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')) {
          tool = run.tools.get(u.toolCallId) ?? {};
          if (u.title && !done && !u.title.endsWith('…')) tool.title = u.title;
          else if (!tool.title && u.title && u.sessionUpdate === 'tool_call') tool.title = u.title;
          const input = inputText(u.rawInput);
          if (input) tool.input = input;
          run.tools.set(u.toolCallId, tool);
        }
        if (u.sessionUpdate === 'tool_call') {
          this._flushPieces(run);
          appendEntry(this.name, run.sessionId, {
            role: 'tool',
            jobId: run.jobId,
            toolCallId: u.toolCallId ?? null,
            title: tool?.title ?? u.title ?? null,
            kind: u.kind ?? null,
            status: u.status ?? 'started',
            input: tool?.input ?? null,
          });
        } else if (
          u.sessionUpdate === 'tool_call_update' &&
          (u.status === 'completed' || u.status === 'failed')
        ) {
          appendEntry(this.name, run.sessionId, {
            role: 'tool',
            jobId: run.jobId,
            toolCallId: u.toolCallId ?? null,
            title: tool?.title ?? null,
            kind: u.kind ?? null,
            status: u.status,
            input: tool?.input ?? null,
            output: outputText(u),
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
    if (run.segAt == null) run.segAt = Date.now();
    run.text += text;
    run.chunks += 1;

    if (run.logFile) {
      try {
        appendFileSync(run.logFile, text, 'utf8');
      } catch {
        /* logging is best-effort */
      }
    }

    this._progress(run);
  }

  /**
   * Tell the front ends the run is alive: at most twice a second, or at once with `force`. Besides the sizes it says
   * which tool is running, so a long task with no text yet does not look hung.
   */
  _progress(run, force = false) {
    const now = Date.now();
    if (!this.progressSink || (!force && now - this._lastProgressAt < 500)) return;
    this._lastProgressAt = now;
    this.progressSink(run.jobId, {
      agent: this.name,
      chars: run.text.length,
      thinkingChars: run.thoughtChars,
      elapsedMs: now - run.startedAt,
      tool: run.lastTool ?? null,
      toolCalls: run.toolCalls ?? 0,
      openTools: this.openTools.size,
    });
  }

  /**
   * Write what the agent has said and thought since the last piece into the transcript, as pieces of their own. Done when
   * a tool call starts and when the run ends, so text, reasoning and tool calls come out in the order they happened (the
   * whole text used to be one entry at the very end, after every tool call).
   */
  _flushPieces(run, extra = {}) {
    if (!run?.sessionId) return;
    const iso = (ms) => (ms ? new Date(ms).toISOString() : undefined);
    const thought = run.thought.slice(run.flushedThought).trim();
    if (thought) {
      appendEntry(this.name, run.sessionId, { role: 'thought', jobId: run.jobId, text: thought.slice(0, 12_000), chars: thought.length, startedAt: iso(run.thoughtAt) });
    }
    run.flushedThought = run.thought.length;
    run.thoughtAt = null;
    const text = run.text.slice(run.flushed).trim();
    if (text) {
      appendEntry(this.name, run.sessionId, { role: 'assistant', jobId: run.jobId, piece: true, text, startedAt: iso(run.segAt), ...extra });
    }
    run.flushed = run.text.length;
    run.segAt = null;
  }

  /** Reasoning text: counted for progress only, never returned as output. */
  _recordThought(text) {
    const run = this.run;
    if (!run) return;
    if (run.firstChunkAt == null) run.firstChunkAt = Date.now();
    if (run.thoughtAt == null) run.thoughtAt = Date.now();
    run.thoughtChars += text.length;
    if (run.thought.length < 20_000) run.thought += text;

    this._progress(run);
  }

  _write(obj) {
    try {
      this.child?.stdin.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      log(`[${this.name}] write failed:`, err.message);
    }
  }

  _request(method, params, { timeoutMs = 300_000, idleMs = null } = {}) {
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
          this._write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: params.sessionId } });
        }
        timer = setTimeout(() => {
          this.pending.delete(id);
          // Still no answer after the grace period: the agent is stuck and would refuse every later prompt as
          // "already in flight". Stop the process; the next task starts a fresh one in the same session.
          if (method === 'session/prompt' && this._forceStop(`no answer ${CANCEL_GRACE_MS / 1000}s after the cancel`)) {
            expired.forced = true;
            expired.message += `; it did not answer the cancel, so its process was stopped (a new one starts with the next task). Check what it was working on before sending the task again`;
          }
          reject(expired);
        }, method === 'session/prompt' ? CANCEL_GRACE_MS : 0);
      };
      if (idleMs) {
        // No fixed deadline. The prompt fails when the agent has said nothing for `idleMs`, and
        // waiting on a running tool (a build, a long command) is not silence. `timeoutMs` stays
        // as the hard ceiling for the whole prompt.
        this.lastSignal = Date.now();
        this.openTools.clear();
        const started = Date.now();
        watch = setInterval(() => {
          if (Date.now() - started > timeoutMs) fail(`ACP ${method} timed out: still running after ${Math.round(timeoutMs / 60000)} min, cancelled`);
          else if (!this.openTools.size && Date.now() - this.lastSignal > idleMs) {
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
      this._write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Any update from the agent is a sign of life; open tool calls mean it is waiting on something. */
  _noteSignal(u) {
    this.lastSignal = Date.now();
    const id = u.toolCallId ?? null;
    if (u.sessionUpdate === 'tool_call' && id && u.status !== 'completed' && u.status !== 'failed') this.openTools.add(id);
    else if (u.sessionUpdate === 'tool_call_update' && id) {
      if (u.status === 'completed' || u.status === 'failed') this.openTools.delete(id);
      else if (u.status === 'in_progress' || u.status === 'pending') this.openTools.add(id);
    }
  }

  /**
   * Kill the process for good, because it ignored a cancel. State is reset here rather than in `close`, so a task
   * that arrives before the old process has finished dying starts a clean one.
   */
  _forceStop(reason) {
    const child = this.child;
    if (!child) return false;
    log(`[${this.name}] stopping the process: ${reason}`);
    this.killed.add(child);
    this.child = null;
    this.initPromise = null;
    this.sessionId = null;
    this.live.clear();
    for (const { reject } of this.pending.values()) {
      const err = new Error(`${this.name} process was stopped`);
      err.forced = true;
      if (this.run?.cancelRequested) err.kind = 'cancelled'; // a person asked it to stop and it did not
      reject(err);
    }
    this.pending.clear();
    killTree(child);
    const now = Date.now();
    this.forcedStops = [...this.forcedStops.filter((t) => now - t < FORCED_STOP_WINDOW_MS), now];
    try {
      this.onForcedStop?.({ agent: this.name, reason, forcedStops: this.forcedStops.length, unstable: this.unstable });
    } catch {
      /* listener errors must not break the pool */
    }
    return true;
  }

  /** Killed too often lately: it gets no more work until `recover()`. */
  get unstable() {
    const now = Date.now();
    return this.forcedStops.filter((t) => now - t < FORCED_STOP_WINDOW_MS).length >= FORCED_STOP_LIMIT;
  }

  /** A person looked at it: forget the recent kills. */
  recover() {
    this.forcedStops = [];
    return { agent: this.name, unstable: false };
  }

  _enqueue(task) {
    return this.line.enqueue(task);
  }

  // The line's state, under the names the rest of the daemon and the tests use.
  get inflight() {
    return this.line.inflight;
  }
  get queuedJobs() {
    return this.line.queuedJobs;
  }
  get cancelledJobs() {
    return this.line.cancelledJobs;
  }
  get earlyCancel() {
    return this.line.earlyCancel;
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
    const stored = saved(this.name, this.sessionId)?.config;
    if (!stored) return [];
    const applied = [];
    for (const [configId, value] of Object.entries(stored)) {
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
    if (saved(this.name, this.sessionId)?.config?.model) return;
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

  /**
   * The instance's model was changed in its settings. That is a deliberate choice, so it replaces
   * what the current session had: applied now when the process is idle, else before the next prompt.
   */
  async chooseModel(value) {
    this.preferModel = value ?? defaultModelFor(this.type);
    const sid = this.sessionId ?? this.preferSession;
    const cfg = sid ? saved(this.name, sid)?.config : null;
    if (cfg?.model) {
      delete cfg.model;
      saveStore();
    }
    if (!this.child || !this.sessionId) return;
    if (this.busy) this.modelDirty = true;
    else await this._applyPreferredModel();
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
    const sess = await this._request('session/new', { cwd: wantCwd, mcpServers: [], ...this._meta() });
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
    const wantCwd = cwd || saved(this.name, sessionId)?.cwd || this.cwd || BASE_CWD;

    if (this.live.has(sessionId)) {
      this.sessionId = sessionId;
      this.cwd = wantCwd;
      if (this.sessionConfig.has(sessionId)) this.configOptions = this.sessionConfig.get(sessionId);
      const reApplied = await this._reapplyStoredConfig();
      return { sessionId, cwd: wantCwd, resumed: false, live: true, reApplied };
    }

    try {
      const res = await this._request('session/resume', { sessionId, cwd: wantCwd, ...this._meta() });
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

  /** Past the configured size, ask the CLI to compact (between runs only). */
  _maybeCompact() {
    return maybeCompact(this);
  }

  /** Front ends register one sink; it receives (jobId, progressPayload). */
  setProgressSink(fn) {
    this.progressSink = fn;
  }

  /**
   * Start a prompt and return `{ jobId, done }` immediately, so the caller can
   * report the job id before the run finishes (async / streaming mode).
   */
  startPrompt(text, { timeoutMs = 300_000, cwd, reset, sessionId, meta = null, display = null } = {}) {
    const jobId = `${this.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const cancelledErr = () => {
      // Cancelled while it waited: it never reaches the CLI.
      const err = new Error('cancelled before it started');
      err.kind = 'cancelled';
      err.metrics = {
        jobId,
        error: err.message,
        outcome: 'cancelled',
        forced: false,
        failureSource: 'agentd',
        health: 'warn',
        attention: [{ code: 'cancelled', severity: 'warn', source: 'system', text: 'the run was cancelled before it started' }],
      };
      return err;
    };
    const { done, ahead } = this.line.submit(jobId, display ?? text, async () => {
      if (this.unstable) {
        const err = new Error(
          `${this.name} is marked unstable: its process had to be killed ${this.forcedStops.length} times in the last ${Math.round(FORCED_STOP_WINDOW_MS / 60_000)} min. ` +
            'It gets no more tasks until a person has looked at it and recovered it.',
        );
        err.kind = 'unstable';
        err.metrics = {
          jobId,
          error: err.message,
          outcome: 'unstable',
          forced: false,
          failureSource: 'agentd',
          health: 'error',
          attention: [{ code: 'unstable', severity: 'error', source: 'system', text: err.message }],
        };
        throw err;
      }
      const run = this._beginRun(jobId);
      try {
        this.onRunStart?.({ jobId });
        if (sessionId && sessionId !== this.sessionId) {
          await this._init();
          await this._attach(sessionId, cwd);
        } else if (reset) {
          this.sessionId = null;
          this.preferSession = null;
        }
        await this.ensureReady(cwd);
        if (this.modelDirty) {
          this.modelDirty = false;
          await this._applyPreferredModel();
        }
        this.streamedText = '';
        run.sessionId = this.sessionId;
        run.model = this.currentModel();
        // Spawning is expected here; only a restart after this point is abnormal.
        run.spawnsAtStart = this.spawnCount;

        appendEntry(this.name, this.sessionId, {
          role: 'user',
          jobId,
          ...meta,
          text: display ?? text,
          model: run.model,
        });

        const res = await this._request(
          'session/prompt',
          { sessionId: this.sessionId, prompt: [{ type: 'text', text: this._withRules(text) }] },
          { timeoutMs: MAX_RUN_MS, idleMs: timeoutMs },
        );

        run.stopReason = res?.stopReason ?? null;
        noteSession(this.name, this.sessionId, { updatedAt: new Date().toISOString() });
        // What is left after the last tool call. The final entry always exists (it carries how the run ended); it
        // has no text when the run ended on a tool call.
        const restThought = run.thought.slice(run.flushedThought).trim();
        if (restThought) {
          appendEntry(this.name, this.sessionId, { role: 'thought', jobId, ...meta, text: restThought.slice(0, 12_000), chars: restThought.length, startedAt: run.thoughtAt ? new Date(run.thoughtAt).toISOString() : undefined });
        }
        appendEntry(this.name, this.sessionId, {
          role: 'assistant',
          jobId,
          ...meta,
          text: run.text.slice(run.flushed).trim(),
          startedAt: run.segAt ? new Date(run.segAt).toISOString() : undefined,
          stopReason: run.stopReason,
          model: run.model,
        });
        const out = {
          text: this.streamedText.trim(),
          stopReason: res?.stopReason,
          sessionId: this.sessionId,
          metrics: this._finishRun(run),
        };
        if (text !== COMPACT_PROMPT[this.type]) setTimeout(() => void this._maybeCompact(), 0);
        return out;
      } catch (err) {
        run.error = err.message;
        run.errorKind = err.kind ?? null;
        run.errorSource = err.source ?? 'agentd'; // 'cli': what the CLI reported; anything else is agentd's own
        run.forced = Boolean(err.forced);
        // Record the failure and any partial answer, so the transcript has no gap.
        this._flushPieces(run);
        appendEntry(this.name, run.sessionId, {
          role: 'error',
          jobId,
          ...meta,
          text: null,
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
    }, cancelledErr);

    return { jobId, done, ahead };
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
      thought: '',
      tools: new Map(),
      // How much of the text and reasoning already went into the transcript as pieces, and when the current piece began.
      flushed: 0,
      flushedThought: 0,
      segAt: null,
      thoughtAt: null,
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

  _metrics(run) {
    return runMetrics(this, run);
  }

  _modelName(value) {
    return modelName(this, value);
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
      // What is not in the transcript yet: the page shows it as the live end of the conversation.
      pendingText: run.text.slice(run.flushed),
      pendingThought: run.thought.slice(run.flushedThought).slice(-3000),
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

    const local = savedAll(this.name);
    const byId = new Map();

    const hidden = (id) => Boolean(local[id]?.hidden);
    for (const s of remote) {
      if (hidden(s.sessionId)) continue;
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
      if (byId.has(id) || meta.hidden) continue;
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
      if (byId.has(id) || hidden(id)) continue;
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

  /**
   * Remove a session from the list. The CLI keeps its own record on disk (there is no API to delete
   * one), so this hides it; the active session cannot be removed.
   */
  deleteSession(sessionId) {
    if (!sessionId) throw new Error('sessionId is required');
    if (sessionId === this.sessionId) throw new Error('cannot delete the active session; switch to another first');
    const e = entry(this.name, sessionId);
    e.hidden = true;
    delete e.label;
    this.live.delete(sessionId);
    saveStore();
    return { sessionId, deleted: true };
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
      sessionLabel: this.sessionId ? (saved(this.name, this.sessionId)?.label ?? null) : null,
      model: this.currentModel(),
      modelName: this._modelName(this.currentModel()),
      cwd: this.cwd,
      defaultCwd: this.spec.defaultCwd ?? null,
      spawns: this.spawnCount,
      liveSessions: [...this.live],
      pid: this.child?.pid ?? null,
      agentInfo: this.agentInfo,
      lastError: this.lastError,
      unstable: this.unstable,
      forcedStops: this.forcedStops.length,
      /** How the rules reach this agent (null: it has none). */
      rules: this.rules ? { via: this._viaRules(), file: this._inj().file } : null,
      lastJobId: lastRun?.jobId ?? null,
      attention: lastAttention,
      health: lastAttention.some((a) => a.severity === 'error')
        ? 'error'
        : lastAttention.some((a) => a.severity === 'warn')
          ? 'warn'
          : 'ok',
    };
  }

  /**
   * Stop a prompt. With a `jobId`, that one only: a run still waiting is dropped before it starts, the running one
   * is asked to stop, one that is already over is left alone. Without, whatever runs now (ACP sends this as a
   * notification).
   */
  cancel(jobId = null) {
    if (jobId) {
      if (this.line.cancelWaiting(jobId)) return { cancelled: true, jobId, queued: true };
      if (this.run?.jobId !== jobId) return { cancelled: false, jobId, reason: 'not running: it is over, or unknown' };
    }
    if (!this.sessionId) return { cancelled: false, reason: 'no active session' };
    this._write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.sessionId } });
    const run = this.run;
    if (run) {
      run.cancelRequested = true;
      const t = setTimeout(() => {
        if (this.run === run) this._forceStop(`no answer ${CANCEL_GRACE_MS / 1000}s after the cancel`);
      }, CANCEL_GRACE_MS);
      t.unref?.();
    }
    return { cancelled: true, sessionId: this.sessionId };
  }

  /** What a page shows with a cancel button: the waiting prompts, oldest first. */
  waitingJobs() {
    return this.line.waiting();
  }

  get busy() {
    return Boolean(this.run);
  }

  async shutdown() {
    if (!this.child) return;
    this.stopping = true;
    try {
      this.child.stdin.end();
      killTree(this.child);
    } catch {
      /* ignore */
    }
    this.child = null;
  }
}
