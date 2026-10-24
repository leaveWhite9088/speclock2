/**
 * What an agent says and thinks is written into the transcript in the order it happened, between its tool calls.
 * Fake ACP agent, no real CLI.
 *
 * Checks:
 *   1. text and reasoning said before a tool call come out as pieces ahead of it; what is said afterwards, after it
 *   2. the final entry holds only what was left, and carries how the run ended
 *   3. the reply handed back to the caller is still the whole text
 *   4. while the run goes on, the live tail offers only what is not in the transcript yet
 *   5. a run that ends on a tool call still gets its final entry (empty text); a run with no tool calls is one entry
 *   6. a failed run keeps what was said so far as pieces
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTD_TRANSCRIPTS_DIR = join(mkdtempSync(join(tmpdir(), 'agentd-pieces-t-')), 'tr');
const { buildInstance } = await import('../core/agent-pool.mjs');
const { readTranscript } = await import('../core/transcripts.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== transcript pieces ===\n');

const dir = mkdtempSync(join(tmpdir(), 'agentd-pieces-'));
const script = join(dir, 'fake.mjs');
writeFileSync(
  script,
  `
const send = (o) => console.log(JSON.stringify({ jsonrpc: '2.0', ...o }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const upd = (u) => send({ method: 'session/update', params: { sessionId: 'S1', update: u } });
const say = (t) => upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
const think = (t) => upd({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: t } });
const tool = async (id, title) => {
  upd({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'execute', status: 'in_progress', rawInput: { cmd: title } });
  await wait(60);
  upd({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok ' + id } }] });
};
process.stdin.on('data', async (d) => {
  for (const line of String(d).split(String.fromCharCode(10)).filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: { agentInfo: { name: 'fake' }, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'S1' } });
    else if (m.method === 'session/prompt') {
      const text = m.params.prompt[0].text;
      if (text === 'steps') {
        think('weighing the options. ');
        say("I'll start by looking around. ");
        await tool('t1', 'ls');
        say('Now step two. ');
        await tool('t2', 'build');
        say('All done.');
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      } else if (text === 'ends-on-tool') {
        say('Running it. ');
        await tool('t3', 'run');
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      } else if (text === 'plain') {
        say('just an answer');
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      } else if (text === 'dies') {
        say('half an answer. ');
        await tool('t4', 'x');
        say('and then ');
        send({ id: m.id, error: { code: -32000, message: 'the model went away' } });
      } else if (text === 'slow') {
        say('first part. ');
        await tool('t5', 'step');
        say('second part so far');
        await wait(800);
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
    } else if (m.id != null) send({ id: m.id, result: {} });
  }
});
`,
);

const a = buildInstance({ id: 'pieces-test', type: 'dsh', cwd: dir });
a.spec.cmd = process.execPath;
a.spec.args = [script];
const run = (t) => a.startPrompt(t, { timeoutMs: 20_000 }).done.then((r) => r, (e) => e);
const entries = (sid) => readTranscript('pieces-test', sid, { limit: 200 }).entries;
const brief = (es) => es.map((e) => (e.role === 'assistant' ? `a${e.piece ? '~' : ''}:${e.text}` : e.role === 'tool' ? `tool:${e.status}` : e.role === 'thought' ? `th:${e.text}` : e.role)).join(' | ');

// 1, 2, 3
const r = await run('steps');
const es = entries(r.sessionId).filter((e) => e.role !== 'user');
console.log('  ', brief(es));
check('reasoning and text before a tool call come first', es[0].role === 'thought' && es[0].text === 'weighing the options.' && es[1].role === 'assistant' && es[1].piece && es[1].text === "I'll start by looking around.", brief(es.slice(0, 2)));
check('then the tool call, then what was said after it', es[2].role === 'tool' && es[2].title === 'ls' && es[4].role === 'assistant' && es[4].text === 'Now step two.', brief(es.slice(2, 5)));
check('the second tool call follows in order', es[5].role === 'tool' && es[5].title === 'build', brief(es.slice(5, 7)));
const last = es.at(-1);
check('the final entry holds only what was left, and how the run ended', last.role === 'assistant' && !last.piece && last.text === 'All done.' && last.stopReason === 'end_turn', brief(es.slice(-1)));
check('every piece says when it began', es.filter((e) => e.role === 'assistant').every((e) => Date.parse(e.startedAt) > 0));
check('the caller still gets the whole reply', r.text === "I'll start by looking around. Now step two. All done.", JSON.stringify(r.text));

// 4: the live tail during the run
const p = a.startPrompt('slow', { timeoutMs: 20_000 });
await new Promise((res) => setTimeout(res, 400));
const tail = a.tail(p.jobId);
check('the live tail offers only what is not in the transcript yet', tail.pendingText === 'second part so far' && tail.text === 'first part. second part so far', JSON.stringify(tail.pendingText));
await p.done;

// 5
const e1 = await run('ends-on-tool');
const f1 = entries(e1.sessionId).filter((e) => e.role !== 'user' && e.text !== 'first part.' ).slice(-3);
check('a run that ends on a tool call still gets its final entry, with no text', f1.at(-1).role === 'assistant' && !f1.at(-1).piece && f1.at(-1).text === '' && f1.at(-1).stopReason === 'end_turn', brief(f1));
const e2 = await run('plain');
const f2 = entries(e2.sessionId).filter((e) => e.role !== 'user').slice(-1)[0];
check('a run with no tool calls is one entry with the whole text', f2.role === 'assistant' && !f2.piece && f2.text === 'just an answer');

// 6
const bad = await run('dies');
const f3 = entries(a.sessionId).filter((e) => e.role !== 'user').slice(-5);
check('a failed run keeps what was said so far, in order', f3.map((e) => e.role).join() === 'assistant,tool,tool,assistant,error' && f3[0].text === 'half an answer.' && f3[3].text === 'and then', brief(f3));
check('and ends with the error', entries(a.sessionId).at(-1).role === 'error' && /went away/.test(entries(a.sessionId).at(-1).error));

await a.shutdown();
console.log(process.exitCode ? '\n=> ✗ PIECES BROKEN' : '\n=> ✓ PIECES OK');
process.exit(process.exitCode ?? 0);
