/**
 * Generic ACP probe. Drives any ACP agent over stdio and prints the transcript.
 *
 * Usage:
 *   node acp-probe.mjs --agent mcode "prompt" [rounds]
 *   node acp-probe.mjs --agent dsh   "prompt" [rounds]
 *   node acp-probe.mjs --cmd "<exe>" --args-json '["cli.js","acp"]' "prompt"
 *
 * Keeps stdin open so the agent process stays alive across requests — that is
 * exactly what piped input fails to do.
 */

import { spawn } from 'node:child_process';

const NODE_BIN = process.env.MCODE_NODE_BIN || 'D:/Environment/nodejs/node.exe';

const AGENTS = {
  mcode: {
    cmd: NODE_BIN,
    args: ['D:/Environment/nodejs/node_modules/@minimax-ai/code/cli.js', 'acp'],
  },
  dsh: {
    cmd: NODE_BIN,
    args: ['D:/Environment/nodejs/node_modules/@deepseek-ai/dsh/lib/bin.js', '--profile', 'acp'],
  },
  pi: {
    cmd: NODE_BIN,
    args: ['D:/Project2/code-261013-speclock2/speclock2/packages/agentd/server/pi-acp-adapter.mjs'],
  },
};

// --- parse argv -----------------------------------------------------------

const argv = process.argv.slice(2);
let agentName = 'mcode';
let cmd = null;
let argsJson = null;
const rest = [];

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--agent') agentName = argv[++i];
  else if (argv[i] === '--cmd') cmd = argv[++i];
  else if (argv[i] === '--args-json') argsJson = argv[++i];
  else rest.push(argv[i]);
}

const spec = AGENTS[agentName];
if (!spec && !cmd) {
  console.error(`unknown agent "${agentName}"; known: ${Object.keys(AGENTS).join(', ')}`);
  process.exit(2);
}

const spawnCmd = cmd || spec.cmd;
const spawnArgs = argsJson ? JSON.parse(argsJson) : spec.args;
const PROMPT = rest[0] || 'Reply with exactly: PONG';
const ROUNDS = Number(rest[1] || 2);
const CWD = process.env.ACP_CWD || 'D:/Project2/code-261013-speclock2/speclock2';

// --- spawn ----------------------------------------------------------------

const child = spawn(spawnCmd, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

const t0 = Date.now();
const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(2)}s`;

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
      console.log(`${elapsed()} [non-json] ${line.slice(0, 160)}`);
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, label } = pending.get(msg.id);
      pending.delete(msg.id);
      console.log(`${elapsed()} <- ${label} RESULT`);
      resolve(msg.result ?? msg.error);
    } else if (msg.method) {
      const kind = msg.id != null ? 'REQ ' : 'NOTE';
      const u = msg.params?.update;
      const text =
        msg.method === 'session/update'
          ? `${u?.sessionUpdate ?? '?'} ${(u?.content?.text ?? u?.title ?? '').slice(0, 60)}`
          : JSON.stringify(msg.params ?? {}).slice(0, 100);
      console.log(`${elapsed()} <- ${kind} ${msg.method} ${text}`);
      // Answer server-initiated permission requests so nothing hangs.
      if (msg.id != null && msg.method === 'session/request_permission') {
        const opts = msg.params?.options ?? [];
        const pick = opts.find((o) => /allow/i.test(o.kind ?? o.optionId ?? '')) ?? opts[0];
        child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: pick ? { optionId: pick.optionId } : {} }) + '\n',
        );
      }
    }
  }
});

child.stderr.setEncoding('utf8');
if (process.env.ACP_STDERR === '1') {
  child.stderr.on('data', (d) => process.stdout.write(`[stderr] ${d}`));
}

child.on('error', (e) => console.log(`[spawn error] ${e.message}`));

function request(method, params, label = method) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, { resolve, label });
    console.log(`${elapsed()} -> ${label}`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

// --- run ------------------------------------------------------------------

console.log(`agent: ${agentName}  cwd: ${CWD}`);

const init = await request(
  'initialize',
  { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } } },
  'initialize',
);
console.log(`${elapsed()}    agent: ${init?.agentInfo?.name} ${init?.agentInfo?.version}`);

const sess = await request('session/new', { cwd: CWD, mcpServers: [] }, 'session/new');
const sessionId = sess?.sessionId;
console.log(`${elapsed()}    sessionId: ${sessionId}`);

let total = 0;
for (let r = 1; r <= ROUNDS; r++) {
  const start = Date.now();
  const res = await request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text: PROMPT }] },
    `session/prompt #${r}`,
  );
  total += Date.now() - start;
  console.log(
    `${elapsed()}    #${r} (${Date.now() - start}ms) stop=${res?.stopReason} content=${JSON.stringify(res?.content ?? res).slice(0, 100)}`,
  );
}
console.log(`total prompt time: ${total}ms`);

child.stdin.end();
child.kill();
process.exit(0);
