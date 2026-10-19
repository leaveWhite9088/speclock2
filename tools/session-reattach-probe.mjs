/**
 * Test whether an existing session can be reattached, and how.
 *
 * Strategy per agent:
 *  1. create a session, send a prompt that sets context ("remember X")
 *  2. list sessions to find it
 *  3. spawn a FRESH agent process, attach to that session id
 *  4. prompt "what did I ask you to remember?" — if it answers X, reattach works
 *
 * This is the real test of session switching: it must survive a process restart.
 */

import { spawn } from 'node:child_process';

const NODE_BIN = 'D:/Environment/nodejs/node.exe';
const HOME = 'D:/Environment/nodejs/node_modules';
const CWD = 'D:/Project2/code-261013-speclock2/speclock2';

const AGENTS = {
  mcode: { cmd: NODE_BIN, args: [`${HOME}/@minimax-ai/code/cli.js`, 'acp'] },
  dsh: { cmd: NODE_BIN, args: [`${HOME}/@deepseek-ai/dsh/lib/bin.js`, '--profile', 'acp'] },
};

const agentName = process.argv[2] || 'mcode';
const spec = AGENTS[agentName];

class Conn {
  constructor() {
    this.child = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.text = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (c) => {
      this.buf += c;
      let i;
      while ((i = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this._on(line);
      }
    });
    this.child.stderr.on('data', () => {});
  }
  _on(line) {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id != null && this.pending.has(m.id)) {
      const { resolve } = this.pending.get(m.id);
      this.pending.delete(m.id);
      resolve(m.error ? { ok: false, error: m.error } : { ok: true, result: m.result });
      return;
    }
    if (m.method === 'session/update') {
      const u = m.params?.update;
      if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.text) this.text += u.content.text;
    }
    if (m.id != null && m.method) {
      this.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unsupported' } }) + '\n',
      );
    }
  }
  req(method, params, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { message: 'timeout' } });
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
      });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async init() {
    return this.req('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
  }
  async prompt(sessionId, text) {
    this.text = '';
    const r = await this.req('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    return { ...r, text: this.text.trim() };
  }
  kill() {
    try {
      this.child.stdin.end();
      this.child.kill();
    } catch {}
  }
}

const log = (...a) => console.log(...a);

log(`\n=== ${agentName}: session reattach across process restart ===\n`);

// --- 1. create a session and seed it -------------------------------------
const a = new Conn();
const initA = await a.init();
log(`init A: ${JSON.stringify(initA.result?.agentInfo)} caps=${JSON.stringify(initA.result?.agentCapabilities?.sessionCapabilities ?? {})} loadSession=${initA.result?.agentCapabilities?.loadSession}`);

const s1 = await a.req('session/new', { cwd: CWD, mcpServers: [] });
const sid = s1.result?.sessionId;
log(`session/new -> ${sid}`);

const seed = await a.prompt(sid, 'Remember the codeword PINEAPPLE. Reply with just OK.');
log(`seed prompt -> ${JSON.stringify(seed.text)}`);

// list to confirm title/metadata
const lst = await a.req('session/list', {});
const found = (lst.result?.sessions ?? []).find((s) => s.sessionId === sid);
log(`list entry -> ${JSON.stringify(found)}`);

a.kill();
await new Promise((r) => setTimeout(r, 800));
log('--- process A killed, starting fresh process B ---');

// --- 2. fresh process, try to reattach -----------------------------------
const b = new Conn();
await b.init();

const attempts = [
  ['session/resume', { sessionId: sid }],
  ['session/resume', { sessionId: sid, cwd: CWD }],
  ['session/resume', { sessionId: sid, cwd: CWD, mcpServers: [] }],
  ['session/load', { sessionId: sid, cwd: CWD, mcpServers: [] }],
  ['session/load', { sessionId: sid }],
];

let attached = null;
for (const [method, params] of attempts) {
  const r = await b.req(method, params, 60000);
  const label = `${method} ${JSON.stringify(Object.keys(params))}`;
  if (r.ok) {
    log(`✓ ${label} -> ${JSON.stringify(r.result).slice(0, 160)}`);
    attached = { method, params, result: r.result };
    break;
  } else {
    log(`✗ ${label} -> ${r.error?.message}${r.error?.data ? ' ' + JSON.stringify(r.error.data).slice(0, 120) : ''}`);
  }
}

// --- 3. verify the reattached session remembers -------------------------
if (attached) {
  const sid2 = attached.result?.sessionId ?? sid;
  const check = await b.prompt(sid2, 'What codeword did I ask you to remember? Reply with just that word.');
  log(`\nrecall via ${attached.method} (session ${sid2}): ${JSON.stringify(check.text)}`);
  log(check.text.toUpperCase().includes('PINEAPPLE') ? '=> ✓ CONTEXT RESTORED' : '=> ✗ context NOT restored');
} else {
  log('\n=> no reattach method worked on a fresh process');
}

b.kill();
process.exit(0);
