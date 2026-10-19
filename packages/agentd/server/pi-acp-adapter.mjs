#!/usr/bin/env node
/**
 * ACP adapter for pi.
 *
 * pi has no native ACP support: it exposes an "RPC mode" (JSONL commands and
 * events on stdio) instead. This adapter presents a pi process as an ACP agent so
 * agentd can drive it exactly like `mcode` and `dsh`.
 *
 *   agentd  ──ACP──▶  this adapter  ──RPC──▶  pi --mode rpc
 *
 * Method mapping
 *   initialize                  -> handshake, capabilities
 *   session/new                 -> new_session + get_state
 *   session/list                -> local registry (+ sidecar file)
 *   session/resume              -> switch_session {sessionPath}
 *   session/prompt              -> prompt, then wait for agent_settled
 *   session/set_config_option   -> set_model / set_thinking_level
 *   session/close               -> forget the session
 *
 * pi streams `message_update` / `assistantMessageEvent.text_delta`; the adapter
 * forwards those as ACP `session/update` notifications with
 * `sessionUpdate: "agent_message_chunk"`.
 *
 * Spawned with `--no-mcp --no-extensions` on purpose:
 *   - `--no-mcp` prevents recursion (a nested pi would load the same .pi/mcp.json
 *     and could call back into the server that spawned it)
 *   - `--no-extensions` keeps the process from emitting extension UI requests
 *     that this adapter does not render
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_BIN = process.env.PI_NODE_BIN || 'D:/Environment/nodejs/node.exe';
const PI_CLI =
  process.env.PI_CLI ||
  'D:/Environment/nodejs/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js';

const SESSION_DIR =
  process.env.PI_SESSION_DIR ||
  join(dirname(dirname(fileURLToPath(import.meta.url))), 'data', 'pi-sessions');

const MAP_FILE = join(SESSION_DIR, 'acp-session-map.json');
const DEFAULT_CWD = process.env.AGENTD_BASE_CWD || 'D:/Project2/code-261013-speclock2/speclock2';

const log = (...a) => process.stderr.write(`[pi-acp] ${a.join(' ')}\n`);

// ---------------------------------------------------------------------------
// sessionId <-> pi session file
// ---------------------------------------------------------------------------

let map = {};
function loadMap() {
  try {
    if (existsSync(MAP_FILE)) map = JSON.parse(readFileSync(MAP_FILE, 'utf8')) ?? {};
  } catch {
    map = {};
  }
}
function saveMap() {
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(MAP_FILE, JSON.stringify(map, null, 2));
  } catch (err) {
    log('map save failed:', err.message);
  }
}
loadMap();

/**
 * Stable session id = session file name without `.jsonl`.
 *
 * pi's `get_state.sessionId` is scoped to the running process (every id this
 * process produced shared the prefix `01a152f5-`), so it changes when a session
 * is resumed by another process. The file name is stable, so we anchor on it.
 */
const idOf = (file) => {
  const base = basename(file).replace(/\.jsonl$/, '');
  // pi names files `<timestamp>_<uuid>.jsonl`; the uuid part is the readable id.
  const i = base.lastIndexOf('_');
  return i >= 0 ? base.slice(i + 1) : base;
};

/** Find a session file by id when the sidecar lacks the entry. */
function findSessionFile(sessionId) {
  try {
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          const hit = walk(p);
          if (hit) return hit;
        } else if (e.name.includes(sessionId)) {
          return p;
        }
      }
      return null;
    };
    return walk(SESSION_DIR);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// pi RPC client
// ---------------------------------------------------------------------------

class PiRpc {
  constructor() {
    this.child = null;
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.textListeners = [];
    this.settledWaiters = [];
    this.cwd = DEFAULT_CWD;
    this.sessionId = null;
    this.sessionFile = null;
    this.activeAcpId = null;
    this.stderrTail = '';
  }

  ensureStarted(cwd) {
    if (this.child) {
      if (cwd && cwd !== this.cwd) {
        throw new Error(
          `pi adapter is pinned to cwd ${this.cwd}; asked for ${cwd}. ` +
            'Restart agentd with a different AGENTD_BASE_CWD to change it.',
        );
      }
      return;
    }
    this.cwd = cwd || DEFAULT_CWD;

    const args = [
      PI_CLI,
      '--mode',
      'rpc',
      '--no-mcp',
      '--no-extensions',
      '--session-dir',
      SESSION_DIR,
    ];
    log(`spawning pi rpc (cwd=${this.cwd})`);
    const child = spawn(NODE_BIN, args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;

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
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });

