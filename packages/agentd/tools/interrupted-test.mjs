/**
 * A task the daemon never finished leaves a trace.
 *
 * Checks, on the journal itself:
 *   1. a task that started and ended is not reported; one that only started is
 *   2. a half-written last line does not break the pass
 *   3. each lost task is reported once, and the executor keeps a notice until it gets new work
 * and on a real daemon killed while a task was on the books:
 *   4. at startup it writes an `interrupted` receipt and shows the notice on the executor
 *   5. a second restart does not report or record it again
 *
 * No agent runs, so no CLI and no tokens are involved.
 */

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agentd-journal-'));
process.env.AGENTD_JOURNAL_FILE = join(dir, 'journal.jsonl');
process.env.AGENTD_RECEIPTS_FILE = join(dir, 'receipts.jsonl');
process.env.AGENTD_TRANSCRIPTS_DIR = join(dir, 'transcripts');
const { check, Scheduler, stopDaemon } = await import('./lib/scheduler.mjs');
const J = await import('../core/journal.mjs');

console.log('\n=== interrupted tasks ===\n');

// -- the journal ---------------------------------------------------------------
J.journalStart({ jobId: 'j1', agent: 'a', project: 'p', prompt: 'first' });
J.journalStart({ jobId: 'j2', agent: 'b', project: 'p', prompt: 'second' });
J.journalStart({ jobId: 'j3', agent: 'a', project: 'p', prompt: 'third' });
J.journalEnd('j2');
appendFileSync(process.env.AGENTD_JOURNAL_FILE, '{"kind":"start","jobId":"j4","age'); // cut off mid-write

const lost = J.reconcileJournal();
check('only tasks without an end are reported', lost.map((j) => j.jobId).sort().join() === 'j1,j3', lost.map((j) => j.jobId).join());
check('a half-written line is ignored', !lost.some((j) => j.jobId === 'j4'));
check('the executor keeps its newest lost task', J.interruptedOf('a')?.jobId === 'j3' && J.interruptedOf('b') === null);
check('the journal is empty afterwards, so nothing is reported twice', readFileSync(process.env.AGENTD_JOURNAL_FILE, 'utf8') === '' && J.reconcileJournal().length === 0);
J.clearInterrupted('a');
check('new work for the executor clears the notice', J.interruptedOf('a') === null);

// -- a real daemon -------------------------------------------------------------
writeFileSync(
  process.env.AGENTD_JOURNAL_FILE,
  [
    { kind: 'start', jobId: 'lost-1', agent: 'dsh', project: null, prompt: 'rebuild the login module' },
    { kind: 'start', jobId: 'done-1', agent: 'dsh', project: null, prompt: 'finished before' },
    { kind: 'end', jobId: 'done-1' },
  ]
    .map((r) => JSON.stringify({ ts: new Date().toISOString(), ...r }))
    .join('\n') + '\n',
);
// the executor's conversation, where the lost task's prompt was written before the daemon died
mkdirSync(join(dir, 'transcripts', 'dsh'), { recursive: true });
writeFileSync(
  join(dir, 'transcripts', 'dsh', 'S1.jsonl'),
  JSON.stringify({ ts: new Date().toISOString(), role: 'user', jobId: 'lost-1', text: 'rebuild the login module' }) + '\n',
);
await stopDaemon();
let s = await Scheduler.open();
const receipts = async () => (await s.receipts(50)).receipts.filter((r) => r.jobId === 'lost-1' || r.jobId === 'done-1');
let rs = await receipts();
check('the daemon records the lost task as an interrupted receipt', rs.length === 1 && rs[0].status === 'interrupted' && rs[0].agent === 'dsh', JSON.stringify(rs.map((r) => [r.jobId, r.status])));
check('the finished task is not recorded again', !rs.some((r) => r.jobId === 'done-1'));
const row = async () => (await s.c.call('instances')).instances.find((i) => i.id === 'dsh');
check('the executor shows the notice', (await row())?.interrupted?.jobId === 'lost-1', JSON.stringify((await row())?.interrupted));

const convo = async () => (await s.c.call('transcript', { agent: 'dsh', sessionId: 'S1' })).entries;
const err = (await convo()).filter((e) => e.role === 'error');
check('the executor conversation says the task was interrupted', err.length === 1 && err[0].interrupted === true && err[0].jobId === 'lost-1' && /中断/.test(err[0].error), JSON.stringify(err.map((e) => e.error?.slice(0, 20))));

const { pid } = await s.hello();
s.close();
process.kill(pid); // an unclean stop
await new Promise((r) => setTimeout(r, 1500));
s = await Scheduler.open();
rs = await receipts();
check('a second restart does not record it again', rs.length === 1, String(rs.length));
check('the notice survives the restart', (await row())?.interrupted?.jobId === 'lost-1');
check('the conversation gets the message once, not on every restart', (await convo()).filter((e) => e.role === 'error').length === 1);

s.close();
await stopDaemon(); // so the next start uses the normal files again
console.log(process.exitCode ? '\n=> ✗ INTERRUPTED TASKS BROKEN' : '\n=> ✓ INTERRUPTED TASKS OK');
process.exit(process.exitCode ?? 0);
