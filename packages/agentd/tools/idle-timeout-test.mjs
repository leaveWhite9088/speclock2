/**
 * A prompt is abandoned after the agent has been silent for a while, not after a fixed time.
 * Runs against a fake ACP agent, no real CLI involved.
 *
 * Checks:
 *   1. an agent that keeps reporting progress is not cut off, even when the run is longer than the limit
 *   2. a long-running tool call is not silence
 *   3. a silent agent is told to cancel, and the error says so
 */

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstance } from '../core/agent-pool.mjs';
import { check } from './lib/scheduler.mjs';

console.log('\n=== idle timeout ===\n');

const dir = mkdtempSync(join(tmpdir(), 'agentd-idle-'));
const cancelled = join(dir, 'cancelled');
const script = join(dir, 'fake.mjs');
writeFileSync(
  script,
  `
import { writeFileSync } from 'node:fs';
const send = (o) => console.log(JSON.stringify({ jsonrpc: '2.0', ...o }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let silentId = null;
process.stdin.on('data', async (d) => {
  for (const line of String(d).split(String.fromCharCode(10)).filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: { agentInfo: { name: 'fake' }, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'S1' } });
    else if (m.method === 'session/cancel') {
      writeFileSync(${JSON.stringify(cancelled)}, 'yes');
      if (silentId != null) send({ id: silentId, result: { stopReason: 'cancelled' } });
    } else if (m.method === 'session/prompt') {
      const text = m.params.prompt[0].text;
      const update = (u) => send({ method: 'session/update', params: { sessionId: 'S1', update: u } });
      if (text === 'chatty') {
        for (let i = 0; i < 8; i++) { update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }); await wait(400); }
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      } else if (text === 'tool') {
        update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'build', status: 'in_progress' });
        await wait(3000);
        update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      } else silentId = m.id;
    }
  }
});
`,
);

const a = buildInstance({ id: 'idle-test', type: 'dsh', cwd: dir });
a.spec.cmd = process.execPath;
a.spec.args = [script];

const run = (text, idleMs) => a.startPrompt(text, { timeoutMs: idleMs }).done.then((r) => r, (e) => e);

// the idle limit is 1.5 s, the chatty run lasts 3.2 s
const t0 = Date.now();
const chatty = await run('chatty', 1500);
check('a run that keeps reporting progress outlives the idle limit', !(chatty instanceof Error) && Date.now() - t0 > 3000, chatty.message ?? `${Date.now() - t0} ms`);

const tool = await run('tool', 1000);
check('a running tool call is not silence', !(tool instanceof Error), tool.message);

const t1 = Date.now();
const silent = await run('silent', 1000);
check('a silent agent times out', silent instanceof Error && /no activity/.test(silent.message), silent.message);
check('the agent was told to cancel', existsSync(cancelled));
check('it gave up soon after the idle limit', Date.now() - t1 < 4000, `${Date.now() - t1} ms`);
check('the failure is classified as a timeout', /timeout/.test(JSON.stringify(silent.metrics?.attention ?? [])), JSON.stringify(silent.metrics?.attention));

await a.shutdown();
console.log(process.exitCode ? '\n=> ✗ IDLE TIMEOUT BROKEN' : '\n=> ✓ IDLE TIMEOUT OK');
process.exit(process.exitCode ?? 0);
