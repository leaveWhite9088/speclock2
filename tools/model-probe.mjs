/**
 * Probe model / config-option support over ACP.
 *
 * ACP has several candidate methods for this, and implementations vary:
 *   session/set_model
 *   session/set_mode
 *   session/set_config_option
 *
 * Strategy: read what the agent advertises, then try each setter and re-read to
 * see whether the value actually changed.
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

const dump = (label, obj) => {
  console.log(`\n--- ${label} ---`);
  console.log(JSON.stringify(obj, null, 2));
};

console.log(`\n=== model support probe: ${agentName} ===\n`);

const init = await req('initialize', {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
});
dump('initialize.agentCapabilities', init.result?.agentCapabilities);

const sess = await req('session/new', { cwd: CWD, mcpServers: [] });
dump('session/new (full)', sess.result);

const sid = sess.result?.sessionId;
console.log(`\nsessionId = ${sid}`);

const models = sess.result?.models;
const configOptions = sess.result?.configOptions;

/** Options may be flat or grouped: {group, name, options: [...]}. */
const flatten = (opts = []) =>
  opts.flatMap((o) => (Array.isArray(o.options) ? flatten(o.options) : [{ value: o.value, name: o.name }]));

if (models) {
  console.log('\n>>> models advertised by session/new');
}
if (configOptions) {
  console.log('\n>>> configOptions advertised by session/new');
  for (const o of configOptions) {
    const flat = flatten(o.options);
    console.log(`  id=${o.id} category=${o.category} current=${JSON.stringify(o.currentValue)} (${flat.length} options)`);
    for (const opt of flat) console.log(`      - ${JSON.stringify(opt.value)}  (${opt.name})`);
  }
}

// ---- try setters -------------------------------------------------------
const modelOption = configOptions?.find((o) => o.category === 'model' || o.id === 'model');
const modelValues = flatten(modelOption?.options).map((o) => o.value);
const target = modelValues.find((v) => v !== modelOption?.currentValue) ?? modelValues[0];

const effortOption = configOptions?.find((o) => o.category === 'thought_level');
const effortValues = flatten(effortOption?.options).map((o) => o.value);
const effortTarget = effortValues.find((v) => v !== effortOption?.currentValue);

console.log(`\n>>> switch model -> ${JSON.stringify(target)}`);
console.log(`>>> switch effort -> ${JSON.stringify(effortTarget)}`);

const attempts = [
  ['session/set_config_option', { sessionId: sid, configId: modelOption?.id ?? 'model', value: target }],
  ['session/set_config_option', { sessionId: sid, optionId: modelOption?.id ?? 'model', value: target }],
  ['session/set_config_option', { sessionId: sid, configId: modelOption?.id ?? 'model', value: target, name: 'Model' }],
  ['session/set_model', { sessionId: sid, modelId: target }],
  ['session/set_mode', { sessionId: sid, modeId: target }],
];

for (const [method, params] of attempts) {
  const r = await req(method, params, 30000);
  if (r.error) {
    console.log(`✗ ${method} ${JSON.stringify(Object.keys(params))} -> ${r.error.message}`);
  } else {
    console.log(`✓ ${method} ${JSON.stringify(Object.keys(params))} -> ${JSON.stringify(r.result).slice(0, 200)}`);
  }
}

// ---- re-read -----------------------------------------------------------
const again = await req('session/resume', { sessionId: sid, cwd: CWD });
const cfg2 = again.result?.configOptions ?? [];
console.log('\n>>> after attempts, configOptions:');
for (const o of cfg2) {
  console.log(`  ${o.id}: ${JSON.stringify(o.currentValue)}`);
}

// ---- does the model actually change? -----------------------------------
// Ask the agent to identify its model — unreliable but a signal.
const p = await req('session/prompt', {
  sessionId: sid,
  prompt: [{ type: 'text', text: 'Which model are you? Reply with just the model name.' }],
}, 120000);
let text = '';
for (const _ of []) {}
console.log(`prompt stopReason: ${p.result?.stopReason}`);
console.log(`prompt content: ${JSON.stringify(p.result?.content ?? p.error).slice(0, 300)}`);

child.stdin.end();
child.kill();
process.exit(0);
