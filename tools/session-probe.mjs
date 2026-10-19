/**
 * Session admin probe: explore what session management an ACP agent supports.
 *
 * Tests, in order:
 *   session/list     — enumerate sessions (and see what metadata they carry)
 *   session/resume   — reattach to an existing session by id
 *   session/load     — only if the agent advertised loadSession
 *   session/set_*    — probe for title/metadata mutation methods (rename)
 *
 * Usage:
 *   node session-probe.mjs --agent dsh
 *   node session-probe.mjs --agent mcode
 */

import { spawn } from 'node:child_process';

const NODE_BIN = 'D:/Environment/nodejs/node.exe';
const HOME = 'D:/Environment/nodejs/node_modules';

const AGENTS = {
  mcode: { cmd: NODE_BIN, args: [`${HOME}/@minimax-ai/code/cli.js`, 'acp'] },
  dsh: { cmd: NODE_BIN, args: [`${HOME}/@deepseek-ai/dsh/lib/bin.js`, '--profile', 'acp'] },
};

const argv = process.argv.slice(2);
const ai = argv.indexOf('--agent');
const agentName = ai >= 0 ? argv[ai + 1] : 'dsh';
const spec = AGENTS[agentName];
if (!spec) {
  console.error(`unknown agent ${agentName}`);
  process.exit(2);
}

const child = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

const t0 = Date.now();
const el = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
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
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, label } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve({ ok: !msg.error, result: msg.result, error: msg.error, label });
      return;
    }
    if (msg.method && msg.id != null) {
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unsupported' } }) + '\n',
      );
    }
  }
});
child.stderr.on('data', () => {});

function request(method, params, timeoutMs = 60000) {
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: { message: `timeout after ${timeoutMs}ms` }, label: method });
    }, timeoutMs);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, label: method });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const show = (label, r) => {
  if (r.ok) {
    console.log(`${el()} ✓ ${label}`);
    console.log(JSON.stringify(r.result, null, 2).split('\n').slice(0, 40).map((l) => '    ' + l).join('\n'));
  } else {
    console.log(`${el()} ✗ ${label}  →  ${r.error?.message}`);
  }
};

console.log(`\n=== agent: ${agentName} ===\n`);

const init = await request('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
console.log(`${el()} capabilities:`);
console.log(JSON.stringify(init.result?.agentCapabilities ?? init.error, null, 2).replace(/^/gm, '    '));

// --- list ---------------------------------------------------------------
console.log('\n--- session/list ---');
const list = await request('session/list', {});
show('session/list {}', list);

// Some implementations want cwd filtering.
const list2 = await request('session/list', { cwd: 'D:/Project2/code-261013-speclock2/speclock2' });
show('session/list {cwd}', list2);

const sessions =
  list.result?.sessions ?? list2.result?.sessions ?? (Array.isArray(list.result) ? list.result : []);
console.log(`\n=> found ${sessions.length} session(s)`);
for (const s of sessions.slice(0, 10)) {
  console.log('    ', JSON.stringify(s));
}

// --- resume -------------------------------------------------------------
if (sessions.length) {
  const target = sessions[0];
  console.log('\n--- session/resume ---');
  const res = await request('session/resume', { sessionId: target.sessionId });
  show(`session/resume ${target.sessionId}`, res);
}

// --- load (only if advertised) -----------------------------------------
if (init.result?.agentCapabilities?.loadSession && sessions.length) {
  console.log('\n--- session/load ---');
  const res = await request('session/load', {
    sessionId: sessions[0].sessionId,
    cwd: 'D:/Project2/code-261013-speclock2/speclock2',
    mcpServers: [],
  });
  show(`session/load`, res);
}

// --- rename candidates --------------------------------------------------
console.log('\n--- rename candidates (expected to mostly fail) ---');
for (const m of ['session/set_title', 'session/rename', 'session/update', 'session/set_metadata', 'session/metadata']) {
  const r = await request(m, { sessionId: sessions[0]?.sessionId ?? 'x', title: 'probe-title' }, 15000);
  console.log(`${el()} ${r.ok ? '✓' : '✗'} ${m}  →  ${r.ok ? JSON.stringify(r.result).slice(0, 120) : r.error?.message}`);
}

child.stdin.end();
child.kill();
process.exit(0);