    child.on('close', (code) => {
      log(`pi exited (code=${code})`);
      this.child = null;
      for (const { reject } of this.pending.values()) reject(new Error('pi rpc exited'));
      this.pending.clear();
      for (const w of this.settledWaiters.splice(0)) w();
    });
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

    if (rec.type === 'message_update') {
      const ev = rec.assistantMessageEvent;
      if (ev?.type === 'text_delta' && ev.delta) {
        for (const fn of this.textListeners) fn(ev.delta);
      }
      return;
    }

    if (rec.type === 'agent_settled') {
      for (const w of this.settledWaiters.splice(0)) w();
    }
  }

  command(type, params = {}, timeoutMs = 300_000) {
    const id = `rpc-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (rec) => {
          clearTimeout(timer);
          if (!rec.success) reject(new Error(`pi ${type} failed: ${rec.error ?? 'unknown error'}`));
          else resolve(rec.data);
        },
      });
      this.child.stdin.write(JSON.stringify({ id, type, ...params }) + '\n');
    });
  }

  waitSettled(timeoutMs = 600_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.settledWaiters.indexOf(done);
        if (i >= 0) this.settledWaiters.splice(i, 1);
        reject(new Error(`pi run did not settle within ${timeoutMs}ms`));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.settledWaiters.push(done);
    });
  }

  async state() {
    return this.command('get_state', {}, 60_000);
  }
}

const rpc = new PiRpc();

// ---------------------------------------------------------------------------
// ACP config options (model, thinking)
// ---------------------------------------------------------------------------

const THINKING_FALLBACK = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

async function buildConfigOptions() {
  const [modelsData, state] = await Promise.all([
    rpc.command('get_available_models', {}, 60_000).catch(() => ({ models: [] })),
    rpc.state().catch(() => ({})),
  ]);

  const models = modelsData?.models ?? [];
  const cur = state?.model;
  const curValue = cur ? `${cur.provider}/${cur.id}` : null;

  const options = [];
  for (const [id, name] of [
    ['model', 'Model'],
    ['thinking', 'Thinking level'],
  ]) {
    if (id === 'model') {
      options.push({
        id: 'model',
        name,
        category: 'model',
        type: 'select',
        currentValue: curValue,
        options: models.map((m) => ({
          value: `${m.provider}/${m.id}`,
          name: m.name ?? m.id,
          description: `${m.provider}${m.reasoning ? ' · reasoning' : ''}`,
        })),
      });
    } else {
      let levels = THINKING_FALLBACK;
      try {
        const d = await rpc.command('get_available_thinking_levels', {}, 30_000);
        if (Array.isArray(d?.levels) && d.levels.length) levels = d.levels;
      } catch {
        /* keep fallback */
      }
      options.push({
        id: 'thinking',
        name,
        category: 'thought_level',
        type: 'select',
        currentValue: state?.thinkingLevel ?? null,
        options: levels.map((l) => ({ value: l, name: l })),
      });
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// ACP server side
// ---------------------------------------------------------------------------

const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

function emitChunk(sessionId, text) {
  notify('session/update', {
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
}

async function ensureSession(sessionId) {
  rpc.ensureStarted();

  // Already the active session in this process.
  if (rpc.activeAcpId === sessionId && rpc.sessionFile) return;

  const path = map[sessionId] ?? findSessionFile(sessionId);
  if (!path) throw new Error(`unknown session ${sessionId}`);

  const r = await rpc.command('switch_session', { sessionPath: path });
  if (r?.cancelled) throw new Error('pi canceled the session switch');

  const st = await rpc.state();
  rpc.sessionId = st?.sessionId ?? null;
  rpc.sessionFile = path;
  rpc.activeAcpId = sessionId;
  map[sessionId] = path;
  saveMap();
}

async function handle(method, params, id) {
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: 1,
        agentInfo: { name: 'pi', title: 'pi (RPC adapter)', version: '0.1.0' },
        agentCapabilities: {
          sessionCapabilities: { list: {}, resume: {}, close: {} },
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
      });
      return;

    case 'session/new': {
      rpc.ensureStarted(params?.cwd);
      await rpc.command('new_session', {}, 60_000);
      const st = await rpc.state();
      rpc.sessionId = st?.sessionId ?? null;
      rpc.sessionFile = st?.sessionFile ?? null;
      const acpId = st?.sessionFile ? idOf(st.sessionFile) : st.sessionId;
      rpc.activeAcpId = acpId;
      map[acpId] = st?.sessionFile ?? null;
      saveMap();
      log(`new session ${acpId}`);
      reply(id, {
        sessionId: acpId,
        configOptions: await buildConfigOptions(),
      });
      return;
    }

    case 'session/list': {
      // pi has no list command; serve our registry, filtered to files still present.
      const sessions = Object.entries(map)
        .filter(([, file]) => file && existsSync(file))
        .map(([sessionId, file]) => ({ sessionId, cwd: rpc.cwd, _file: file }));
      reply(id, { sessions });
      return;
    }

    case 'session/resume': {
      await ensureSession(params.sessionId);
      reply(id, {
        sessionId: params.sessionId,
        configOptions: await buildConfigOptions(),
      });
      return;
    }

    case 'session/prompt': {
      const sid = params.sessionId;
      const text = (params.prompt ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();
      await ensureSession(sid);

      const onText = (delta) => emitChunk(sid, delta);
      rpc.textListeners.push(onText);

      try {
        const settled = rpc.waitSettled();
        const r = await rpc.command('prompt', { message: text });
        if (r?.disposition !== 'handled') await settled;

        // A brand-new session may not have a file until its first message.
        if (!map[sid]) {
          const st = await rpc.state();
          if (st?.sessionFile) {
            map[sid] = st.sessionFile;
            rpc.sessionFile = st.sessionFile;
            saveMap();
          }
        }

        // ACP's usage_update only carries context size, but pi knows real token
        // counts. Forward them so agentd can report tokens and tok/s.
        try {
          const stats = await rpc.command('get_session_stats', {}, 30_000);
          const ctx = stats?.contextUsage;
          notify('session/update', {
            sessionId: sid,
            update: {
              sessionUpdate: 'usage_update',
              used: ctx?.tokens ?? null,
              size: ctx?.contextWindow ?? null,
              tokens: stats?.tokens ?? null,
              cost: stats?.cost != null ? { amount: stats.cost, currency: 'USD' } : null,
            },
          });
        } catch (err) {
          log(`stats unavailable: ${err.message}`);
        }

        reply(id, { stopReason: 'end_turn' });
      } finally {
        const i = rpc.textListeners.indexOf(onText);
        if (i >= 0) rpc.textListeners.splice(i, 1);
      }
      return;
    }

    case 'session/set_config_option': {
      await ensureSession(params.sessionId);
      const { configId, value } = params;

      if (configId === 'model') {
        const slash = String(value).indexOf('/');
        if (slash < 1) throw new Error(`model value must be "provider/model", got ${value}`);
        const provider = String(value).slice(0, slash);
        const modelId = String(value).slice(slash + 1);
        await rpc.command('set_model', { provider, modelId }, 60_000);
      } else if (configId === 'thinking') {
        await rpc.command('set_thinking_level', { level: value }, 60_000);
      } else {
        throw new Error(`unsupported configId: ${configId}`);
      }

      reply(id, { configOptions: await buildConfigOptions() });
      return;
    }

    case 'session/close': {
      delete map[params.sessionId];
      saveMap();
      reply(id, {});
      return;
    }

    default:
      replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buf = '';
let inflight = 0;
let ended = false;

function maybeExit() {
  if (ended && inflight === 0) {
    try {
      rpc.child?.stdin.end();
      rpc.child?.kill();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    inflight++;
    handle(msg.method, msg.params, msg.id)
      .catch((err) => {
        log(`${msg.method} failed: ${err.message}`);
        if (msg.id != null) replyError(msg.id, -32603, err.message);
      })
      .finally(() => {
        inflight--;
        maybeExit();
      });
  }
});

process.stdin.on('end', () => {
  ended = true;
  maybeExit();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      rpc.child?.stdin.end();
      rpc.child?.kill();
    } catch {}
    process.exit(0);
  });
}

log('ready');
