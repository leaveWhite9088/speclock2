/**
 * Attempts at the same task are linked, and a task is not retried for ever.
 *
 * Checks, on the lineage module:
 *   1. the same prompt after a failure is the next attempt of the same task (whitespace does not matter)
 *   2. another prompt, or another executor, is a new task
 *   3. naming an earlier run (`retryOf`) joins its task whatever the prompt says
 *   4. a task that failed three times is refused for the dispatcher, by prompt and by name; a person starts over
 *   5. finished and cancelled runs end the task; a refused (`unstable`) run does not count as a failure
 *   6. all of it survives a restart
 * and on a real daemon with seeded files:
 *   7. a task cut off by a daemon stop shows up as an interrupted attempt, and the next resend is attempt 3
 *   8. a task that already failed three times is refused before anything starts
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agentd-tasks-'));
process.env.AGENTD_TASKS_FILE = join(dir, 'tasks.json');
process.env.AGENTD_JOURNAL_FILE = join(dir, 'journal.jsonl');
process.env.AGENTD_RECEIPTS_FILE = join(dir, 'receipts.jsonl');
const { check, Scheduler, stopDaemon } = await import('./lib/scheduler.mjs');
const T = await import('../core/tasks.mjs');

console.log('\n=== task attempts ===\n');

const run = (agent, prompt, jobId, outcome, retryOf) => {
  const plan = T.planRun({ agent, prompt, retryOf });
  T.recordRun(plan, jobId);
  if (outcome) T.endRun(jobId, outcome);
  return plan;
};
const refused = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
};

const a1 = run('coder', 'Build the login page', 'j1', 'timeout');
check('a first run is attempt 1 of a new task', a1.attempt === 1 && a1.isNew && a1.retryOf === null);
const a2 = run('coder', '  Build   the login\npage ', 'j2', 'failed');
check('the same prompt after a failure is the next attempt', a2.taskId === a1.taskId && a2.attempt === 2 && a2.retryOf === 'j1', JSON.stringify(a2));
check('another prompt is a new task', T.planRun({ agent: 'coder', prompt: 'Something else' }).isNew);
check('another executor is a new task', T.planRun({ agent: 'other', prompt: 'Build the login page' }).isNew);

const a3 = run('coder', 'Please try again, carefully', 'j3', null, 'j2');
check('naming an earlier run joins its task whatever the prompt says', a3.taskId === a1.taskId && a3.attempt === 3 && a3.retryOf === 'j2', JSON.stringify(a3));
const a3b = T.planRun({ agent: 'coder', prompt: 'x', retryOf: a1.taskId });
check('a task id works as well as a job id', a3b.taskId === a1.taskId && a3b.attempt === 4);
T.endRun('j3', 'interrupted');

const e1 = refused(() => T.planRun({ agent: 'coder', prompt: 'Build the login page' }));
check('after three failures the same prompt is refused', e1?.kind === 'retry-limit' && /j1, j2, j3/.test(e1.message) && /Do not retry/.test(e1.message), e1?.message);
const e2 = refused(() => T.planRun({ agent: 'coder', prompt: 'reworded', retryOf: 'j3' }));
check('and so is naming it', e2?.kind === 'retry-limit');

// the limit is for the dispatcher: a person sending the same thing again starts over
run('coder', 'Task H', 'h1', 'failed');
run('coder', 'Task H', 'h2', 'failed');
run('coder', 'Task H', 'h3', 'timeout');
check('the dispatcher is refused after three failures', refused(() => T.planRun({ agent: 'coder', prompt: 'Task H' }))?.kind === 'retry-limit');
const person = T.planRun({ agent: 'coder', prompt: 'Task H', counted: false });
check('a person sending it again starts a new task', person.isNew && person.attempt === 1);
check('and the failed task is closed, so it no longer blocks anyone', T.planRun({ agent: 'coder', prompt: 'Task H' }).isNew);

run('coder', 'Task B', 'b1', 'done');
const b2 = T.planRun({ agent: 'coder', prompt: 'Task B' });
check('a finished run ends the task: the same prompt is new', b2.isNew && b2.attempt === 1);
run('coder', 'Task C', 'c1', 'cancelled');
check('a cancelled run ends it too', T.planRun({ agent: 'coder', prompt: 'Task C' }).isNew);

run('coder', 'Task D', 'd1', 'unstable');
run('coder', 'Task D', 'd2', 'unstable');
run('coder', 'Task D', 'd3', 'unstable');
check('refused runs do not count as failures', !refused(() => T.planRun({ agent: 'coder', prompt: 'Task D' })));

// restart: the same file, read again
const T2 = await import('../core/tasks.mjs?again');
const e3 = refused(() => T2.planRun({ agent: 'coder', prompt: 'Build the login page' }));
check('the limit survives a restart', e3?.kind === 'retry-limit');
check('a run can be looked up by its id', T2.taskOf('j2')?.id === a1.taskId);

// -- a real daemon -------------------------------------------------------------
const P1 = 'Reply with exactly: OK';
const P2 = 'Reply with exactly: NOPE';
const now = Date.now();
writeFileSync(
  process.env.AGENTD_TASKS_FILE,
  JSON.stringify({
    tA: { id: 'tA', agent: 'dsh', hash: T.hashOf(P1), closed: false, createdAt: now, attempts: [{ jobId: 'a1', agent: 'dsh', outcome: 'failed', at: now }, { jobId: 'a2', agent: 'dsh', outcome: null, at: now }] },
    tB: { id: 'tB', agent: 'dsh', hash: T.hashOf(P2), closed: false, createdAt: now, attempts: ['b1', 'b2', 'b3'].map((jobId) => ({ jobId, agent: 'dsh', outcome: 'timeout', at: now })) },
  }),
);
writeFileSync(process.env.AGENTD_JOURNAL_FILE, JSON.stringify({ ts: new Date().toISOString(), kind: 'start', jobId: 'a2', agent: 'dsh', project: null, prompt: P1, taskId: 'tA', attempt: 2, retryOf: 'a1' }) + '\n');
writeFileSync(process.env.AGENTD_RECEIPTS_FILE, '');

await stopDaemon();
const s = await Scheduler.open();
const receipts = async () => (await s.receipts(50)).receipts;
const lost = (await receipts()).find((r) => r.jobId === 'a2');
check('the cut-off attempt is an interrupted receipt of its task', lost?.status === 'interrupted' && lost.taskId === 'tA' && lost.attempt === 2, JSON.stringify(lost));

const before = (await receipts()).length;
await s.c.call('run', { agent: 'dsh', prompt: P2, caller: 'dispatcher' }).then(
  () => check('a task that failed three times is refused for the dispatcher', false),
  (e) => check('a task that failed three times is refused for the dispatcher', /not sent again/.test(e.message), e.message),
);
check('and nothing was started for it', (await receipts()).length === before);
const person2 = await s.c.call('run', { agent: 'dsh', prompt: P2 }, { timeoutMs: 240_000 });
check('a person sending the same thing again is not refused: a new task', person2.attempt === 1 && person2.taskId !== 'tB' && /NOPE/.test(person2.text), JSON.stringify([person2.taskId, person2.attempt]));

const r = await s.c.call('run', { agent: 'dsh', prompt: P1, caller: 'dispatcher' }, { timeoutMs: 240_000 });
check('the resend is attempt 3 of the same task', r.taskId === 'tA' && r.attempt === 3 && r.retryOf === 'a2', JSON.stringify([r.taskId, r.attempt, r.retryOf]));
check('and the executor answers', /OK/.test(r.text), JSON.stringify(r.text?.slice(0, 40)));
const rec = (await receipts()).find((x) => x.jobId === r.jobId);
check('its receipt carries the task', rec?.taskId === 'tA' && rec.attempt === 3 && rec.status === 'done', JSON.stringify(rec));

s.close();
await stopDaemon();
console.log(process.exitCode ? '\n=> ✗ TASK ATTEMPTS BROKEN' : '\n=> ✓ TASK ATTEMPTS OK');
process.exit(process.exitCode ?? 0);
