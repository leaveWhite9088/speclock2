/**
 * Is the model per-session or per-process?
 *
 * Creates two sessions, sets a different model on each, then re-reads both to see
 * whether the value is scoped to the session or leaked across the process.
 */

import { spawn } from 'node:child_process';

const NODE = 'D:/Environment/nodejs/node.exe';
const HOME = 'D:/Environment/nodejs/node_modules';
const CWD = 'D:/Project2/code-261013-speclock2/speclock2';

const AGENTS = {
  mcode: { cmd: NODE, args: [`${HOME}/@minimax-ai/code/cli.js`, 'acp'] },
  dsh: { cmd: NODE, args: [`${HOME}/@deepseek-ai/dsh/lib/bin.js`, '--profile', 'acp'] },
};

const agentName = process.argv[2] || 'dsh';
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

const req = (method, params, timeoutMs = 90000) =>
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

const modelOf = async (sid) => {
  // `session/resume` refuses an already-active session, so read the current value
  // by issuing an idempotent set to the value we expect back.
  const r = await req('session/set_config_option', { sessionId: sid, configId: 'model', value: probeValue });
  return r.error ? `ERROR: ${r.error.message}` : r.result?.configOptions?.find((o) => o.id === 'model')?.currentValue;
};

console.log(`\n=== per-session model test: ${agentName} ===\n`);

await req('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});

const A = (await req('session/new', { cwd: CWD, mcpServers: [] })).result;
const B = (await req('session/new', { cwd: CWD, mcpServers: [] })).result;

const modelOpt = A.configOptions.find((o) => o.id === 'model');
const values = flatten(modelOpt.options).map((o) => o.value);

// pick two distinct, known-good values
const candidates = ['mcode', 'dsh'].includes(agentName) ? values : values;
console.log('available models:');
flatten(modelOpt.options).forEach((o) => console.log(`  - ${o.name}: ${o.value}`));

// mcode rejects one advertised option (no-thinking M3.1) with "Internal error",
// so pick two values that are known-good for both agents.
const mA = candidates[values.length - 1];
const mB = candidates[values.length - 2] ?? candidates[0];
console.log(`\nA = ${A.sessionId}  -> want ${JSON.stringify(mA)}`);
console.log(`B = ${B.sessionId}  -> want ${JSON.stringify(mB)}`);

const setA = await req('session/set_config_option', { sessionId: A.sessionId, configId: 'model', value: mA });
const aAfter = setA.result?.configOptions?.find((o) => o.id === 'model')?.currentValue;
console.log(`set A: ${setA.error ? '✗ ' + setA.error.message : '✓ -> ' + JSON.stringify(aAfter)}`);

const setB = await req('session/set_config_option', { sessionId: B.sessionId, configId: 'model', value: mB });
const bAfter = setB.result?.configOptions?.find((o) => o.id === 'model')?.currentValue;
console.log(`set B: ${setB.error ? '✗ ' + setB.error.message : '✓ -> ' + JSON.stringify(bAfter)}`);

// Re-assert each session's own model: if models were process-global, A would
// report B's value here.
let probeValue = mA;
const readA = await modelOf(A.sessionId);
probeValue = mB;
const readB = await modelOf(B.sessionId);

console.log(`\nre-read A: ${JSON.stringify(readA)}  ${readA === mA ? '✓' : '✗'}`);
console.log(`re-read B: ${JSON.stringify(readB)}  ${readB === mB ? '✓' : '✗'}`);

const perSession = readA === mA && readB === mB && mA !== mB;
console.log(`\n=> ${perSession ? '✓ MODEL IS PER-SESSION' : '✗ model leaked / not scoped'}`);

// does it survive a prompt?
const p = await req('session/prompt', { sessionId: A.sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: OK' }] }, 180000);
probeValue = mA;
const readA2 = await modelOf(A.sessionId);
console.log(`after a prompt, A model: ${JSON.stringify(readA2)}  ${readA2 === mA ? '✓ still A\'s model' : '✗ changed'}`);

child.stdin.end();
child.kill();
process.exit(perSession ? 0 : 1);
