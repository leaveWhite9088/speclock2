/**
 * AcpClient: one resident ACP child per agent. It starts and stops the process, turns a prompt into a run, and puts
 * together the parts that do the rest: the wire (transport), the line prompts wait in (prompt-queue), what a run is
 * made of (run-tracker, runs), the session and model it is on (sessions), the rules it follows (rules-channel) and
 * how often it had to be killed (health).
 */

import { appendEntry } from '../../transcripts.mjs';
import { COMPACT_PROMPT, maybeCompact } from '../compaction.mjs';
import { CANCEL_GRACE_MS, CONFIG, MAX_RUN_MS, log } from '../config.mjs';
import { modelName, runMetrics } from '../metrics.mjs';
import { MAX_PROCESSES, START_ATTEMPTS, aliveCount, withStartLock } from '../registry.mjs';
import { entry, noteSession, saved } from '../store.mjs';
import { StopHealth } from './health.mjs';
import { PromptQueue } from './prompt-queue.mjs';
import { RulesChannel } from './rules-channel.mjs';
import { RunTracker } from './run-tracker.mjs';
import { RunLog, refusedRun } from './runs.mjs';
import { Sessions } from './sessions.mjs';
import { AcpTransport } from './transport.mjs';

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
    this.onSession = spec.onSession ?? null;
    /** Compact the conversation once it holds this many tokens (null: never). Checked when a run ends. */
    this.compactAt = spec.compactAt ?? null;
    this.onCompact = null;
    this._compacting = false;
    /** Last time work was queued or finished, for idle recycling. */
    this.lastActive = Date.now();
    /** Set while we stop the process on purpose, so it is not reported as a crash. */
    this.stopping = false;

    this.transport = new AcpTransport({ name, onNotification: (m) => this._onNotification(m), onClose: (e) => this._onClose(e) });

    this.initPromise = null;

    this.spawnCount = 0;

    this.line = new PromptQueue({ touch: () => (this.lastActive = Date.now()) });
    this.agentInfo = null;
    this.capabilities = null;

    /** Which session it is on, which model and options it has (see sessions.mjs). */
    this.sessions = new Sessions({
      agent: this,
      request: (method, params, opts) => this._request(method, params, opts),
      init: () => this._init(),
      enqueue: (fn) => this._enqueue(fn),
      rulesMeta: () => this.rulesChannel.meta(),
    });

    // -- streaming / metrics --
    /** The runs: the one going on, the last thirty, how long they took. */
    this.runs = new RunLog({ name });
    this.tracker = new RunTracker({ name, getRun: () => this.run });

    /** Called when the agent process exits unexpectedly. */
    this.onExit = null;
    /** How often this process had to be killed because it ignored a cancel; drives the `unstable` flag. */
    this.health = new StopHealth();
    /** Called when a process is killed for ignoring a cancel. */
    this.onForcedStop = null;
    /** Called when a prompt really starts, after any that were ahead of it. */
    this.onRunStart = null;
    /** The rules this agent must follow, given to it through its CLI's own channel. */
    this.rulesChannel = new RulesChannel({ type: this.type, name, spec });
  }

  // The rules, under the names the rest of the daemon and the tests use.
  get rules() {
    return this.rulesChannel.text;
  }

  get primed() {
    return this.rulesChannel.primed;
  }

  _inj() {
    return this.rulesChannel.injection();
  }

  _viaRules() {
    return this.rulesChannel.via();
  }

  _meta() {
    return this.rulesChannel.meta();
  }

  _withRules(text) {
    return this.rulesChannel.withRules(text, this.sessionId);
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
    this.transport.spawn({ cmd: this.spec.cmd, args: [...this.spec.args, ...inj.args], env });
  }

  // The wire's state, under the names the rest of the daemon and the tests use.
  get child() {
    return this.transport.child;
  }
  get stderrTail() {
    return this.transport.stderrTail;
  }
  get lastError() {
    return this.transport.lastError;
  }
  set lastError(v) {
    this.transport.lastError = v;
  }

  /** The process ended by itself (or was replaced by a newer one). */
  _onClose({ code, replaced }) {
    if (replaced) {
      this.stopping = false;
      return;
    }
    const wasRunning = Boolean(this.run);
    this.initPromise = null;
    this.sessions.forgetProcess();
    if (this.stopping) {
      this.stopping = false;
      return;
    }
    try {
      this.onExit?.({ agent: this.name, code, wasRunning, spawns: this.spawnCount });
    } catch {
      /* listener errors must not break the pool */
    }
  }

  /** Something the agent announced: the updates of a run, and a change of the options of the session. */
  _onNotification(msg) {
    if (msg.method !== 'session/update') return;
    const u = msg.params?.update;
    if (!u) return;
    if (u.sessionUpdate === 'config_option_update' && Array.isArray(u.configOptions)) this.configOptions = u.configOptions;
    this.tracker.onUpdate(u);
  }

  _write(obj) {
    this.transport.write(obj);
  }

  _request(method, params, { timeoutMs = 300_000, idleMs = null } = {}) {
    return this.transport.request(method, params, { timeoutMs, idleMs, quiet: this.tracker, forceStop: (reason) => this._forceStop(reason) });
  }

  /**
   * Kill the process for good, because it ignored a cancel. State is reset here rather than in `close`, so a task
   * that arrives before the old process has finished dying starts a clean one.
   */
  _forceStop(reason) {
    if (!this.child) return false;
    log(`[${this.name}] stopping the process: ${reason}`);
    this.initPromise = null;
    this.sessions.forgetProcess();
    this.transport.abandon(() => {
      const err = new Error(`${this.name} process was stopped`);
      err.forced = true;
      if (this.run?.cancelRequested) err.kind = 'cancelled'; // a person asked it to stop and it did not
      return err;
    });
    const now = Date.now();
    this.health.note(now);
    try {
      this.onForcedStop?.({ agent: this.name, reason, forcedStops: this.health.count, unstable: this.unstable });
    } catch {
      /* listener errors must not break the pool */
    }
    return true;
  }

  /** Killed too often lately: it gets no more work until `recover()`. */
  get unstable() {
    return this.health.unstable;
  }

  /** A person looked at it: forget the recent kills. */
  recover() {
    this.health.recover();
    return { agent: this.name, unstable: false };
  }

  _enqueue(task) {
    return this.line.enqueue(task);
  }

  // The run record, under the names the rest of the daemon and the tests use.
  get run() {
    return this.runs.run;
  }
  get jobs() {
    return this.runs.jobs;
  }
  get durationHistory() {
    return this.runs.durationHistory;
  }

  get openTools() {
    return this.tracker.openTools;
  }
  get lastUsage() {
    return this.tracker.lastUsage;
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

  // The session state, under the names the rest of the daemon and the tests use.
  get sessionId() {
    return this.sessions.sessionId;
  }
  set sessionId(v) {
    this.sessions.sessionId = v;
  }
  get cwd() {
    return this.sessions.cwd;
  }
  set cwd(v) {
    this.sessions.cwd = v;
  }
  get preferSession() {
    return this.sessions.preferSession;
  }
  set preferSession(v) {
    this.sessions.preferSession = v;
  }
  get preferModel() {
    return this.sessions.preferModel;
  }
  set preferModel(v) {
    this.sessions.preferModel = v;
  }
  get modelDirty() {
    return this.sessions.modelDirty;
  }
  set modelDirty(v) {
    this.sessions.modelDirty = v;
  }
  get configOptions() {
    return this.sessions.configOptions;
  }
  set configOptions(v) {
    this.sessions.configOptions = v;
  }
  get models() {
    return this.sessions.models;
  }
  get live() {
    return this.sessions.live;
  }

  // -- sessions and models: sessions.mjs does the work -----------------------

  currentModel() {
    return this.sessions.currentModel();
  }
  chooseModel(value) {
    return this.sessions.chooseModel(value);
  }
  ensureReady(cwd) {
    return this.sessions.ensureReady(cwd);
  }
  setConfigOption(configId, value, sessionId) {
    return this.sessions.setConfigOption(configId, value, sessionId);
  }
  describeModels(sessionId) {
    return this.sessions.describeModels(sessionId);
  }
  useSession(sessionId, cwd) {
    return this.sessions.useSession(sessionId, cwd);
  }
  newSession(cwd) {
    return this.sessions.newSession(cwd);
  }
  listSessions() {
    return this.sessions.list();
  }
  deleteSession(sessionId) {
    return this.sessions.remove(sessionId);
  }
  renameSession(sessionId, label) {
    return this.sessions.rename(sessionId, label);
  }

  /**
   * Run a session-management operation in the same order as prompts.
   * Front-end calls can arrive concurrently, so anything that reads or mutates the
   * active session must serialize behind an in-flight prompt.
   */
  serialized(fn) {
    return this._enqueue(fn);
  }

  /**
   * Re-apply the model a session was last given.
   *
   * `mcode` stores the choice in its own session state, but `dsh` resets to the
   * default after a process restart (verified), so we keep our own copy and push
   * it back on resume.
   */
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

  /**
   * The instance's model was changed in its settings. That is a deliberate choice, so it replaces
   * what the current session had: applied now when the process is idle, else before the next prompt.
   */
  /**
   * Attach to an existing session. If it is already live in this process we just
   * retarget the pointer; otherwise resume it from disk.
   */
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
    this.tracker.sink = fn;
  }

  /**
   * Start a prompt and return `{ jobId, done }` immediately, so the caller can
   * report the job id before the run finishes (async / streaming mode).
   */
  startPrompt(text, { timeoutMs = 300_000, cwd, reset, sessionId, meta = null, display = null } = {}) {
    const jobId = `${this.name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const { done, ahead } = this.line.submit(
      jobId,
      display ?? text,
      () => this._runPrompt(jobId, text, { timeoutMs, cwd, reset, sessionId, meta, display }),
      // Cancelled while it waited: it never reaches the CLI.
      () => refusedRun(jobId, 'cancelled', 'cancelled before it started', { health: 'warn', text: 'the run was cancelled before it started' }),
    );
    return { jobId, done, ahead };
  }

  /** Its turn has come: refuse it when the process is unstable, else run it and record how it went. */
  async _runPrompt(jobId, text, opts) {
    if (this.unstable) {
      const message =
        `${this.name} is marked unstable: its process had to be killed ${this.health.count} times in the last ${this.health.windowMinutes} min. ` +
        'It gets no more tasks until a person has looked at it and recovered it.';
      throw refusedRun(jobId, 'unstable', message, { health: 'error', text: message });
    }
    const run = this._beginRun(jobId);
    try {
      this.onRunStart?.({ jobId });
      await this._getReady(run, opts);
      const res = await this._sendPrompt(run, text, opts);
      return this._complete(run, text, res, opts.meta);
    } catch (err) {
      throw this._fail(run, err, opts.meta);
    }
  }

  /** The process up, on the right session (the one asked for, a fresh one, or the remembered one), with its model. */
  async _getReady(run, { sessionId, reset, cwd }) {
    if (sessionId && sessionId !== this.sessionId) {
      await this._init();
      await this.sessions.attach(sessionId, cwd);
    } else if (reset) {
      this.sessionId = null;
      this.preferSession = null;
    }
    await this.ensureReady(cwd);
    if (this.modelDirty) {
      this.modelDirty = false;
      await this.sessions.applyPreferredModel();
    }
    this.tracker.streamedText = '';
    run.sessionId = this.sessionId;
    run.model = this.currentModel();
    // Spawning is expected here; only a restart after this point is abnormal.
    run.spawnsAtStart = this.spawnCount;
  }

  /** Write what was asked into the transcript, give it to the CLI and wait for the end of the turn. */
  async _sendPrompt(run, text, { timeoutMs, meta, display }) {
    appendEntry(this.name, this.sessionId, {
      role: 'user',
      jobId: run.jobId,
      ...meta,
      text: display ?? text,
      model: run.model,
    });
    return this._request(
      'session/prompt',
      { sessionId: this.sessionId, prompt: [{ type: 'text', text: this._withRules(text) }] },
      { timeoutMs: MAX_RUN_MS, idleMs: timeoutMs },
    );
  }

  /** The turn ended well: what is left after the last tool call goes into the transcript, and the caller gets its answer. */
  _complete(run, text, res, meta) {
    const jobId = run.jobId;
    run.stopReason = res?.stopReason ?? null;
    noteSession(this.name, this.sessionId, { updatedAt: new Date().toISOString() });
    // The final entry always exists (it carries how the run ended); it has no text when the run ended on a tool call.
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
      text: this.tracker.streamedText.trim(),
      stopReason: res?.stopReason,
      sessionId: this.sessionId,
      metrics: this._finishRun(run),
    };
    if (text !== COMPACT_PROMPT[this.type]) setTimeout(() => void this._maybeCompact(), 0);
    return out;
  }

  /** The turn failed: what was said so far and the failure go into the transcript, and the error carries the run's metrics. */
  _fail(run, err, meta) {
    run.error = err.message;
    run.errorKind = err.kind ?? null;
    run.errorSource = err.source ?? 'agentd'; // 'cli': what the CLI reported; anything else is agentd's own
    run.forced = Boolean(err.forced);
    // Record the failure and any partial answer, so the transcript has no gap.
    this.tracker.flushPieces(run);
    appendEntry(this.name, run.sessionId, {
      role: 'error',
      jobId: run.jobId,
      ...meta,
      text: null,
      error: err.message,
    });
    // Keep the metrics on the error: a crashed run still produces a receipt with duration, model and inferred attention.
    err.metrics = this._finishRun(run);
    err.sessionId = run.sessionId;
    return err;
  }

  // -- runs / metrics -----------------------------------------------------

  _beginRun(jobId) {
    const run = this.runs.begin(jobId, { sessionId: this.sessionId, model: this.currentModel() });
    this.tracker.lastProgressAt = 0;
    return run;
  }

  _finishRun(run) {
    return this.runs.finish(run, (r) => this._metrics(r));
  }

  _metrics(run) {
    return runMetrics(this, run);
  }

  _modelName(value) {
    return modelName(this, value);
  }

  /** Snapshot for `agent_tail`. */
  tail(jobId) {
    return this.runs.tail(jobId, (r) => this._metrics(r));
  }

  /**
   * Remove a session from the list. The CLI keeps its own record on disk (there is no API to delete
   * one), so this hides it; the active session cannot be removed.
   */
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
      forcedStops: this.health.count,
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
    this.transport.stop();
  }
}
