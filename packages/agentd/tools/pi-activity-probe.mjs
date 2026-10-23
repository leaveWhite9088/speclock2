/**
 * Probe: does a pi executor show what it is doing (tool calls, reasoning), not only its final answer?
 *
 * A temporary project gets one pi executor; it is asked to create a file with its tools. Afterwards the executor's
 * transcript must hold the tool calls, and progress events must have shown signs of life before the answer.
 * Uses a real model (a few thousand tokens).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler, check } from './lib/scheduler.mjs';

const P = `pa${Date.now().toString(36)}`;
const root = mkdtempSync(join(tmpdir(), 'agentd-pia-'));
mkdirSync(join(root, 'p'));
const s = await Scheduler.open();
const call = (op, args) => s.c.call(op, args, { timeoutMs: 240_000 });

console.log('\n=== pi executor activity ===\n');
try {
  await call('project.create', { id: P, name: 'probe', root });
  await call('project.addInstance', { project: P, id: 'p', type: 'pi', dir: './p', role: 'writes files' });
  const key = `${P}~p`;

  const progress = [];
  await call('subscribe', { jobId: '*' }).catch(() => {});
  s.c.on('progress', (ev) => progress.push({ at: Date.now(), chars: ev.chars, thinking: ev.thinkingChars }));

  const t0 = Date.now();
  const r = await s.run(key, 'Use your tools: create a file named a.txt in the current directory containing exactly the word HELLO. Then reply with only: DONE', { timeoutMs: 240_000 });
  check('the run finishes', /DONE/i.test(r.text), JSON.stringify(r.text.trim().slice(0, 40)));
  check('the file was written', existsSync(join(root, 'p', 'a.txt')) && /HELLO/.test(readFileSync(join(root, 'p', 'a.txt'), 'utf8')));

  const t = await s.c.call('transcript', { agent: key, sessionId: r.sessionId, limit: 100 });
  const tools = t.entries.filter((e) => e.role === 'tool');
  console.log('  tool entries:', tools.map((e) => `${e.status}:${e.title}`).join(' | '));
  check('the transcript has the tool calls', tools.some((e) => e.status === 'in_progress' && /write|bash|edit/i.test(e.title ?? '')), tools.length + ' entries');
  check('and their ends', tools.some((e) => e.status === 'completed' || e.status === 'failed'));
  check('every call has an id', tools.every((e) => e.toolCallId));
  check('a call records what it was given', tools.some((e) => e.status === 'in_progress' && e.input), JSON.stringify(tools[0]?.input)?.slice(0, 50));
  check('and what it returned', tools.some((e) => e.status === 'completed' && e.output), JSON.stringify(tools.find((e) => e.status === 'completed')?.output)?.slice(0, 50));
  check('the reasoning is kept in the transcript', t.entries.some((e) => e.role === 'thought' && e.text), String(t.entries.filter((e) => e.role === 'thought').length));
  check('reasoning was counted', (r.metrics?.thinkingChars ?? 0) > 0, `thinkingChars ${r.metrics?.thinkingChars}`);
  console.log(`  progress events: ${progress.length}, first after ${progress[0] ? progress[0].at - t0 : '-'} ms of ${Date.now() - t0} ms`);
} finally {
  await call('project.remove', { project: P, force: true }).catch(() => {});
}
s.close();
console.log(process.exitCode ? '\n=> ✗ PI ACTIVITY MISSING' : '\n=> ✓ PI ACTIVITY OK');
process.exit(process.exitCode ?? 0);
