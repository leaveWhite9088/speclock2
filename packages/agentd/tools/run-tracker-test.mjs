/**
 * What a run makes of the agent's updates, on its own: no process, no JSON-RPC, updates are fed by hand.
 *
 * Checks:
 *   1. text and reasoning add up on the run; the caller's text is the whole of it
 *   2. a tool call is followed from its start to its end: late titles and arguments are picked up, a placeholder title
 *      does not replace a good one, the transcript gets one entry when it starts and one when it ends
 *   3. text said before a tool call comes out as a piece ahead of it
 *   4. open tool calls are tracked (waiting on a tool is not silence), and cleared when the prompt begins
 *   5. progress goes out at most twice a second, at once when a tool call starts
 *   6. context figures are kept on the run and as the latest figures
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTD_TRANSCRIPTS_DIR = join(mkdtempSync(join(tmpdir(), 'agentd-tracker-t-')), 'tr');
const { RunTracker } = await import('../core/pool/run-tracker.mjs');
const { readTranscript } = await import('../core/transcripts.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== run tracker ===\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newRun = () => ({
  jobId: 'j1', startedAt: Date.now(), sessionId: 'S1', text: '', chunks: 0, thought: '', thoughtChars: 0,
  flushed: 0, flushedThought: 0, firstChunkAt: null, segAt: null, thoughtAt: null, tools: new Map(), logFile: null,
});
let run = newRun();
const t = new RunTracker({ name: 'tracker-test', getRun: () => run });
const sent = [];
t.sink = (jobId, p) => sent.push(p);
const say = (text) => t.onUpdate({ sessionUpdate: 'agent_message_chunk', content: { text } });
const think = (text) => t.onUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text } });
const entries = () => readTranscript('tracker-test', 'S1', { limit: 100 }).entries;

// 1
t.begin();
say('Looking. ');
think('hmm ');
say('Done.');
check('text and reasoning add up on the run', run.text === 'Looking. Done.' && run.thought === 'hmm ' && run.thoughtChars === 4 && run.chunks === 2);
check('the caller gets the whole text', t.streamedText === 'Looking. Done.');

// 2, 3, 4
run = newRun();
t.begin();
say('First I read it. ');
t.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'a', title: 'read', kind: 'read', status: 'in_progress', rawInput: {} });
check('a tool call that has started is open', t.openTools.has('a') && t.quiet().waitingOnTool);
check('its start is in the transcript, after the text said before it', entries().map((e) => `${e.role}${e.piece ? '~' : ''}`).join() === 'assistant~,tool', entries().map((e) => e.role).join());
t.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a', title: 'read src/app.ts', status: 'in_progress', rawInput: { path: 'src/app.ts' } });
t.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a', title: 'read…', status: 'in_progress' });
t.onUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'a', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'file body' } }] });
check('it is closed when it ends', !t.openTools.has('a') && !t.quiet().waitingOnTool);
const tools = entries().filter((e) => e.role === 'tool');
check('one entry when it starts, one when it ends', tools.length === 2 && tools[0].status === 'in_progress' && tools[1].status === 'completed', tools.map((e) => e.status).join());
check('the end has the late title and arguments, not the placeholder', /src\/app\.ts/.test(tools[1].title ?? '') && /src\/app\.ts/.test(tools[1].input ?? ''), JSON.stringify([tools[1].title, tools[1].input]));
check('and what the tool returned', /file body/.test(tools[1].output ?? ''), JSON.stringify(tools[1].output));
check('the run counts it', run.toolCalls === 1 && run.lastTool === 'read');
t.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'b', title: 'bash', status: 'in_progress' });
t.begin();
check('opening a new prompt clears the open calls', t.openTools.size === 0);

// 5
run = newRun();
t.lastProgressAt = 0;
sent.length = 0;
say('a');
say('b');
say('c');
check('progress is limited to twice a second', sent.length === 1, String(sent.length));
t.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'ls', status: 'in_progress' });
check('but a tool call starting is reported at once', sent.length === 2 && sent[1].tool === 'ls' && sent[1].toolCalls === 1, JSON.stringify(sent[1]));
await sleep(520);
say('d');
check('and again after half a second', sent.length === 3);

// 6
run = newRun();
t.onUpdate({ sessionUpdate: 'usage_update', used: 25_000, size: 100_000, cost: { amount: 0.1 } });
check('context figures are on the run and are the latest figures', run.context.percent === 25 && t.lastUsage.used === 25_000 && t.lastUsage.cost.amount === 0.1, JSON.stringify(t.lastUsage));

// no run: updates must not throw
run = null;
let threw = false;
try {
  say('late');
  t.onUpdate({ sessionUpdate: 'tool_call', toolCallId: 'z', title: 'x', status: 'in_progress' });
} catch {
  threw = true;
}
check('updates that arrive with no run going are ignored', !threw);

console.log(process.exitCode ? '\n=> ✗ RUN TRACKER BROKEN' : '\n=> ✓ RUN TRACKER OK');
process.exit(process.exitCode ?? 0);
