/**
 * The line work waits in, on its own (no process, no CLI).
 *
 * Checks:
 *   1. tasks run one at a time, in the order they were handed over, and say how many were ahead
 *   2. a waiting prompt cancelled by id is answered at once and never runs; the others are untouched
 *   3. the running one, one that is over, and an unknown id cannot be cancelled as waiting
 *   4. a task that fails does not stop the ones behind it; session operations share the same line
 *   5. everything is cleaned up afterwards
 */

import { PromptQueue } from '../core/pool/prompt-queue.mjs';
import { check } from './lib/scheduler.mjs';

console.log('\n=== prompt queue ===\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = new PromptQueue();
const order = [];
const job = (name, ms, fail = false) => async () => {
  order.push(`start:${name}`);
  await sleep(ms);
  order.push(`end:${name}`);
  if (fail) throw new Error(`${name} failed`);
  return name;
};
const gone = () => Object.assign(new Error('cancelled'), { kind: 'cancelled' });
const settle = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));

const a = q.submit('a', 'first', job('a', 80), gone);
const b = q.submit('b', 'second', job('b', 10), gone);
const c = q.submit('c', 'third', job('c', 10), gone);
check('each says how many were ahead', a.ahead === 0 && b.ahead === 1 && c.ahead === 2, [a.ahead, b.ahead, c.ahead].join());
check('all are counted', q.inflight === 3);
check('the line lists the waiting, oldest first', q.waiting().map((j) => j.text).join() === 'first,second,third');

check('a waiting prompt can be cancelled', q.cancelWaiting('b') === true);
check('it no longer shows in the list', q.waiting().every((j) => j.jobId !== 'b'));
const ob = await settle(b.done);
check('and is answered at once, before the one in front is done', !ob.ok && ob.e.kind === 'cancelled' && !order.includes('end:a'), order.join());
const oc = await settle(c.done);
const oa = await settle(a.done);
check('the others ran, in order, and the cancelled one never did', oa.ok && oc.ok && order.join() === 'start:a,end:a,start:c,end:c', order.join());

check('a running or finished prompt is not waiting', q.cancelWaiting('a') === false && q.cancelWaiting('nope') === false);

// 4
order.length = 0;
const f = q.submit('f', 'fails', job('f', 5, true), gone);
const s = q.enqueue(async () => order.push('session-op'));
const g = q.submit('g', 'after', job('g', 5), gone);
const of = await settle(f.done);
await s;
const og = await settle(g.done);
check('a failing task reports its error', !of.ok && /f failed/.test(of.e.message));
check('the one behind it still runs, and a session operation waits its turn', og.ok && order.join() === 'start:f,end:f,session-op,start:g,end:g', order.join());

await sleep(20);
check('nothing is left behind', q.inflight === 0 && q.queuedJobs.size === 0 && q.cancelledJobs.size === 0 && q.earlyCancel.size === 0, JSON.stringify([q.inflight, q.queuedJobs.size, q.cancelledJobs.size, q.earlyCancel.size]));

console.log(process.exitCode ? '\n=> ✗ PROMPT QUEUE BROKEN' : '\n=> ✓ PROMPT QUEUE OK');
