/**
 * Dump every ACP `session/update` payload an agent emits during one prompt.
 *
 * Goal: find out which agent reports usage tokens, model, timing — and in what
 * shape — so the MCP server can surface metrics consistently.
 */

import { spawn } from 'node:child_process';

const NODE = 'D:/Environment/nodejs/node.exe';
const HOME = 'D:/Environment/nodejs/node_modules';
const CWD = 'D:/Project2/code-261013-speclock2/speclock2';
const LAB = 'D:/Project2/code-261013-speclock2/speclock2';

const AGENTS = {
  mcode: { cmd: NODE, args: [`${HOME}/@minimax-ai/code/cli.js`, 'acp'] },
  dsh: { cmd: NODE, args: [`${HOME}/@deepseek-ai/dsh/lib/bin.js`, '--profile', 'acp'] },
  pi: { cmd: NODE, args: [`${LAB}/server/pi-acp-adapter.mjs`] },
};

const agentName = process.argv[2] || 'dsh';
const spec = AGENTS[agentName];
if (!spec) {
  console.error(`unknown agent: ${agentName}`);
  process.exit(2);
}

const child = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = '';
const pending = new Map();
let nextId = 1;
const seen = new Map();

child.stdout.setEncoding('utf8');
child.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id != null && pending.has(m.id)) {
      const { resolve } = pending.get(m.id);
      pending.delete(m.id);
      resolve(m);
      continue;
    }
    if (m.method === 'session/update') {
      const u = m.params?.update ?? {};
      const kind = u.sessionUpdate ?? '?';
      const n = (seen.get(kind) ?? 0) + 1;
      seen.set(kind, n);
      // print first occurrence of each kind, and every usage-ish one
      const interesting = /usage|info|token|metric|config/i.test(kind);
      if (n === 1 || interesting) {
        console.log(`\n--- [${kind}] #${n} ---`);
        console.log(JSON.stringify(u, null, 2).slice(0, 1600));
      }
    }
    if (m.id != null && m.method) {
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'x' } }) + '\n',
      );
    }
  }
});
child.stderr.on('data', () => {});

const req = (method, params, ms = 180000) =>
  new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => {
      pending.delete(id);
      resolve({ error: { message: 'timeout' } });
    }, ms);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

console.log(`\n=== session/update dump: ${agentName} ===`);

await req('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
const sess = await req('session/new', { cwd: CWD, mcpServers: [] });
const sid = sess.result?.sessionId;
console.log(`session ${sid}`);

const t0 = Date.now();
const r = await req('session/prompt', {
  sessionId: sid,
  prompt: [{ type: 'text', text: 'Count from 1 to 5, one number per line. Nothing else.' }],
});
const ms = Date.now() - t0;

console.log(`\n=== prompt done in ${ms}ms, result: ${JSON.stringify(r.result ?? r.error)} ===`);
console.log(`\nupdate kinds seen: ${[...seen.entries()].map(([k, v]) => `${k}×${v}`).join(', ')}`);

child.stdin.end();
child.kill();
process.exit(0);
