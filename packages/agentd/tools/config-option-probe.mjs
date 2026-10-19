/**
 * Exhaustive `session/set_config_option` test.
 *
 * mcode returns "Internal error" for some values, so try every advertised option
 * and report which ones the agent actually accepts.
 */

import { spawn } from 'node:child_process';

const NODE = 'D:/Environment/nodejs/node.exe';
const HOME = 'D:/Environment/nodejs/node_modules';
const CWD = 'D:/Project2/code-261013-speclock2/speclock2';

const AGENTS = {
  mcode: { cmd: NODE, args: [`${HOME}/@minimax-ai/code/cli.js`, 'acp'] },
  dsh: { cmd: NODE, args: [`${HOME}/@deepseek-ai/dsh/lib/bin.js`, '--profile', 'acp'] },
};

const agentName = process.argv[2] || 'mcode';
const spec = AGENTS[agentName];

const child = spawn(spec.cmd, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buf = '';
const pending = new Map();
let nextId = 1;

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
    } else if (m.id != null && m.method) {
      child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unsupported' } }) + '\n',
      );
    }
  }
});
child.stderr.on('data', () => {});

const req = (method, params, timeoutMs = 60000) =>
  new Promise((resolve) => {
    const id = nextId++;
    const t = setTimeout(() => {
      pending.delete(id);
      resolve({ error: { message: 'timeout' } });
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(t);
        resolve(v);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

const flatten = (opts = []) =>
  opts.flatMap((o) => (Array.isArray(o.options) ? flatten(o.options) : [{ value: o.value, name: o.name }]));

console.log(`\n=== exhaustive set_config_option: ${agentName} ===\n`);

await req('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});

const sess = await req('session/new', { cwd: CWD, mcpServers: [] });
const sid = sess.result.sessionId;
const opts = sess.result.configOptions ?? [];

console.log(`sessionId ${sid}`);
console.log(`options: ${opts.map((o) => `${o.id}(${o.category})`).join(', ')}\n`);

for (const opt of opts) {
  const values = flatten(opt.options);
  console.log(`\n### ${opt.id}  current=${JSON.stringify(opt.currentValue)}`);
  for (const v of values) {
    const r = await req('session/set_config_option', {
      sessionId: sid,
      configId: opt.id,
      value: v.value,
    }, 30000);

    if (r.error) {
      console.log(`  ✗ ${v.name.padEnd(34)} ${JSON.stringify(v.value).slice(0, 52)} -> ${r.error.message}`);
    } else {
      const now = (r.result?.configOptions ?? []).find((o) => o.id === opt.id)?.currentValue;
      const ok = now === v.value;
      console.log(`  ${ok ? '✓' : '~'} ${v.name.padEnd(34)} ${JSON.stringify(v.value).slice(0, 52)} -> current=${JSON.stringify(now).slice(0, 52)}`);
    }
  }
  // restore
  if (opt.currentValue != null) {
    await req('session/set_config_option', { sessionId: sid, configId: opt.id, value: opt.currentValue }, 30000);
  }
}

const back = await req('session/resume', { sessionId: sid, cwd: CWD });
console.log('\nfinal configOptions:');
for (const o of back.result?.configOptions ?? []) console.log(`  ${o.id}: ${JSON.stringify(o.currentValue)}`);

child.stdin.end();
child.kill();
process.exit(0);
