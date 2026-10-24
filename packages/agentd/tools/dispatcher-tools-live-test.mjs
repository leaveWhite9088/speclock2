/**
 * The dispatcher's extension, live: a real pi loads it and a real model uses one of its tools. Run it with
 * tools/run-isolated.mjs (a private daemon); a few hundred tokens.
 *
 * Checks:
 *   1. pi loads the extension (it is several files) with its tools
 *   2. the model calls agent_instances, and the answer comes from this project's executors (the call went through the
 *      daemon with the project attached)
 *   3. the model reports what the tool returned
 * The pure parts (failure text, metrics, the roster, the project scope) are in tools/router-test.mjs.
 *
 * Usage: node tools/run-isolated.mjs test:extension-live
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler, check } from './lib/scheduler.mjs';

if (!process.env.AGENTD_DATA_DIR) {
  console.log('run this with tools/run-isolated.mjs (a private daemon), not the shared one.');
  process.exit(0);
}

console.log('\n=== dispatcher extension, live ===\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const s = await Scheduler.open();
const call = (op, args) => s.c.call(op, args, { timeoutMs: 120_000 });
const project = `ex${Date.now().toString(36)}`;
const root = mkdtempSync(join(tmpdir(), 'agentd-extlive-'));

try {
  await call('project.create', { id: project, name: 'extension live', root });
  await call('project.addInstance', { project, id: 'zebra-writer', type: 'dsh', dir: '.', role: 'writes things about zebras' });

  await call('dispatcher.state', { project });
  await call('dispatcher.models', { project }); // starts pi
  await call('dispatcher.prompt', { project, message: 'Call the agent_instances tool, then reply with only the ids of the executors it lists, separated by commas.' });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const st = await call('dispatcher.state', { project });
    if (!st.isStreaming && i > 1) break;
  }
  const { messages } = await call('dispatcher.messages', { project });
  const calls = messages.flatMap((m) => (m.role === 'assistant' ? (m.content ?? []).filter((c) => c.type === 'toolCall') : []));
  const results = messages.filter((m) => m.role === 'toolResult');
  check('the model called agent_instances (so pi loaded the extension and its tools)', calls.some((c) => c.name === 'agent_instances'), calls.map((c) => c.name).join());
  const text = results.map((m) => JSON.stringify(m.content)).join(' ');
  check('the answer is this project\'s executor', /zebra-writer/.test(text), text.slice(0, 160));
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  check('and the model reported it', /zebra-writer/.test(JSON.stringify(last?.content ?? '')), JSON.stringify(last?.content ?? '').slice(0, 120));
} finally {
  await call('project.remove', { project, force: true }).catch(() => {});
  s.close();
}

console.log(process.exitCode ? '\n=> ✗ EXTENSION LIVE BROKEN' : '\n=> ✓ EXTENSION LIVE OK');
process.exit(process.exitCode ?? 0);
