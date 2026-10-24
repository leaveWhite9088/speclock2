/**
 * A prompt that waits behind another says so, and says when it really starts. Fake ACP agent, no real CLI.
 *
 * Checks:
 *   1. the first prompt has nothing ahead of it and starts at once
 *   2. the second one is told how many are ahead, and only starts after the first has finished
 *   3. the "really started" notice comes once per prompt, in order
 *   4. nothing counts as in flight afterwards, also after a failed prompt
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstance } from '../core/agent-pool.mjs';
import { check } from './lib/scheduler.mjs';

console.log('\n=== queued prompts ===\n');

const dir = mkdtempSync(join(tmpdir(), 'agentd-queue-'));
const script = join(dir, 'fake.mjs');
writeFileSync(
  script,
  `
const send = (o) => console.log(JSON.stringify({ jsonrpc: '2.0', ...o }));
process.stdin.on('data', (d) => {
  for (const line of String(d).split(String.fromCharCode(10)).filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: { agentInfo: { name: 'fake' }, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'S1' } });
    else if (m.method === 'session/prompt') {
      const text = m.params.prompt[0].text;
      const finish = () => {
        send({ method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      };
      if (text === 'slow') setTimeout(finish, 1200);
      else if (text === 'boom') send({ id: m.id, error: { code: -32000, message: 'boom' } });
      else finish();
    } else if (m.id != null) send({ id: m.id, result: {} });
  }
});
`,
);

const a = buildInstance({ id: 'queue-test', type: 'dsh', cwd: dir });
a.spec.cmd = process.execPath;
a.spec.args = [script];

const started = [];
a.onRunStart = ({ jobId }) => started.push({ jobId, at: Date.now() });

const t0 = Date.now();
const p1 = a.startPrompt('slow');
const p2 = a.startPrompt('second');
check('the first prompt has nothing ahead', p1.ahead === 0, String(p1.ahead));
check('the second is told one is ahead', p2.ahead === 1, String(p2.ahead));
check('inflight counts both', a.inflight === 2, String(a.inflight));

const r1 = await p1.done;
const r1At = Date.now();
const r2 = await p2.done;
check('both finish in order', r1.text === 'slow' && r2.text === 'second');
check('the start notice came once per prompt, in order', started.length === 2 && started[0].jobId === p1.jobId && started[1].jobId === p2.jobId, JSON.stringify(started.map((s) => s.jobId)));
check('the second really started only after the first finished', started[1].at >= r1At - 50, `${started[1].at - r1At} ms after`);
check('the first started at once (before its 1.2 s were over)', started[0].at - t0 < 1000, `${started[0].at - t0} ms`);
check('nothing is in flight afterwards', a.inflight === 0, String(a.inflight));

const bad = a.startPrompt('boom');
await bad.done.then(() => {}, () => {});
check('a failed prompt does not stay in flight', a.inflight === 0, String(a.inflight));
const after = a.startPrompt('ok');
check('and the next one has nothing ahead', after.ahead === 0);
await after.done;

await a.shutdown();
console.log(process.exitCode ? '\n=> ✗ QUEUED PROMPTS BROKEN' : '\n=> ✓ QUEUED PROMPTS OK');
process.exit(process.exitCode ?? 0);
