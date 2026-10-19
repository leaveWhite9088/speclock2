/**
 * Transcript regression.
 *
 * agentd records each conversation it carries, so a dashboard can show the content
 * of a session without asking the agent for its history.
 *
 * Checks:
 *   1. a run writes a user entry and an assistant entry
 *   2. entries have increasing seq numbers and the right text
 *   3. afterSeq returns only newer entries
 *   4. a second run extends the same session
 *   5. a session that agentd never ran reports recorded:false
 *   6. the record is still there after a daemon restart
 *
 * Usage: node tools/transcript-test.mjs [agent]
 */

import { Scheduler, check, stopDaemon } from './lib/scheduler.mjs';

const AG = process.argv[2] || 'dsh';
console.log(`\n=== transcript: ${AG} ===\n`);

let s = await Scheduler.open();
await s.c.call('new', { agent: AG });

const r1 = await s.run(AG, 'Reply with exactly: ALPHA');
const t1 = await s.c.call('transcript', { agent: AG, sessionId: r1.sessionId });
console.log(`  entries: ${t1.entries.map((e) => e.role).join(', ')}`);

check('transcript is marked as recorded', t1.recorded === true);
const user1 = t1.entries.find((e) => e.role === 'user');
const asst1 = t1.entries.find((e) => e.role === 'assistant');
check('user entry holds the prompt', user1?.text === 'Reply with exactly: ALPHA');
check('assistant entry holds the answer', /ALPHA/i.test(asst1?.text ?? ''), JSON.stringify(asst1?.text?.slice(0, 30)));
check('assistant entry carries job id and stop reason', asst1?.jobId === r1.jobId && Boolean(asst1?.stopReason));
check('seq increases', t1.entries.every((e, i, a) => i === 0 || e.seq > a[i - 1].seq));
check('user comes before assistant', user1.seq < asst1.seq);

const lastSeq = t1.entries.at(-1).seq;
const r2 = await s.run(AG, 'Reply with exactly: BETA');
check('second run stays in the same session', r2.sessionId === r1.sessionId);

const t2 = await s.c.call('transcript', { agent: AG, sessionId: r1.sessionId, afterSeq: lastSeq });
check(
  'afterSeq returns only new entries',
  t2.entries.length >= 2 && t2.entries.every((e) => e.seq > lastSeq),
  `${t2.entries.length} new`,
);
check('new entries are the second turn', t2.entries.some((e) => /BETA/i.test(e.text ?? '')));

const tail = await s.c.call('transcript', { agent: AG, sessionId: r1.sessionId, tail: true, limit: 1 });
check('tail returns the last entry', tail.entries.length === 1 && tail.entries[0].seq === tail.total);

// Without sessionId the active session is used.
const active = await s.c.call('transcript', { agent: AG });
check('default is the active session', active.sessionId === r1.sessionId);

const none = await s.c.call('transcript', { agent: AG, sessionId: 'no-such-session' });
check('unknown session reports recorded:false', none.recorded === false && none.entries.length === 0);

const total = (await s.c.call('transcript', { agent: AG, sessionId: r1.sessionId })).total;
s.close();
console.log('\n  restarting the daemon…');
await stopDaemon();
s = await Scheduler.open();
const again = await s.c.call('transcript', { agent: AG, sessionId: r1.sessionId });
check('record survives a daemon restart', again.total === total, `${again.total} entries`);

s.close();
console.log(process.exitCode ? '\n=> ✗ TRANSCRIPT BROKEN' : '\n=> ✓ TRANSCRIPT OK');
