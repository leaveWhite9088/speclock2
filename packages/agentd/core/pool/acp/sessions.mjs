/**
 * Which session an executor's process is on, and which model and options it has: starting one, going back to one,
 * switching, naming, hiding, listing; picking the model and remembering what a session was given (a CLI may forget it
 * when its process restarts). It owns that state. It reaches the process only through the functions it is given, and
 * what it needs to know about the executor through `agent` (its name, type, directory, whether it works).
 */

import { BASE_CWD, CONFIG, flattenOptions, log, normPath } from '../config.mjs';
import { defaultModelFor, ownedByInstance } from '../registry.mjs';
import { entry, noteSession, saveStore, saved, savedAll } from '../store.mjs';

export class Sessions {
  /**
   * @param {{
   *   agent: { name: string, type: string, custom: boolean, spec: any, child: any, busy: boolean, onSession?: (id: string) => void },
   *   request: (method: string, params: object, opts?: object) => Promise<any>,   // to the CLI
   *   init: () => Promise<any>,                                                    // the process is up
   *   enqueue: <T>(fn: () => Promise<T>) => Promise<T>,                            // in line with the prompts
   *   rulesMeta: () => object,                                                     // `_meta` for session requests
   * }} deps
   */
  constructor({ agent, request, init, enqueue, rulesMeta }) {
    this.agent = agent;
    this.request = request;
    this.init = init;
    this.enqueue = enqueue;
    this.rulesMeta = rulesMeta;
    const spec = agent.spec;
    /** The session it is on, or null before the first use and after the process went away. */
    this.sessionId = null;
    /** Where it works. Before the first start this is the directory it will start in, not the global base. */
    this.cwd = spec.defaultCwd || BASE_CWD;
    /** Session to come back to: the one chosen at creation, then whichever was last active. */
    this.preferSession = spec.sessionId ?? null;
    /** Model this instance should use (config value); applied to sessions that have no choice of their own. */
    this.preferModel = spec.model ?? CONFIG?.defaultModels?.[spec.type ?? agent.name] ?? null;
    /** The model was changed in the settings while it worked: applied before the next prompt. */
    this.modelDirty = false;
    this.models = null;
    /**
     * Sessions known to be live in this process. `dsh` keeps every session it created active, so `session/resume` on
     * one of them fails with "session is already active". Tracking them lets us switch by simply pointing `sessionId`
     * at the right one.
     */
    this.live = new Set();
    this.sessionConfig = new Map();
    /** Latest `configOptions` for the active session (model, effort, permissions). */
    this.configOptions = [];
  }

  /** The process is gone: nothing is live in it any more. The remembered session stays, to come back to. */
  forgetProcess() {
    this.sessionId = null;
    this.live.clear();
  }

  /** Record the config options returned by session/new, resume or set_config_option. */
  captureConfig(result) {
    const opts = result?.configOptions;
    if (Array.isArray(opts)) this.configOptions = opts;
  }

  /** Current model id, if the agent exposes one. */
  currentModel() {
    return this.configOptions?.find((o) => o.id === 'model')?.currentValue ?? null;
  }

  async reapplyStoredConfig() {
    const stored = saved(this.agent.name, this.sessionId)?.config;
    if (!stored) return [];
    const applied = [];
    for (const [configId, value] of Object.entries(stored)) {
      const opt = this.configOptions?.find((o) => o.id === configId);
      if (!opt || opt.currentValue === value) continue;
      try {
        const r = await this.request('session/set_config_option', {
          sessionId: this.sessionId,
          configId,
          value,
        });
        this.captureConfig(r);
        applied.push({ configId, value });
        log(`[${this.agent.name}] re-applied ${configId}=${value}`);
      } catch (err) {
        log(`[${this.agent.name}] could not re-apply ${configId}: ${err.message}`);
      }
    }
    return applied;
  }

  /** Remember which session is active, so a recycled process comes back to it. */
  noteActive() {
    if (!this.sessionId || this.preferSession === this.sessionId) return;
    this.preferSession = this.sessionId;
    try {
      this.agent.onSession?.(this.sessionId);
    } catch (err) {
      log(`[${this.agent.name}] onSession failed: ${err.message}`);
    }
  }

  /** Give a session the instance's model unless it already has a choice of its own. */
  async applyPreferredModel() {
    const want = this.preferModel;
    const opt = this.configOptions?.find((o) => o.id === 'model');
    if (!want || !opt || opt.currentValue === want || !this.sessionId) return;
    if (saved(this.agent.name, this.sessionId)?.config?.model) return;
    try {
      const r = await this.request('session/set_config_option', {
        sessionId: this.sessionId,
        configId: 'model',
        value: want,
      });
      this.captureConfig(r);
      const meta = entry(this.agent.name, this.sessionId);
      meta.config = { ...(meta.config ?? {}), model: want };
      if (!meta.cwd) meta.cwd = this.cwd;
      saveStore();
      log(`[${this.agent.name}] applied instance model ${want}`);
    } catch (err) {
      log(`[${this.agent.name}] could not apply instance model ${want}: ${err.message}`);
    }
  }

  async chooseModel(value) {
    this.preferModel = value ?? defaultModelFor(this.agent.type);
    const sid = this.sessionId ?? this.preferSession;
    const cfg = sid ? saved(this.agent.name, sid)?.config : null;
    if (cfg?.model) {
      delete cfg.model;
      saveStore();
    }
    if (!this.agent.child || !this.sessionId) return;
    if (this.agent.busy) this.modelDirty = true;
    else await this.applyPreferredModel();
  }

  /** Init + ensure an active session for `cwd`. */
  async ensureReady(cwd) {
    await this.init();
    const wantCwd = cwd || this.agent.spec.defaultCwd || this.cwd || BASE_CWD;
    if (this.sessionId && wantCwd === this.cwd) return this.sessionId;

    // First use after a (re)start: go back to the chosen / last active session.
    if (!this.sessionId && this.preferSession) {
      try {
        await this.attach(this.preferSession, wantCwd);
        return this.sessionId;
      } catch (err) {
        log(`[${this.agent.name}] could not resume ${this.preferSession}: ${err.message}; starting a new session`);
        this.preferSession = null;
      }
    }

    const t0 = Date.now();
    const sess = await this.request('session/new', { cwd: wantCwd, mcpServers: [], ...this.rulesMeta() });
    this.sessionId = sess?.sessionId;
    this.cwd = wantCwd;
    if (this.sessionId) this.live.add(this.sessionId);
    this.captureConfig(sess);
    this.sessionConfig.set(this.sessionId, this.configOptions);
    noteSession(this.agent.name, this.sessionId, { cwd: wantCwd, updatedAt: new Date().toISOString() });
    log(`[${this.agent.name}] new session ${this.sessionId} in ${Date.now() - t0}ms`);
    await this.applyPreferredModel();
    this.noteActive();
    return this.sessionId;
  }

  async attach(sessionId, cwd) {
    const res = await this.attachRaw(sessionId, cwd);
    await this.applyPreferredModel();
    this.noteActive();
    return res;
  }

  async attachRaw(sessionId, cwd) {
    const wantCwd = cwd || saved(this.agent.name, sessionId)?.cwd || this.cwd || BASE_CWD;

    if (this.live.has(sessionId)) {
      this.sessionId = sessionId;
      this.cwd = wantCwd;
      if (this.sessionConfig.has(sessionId)) this.configOptions = this.sessionConfig.get(sessionId);
      const reApplied = await this.reapplyStoredConfig();
      return { sessionId, cwd: wantCwd, resumed: false, live: true, reApplied };
    }

    try {
      const res = await this.request('session/resume', { sessionId, cwd: wantCwd, ...this.rulesMeta() });
      this.sessionId = res?.sessionId ?? sessionId;
      this.cwd = wantCwd;
      this.models = res?.models ?? this.models;
      this.live.add(this.sessionId);
      this.captureConfig(res);
      this.sessionConfig.set(this.sessionId, this.configOptions);
      noteSession(this.agent.name, this.sessionId, { cwd: wantCwd, updatedAt: new Date().toISOString() });
      const reApplied = await this.reapplyStoredConfig();
      return { sessionId: this.sessionId, cwd: wantCwd, resumed: true, live: true, reApplied };
    } catch (err) {
      // Some agents report an already-active session instead of resuming it.
      if (/already active/i.test(err.message)) {
        this.sessionId = sessionId;
        this.cwd = wantCwd;
        this.live.add(sessionId);
        const reApplied = await this.reapplyStoredConfig();
        return { sessionId, cwd: wantCwd, resumed: false, live: true, reApplied };
      }
      throw err;
    }
  }

  /** Set a config option (model, effort, permission) for a session and remember it. */
  async setConfigOption(configId, value, sessionId) {
    return this.enqueue(async () => {
      await this.init();
      if (sessionId && sessionId !== this.sessionId) await this.attach(sessionId);
      else if (!this.sessionId) await this.ensureReady();

      const r = await this.request('session/set_config_option', {
        sessionId: this.sessionId,
        configId,
        value,
      });
      this.captureConfig(r);

      const meta = entry(this.agent.name, this.sessionId);
      meta.config = { ...(meta.config ?? {}), [configId]: value };
      if (!meta.cwd) meta.cwd = this.cwd;
      saveStore();

      return { sessionId: this.sessionId, configOptions: this.configOptions };
    });
  }

  /** Describe the config options and their current values for a session. */
  async describeModels(sessionId) {
    return this.enqueue(async () => {
      await this.init();
      if (sessionId && sessionId !== this.sessionId) await this.attach(sessionId);
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
    return this.enqueue(async () => {
      await this.init();
      return this.attach(sessionId, cwd);
    });
  }

  async newSession(cwd) {
    return this.enqueue(async () => {
      await this.init();
      this.sessionId = null;
      this.preferSession = null; // an explicit "new" must not fall back to the remembered session
      return this.ensureReady(cwd);
    });
  }

  /** `session/list`; merged with local labels. */
  async list() {
    await this.init();
    let remote = [];
    let remoteError = null;
    try {
      const res = await this.request('session/list', {}, { timeoutMs: 60_000 });
      remote = res?.sessions ?? (Array.isArray(res) ? res : []);
    } catch (err) {
      remoteError = err.message;
    }

    const local = savedAll(this.agent.name);
    const byId = new Map();

    const hidden = (id) => Boolean(local[id]?.hidden);
    for (const s of remote) {
      if (hidden(s.sessionId)) continue;
      // An agent lists every session of its CLI. A custom instance only owns the
      // ones in its own directory, so two instances of one CLI do not mix.
      if (this.agent.custom && s.cwd && normPath(s.cwd) !== normPath(this.agent.spec.defaultCwd)) continue;
      // The built-in instance leaves out the sessions that belong to a created one.
      if (!this.agent.custom && s.cwd && ownedByInstance(this.agent, s.cwd)) continue;
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

  remove(sessionId) {
    if (!sessionId) throw new Error('sessionId is required');
    if (sessionId === this.sessionId) throw new Error('cannot delete the active session; switch to another first');
    const e = entry(this.agent.name, sessionId);
    e.hidden = true;
    delete e.label;
    this.live.delete(sessionId);
    saveStore();
    return { sessionId, deleted: true };
  }

  rename(sessionId, label) {
    const id = sessionId || this.sessionId;
    if (!id) throw new Error('no active session to rename');
    const e = entry(this.agent.name, id);
    if (label === null || label === '') delete e.label;
    else e.label = label;
    if (!e.cwd) e.cwd = this.cwd;
    saveStore();
    return { sessionId: id, label: e.label ?? null };
  }
}
