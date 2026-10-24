/**
 * Whether the dispatcher is in a turn and what waits behind it, on its own: a fake `send`, no pi.
 *
 * Checks:
 *   1. an idle queue starts the message at once; while a turn runs, messages wait in order and say their position
 *   2. when the turn settles the next one goes, then the next, in order
 *   3. a command that pi handles without a turn frees the queue at once
 *   4. a message that cannot be sent does not block the ones behind it
 *   5. a waiting message can be taken back; "stop" drops them all; a process that goes away drops them and ends the turn
 *   6. `hold` (a compaction) makes what arrives wait, and lets it go afterwards, also when the work fails
 *   7. every change of the number of waiting messages is announced
 */

import { TurnQueue } from '../core/dispatcher/turn-queue.mjs';
import { check } from './lib/scheduler.mjs';

console.log('\n=== turn queue ===\n');

const sent = [];
const changes = [];
const logs = [];
const q = new TurnQueue({
  send: async (m) => {
    sent.push(m);
    if (m === '/command') return { disposition: 'handled' };
    if (m === 'boom') throw new Error('pi refused');
    return { disposition: 'started' };
  },
  onChange: (n) => changes.push(n),
  log: (x) => logs.push(x),
});
const tick = () => new Promise((r) => setTimeout(r, 15));

// 1
const r1 = await q.submit('first');
check('an idle queue starts the message at once', r1.disposition === 'started' && q.busy && sent.join() === 'first');
const r2 = await q.submit('second');
const r3 = await q.submit('third');
check('while a turn runs, messages queue with their position', r2.disposition === 'queued' && r2.position === 1 && r3.position === 2 && q.items.join() === 'second,third');
check('and are not sent yet', sent.join() === 'first');

// 2
q.settled();
await tick();
check('when the turn settles the next goes', sent.join() === 'first,second' && q.items.join() === 'third' && q.busy);
q.settled();
await tick();
check('then the one after, in order', sent.join() === 'first,second,third' && q.items.length === 0 && q.busy);
q.settled();
check('with nothing waiting it goes idle', !q.busy);

// 3
await q.submit('a');
await q.submit('/command');
await q.submit('b');
q.settled();
await tick();
check('a command handled without a turn frees the queue at once', sent.slice(-3).join() === 'a,/command,b' && q.busy && q.items.length === 0, sent.slice(-3).join());
q.settled();

// 4
await q.submit('one');
await q.submit('boom');
await q.submit('two');
q.settled();
await tick();
await tick();
check('a message that cannot be sent does not block the ones behind it', sent.slice(-3).join() === 'one,boom,two' && q.items.length === 0, sent.slice(-3).join());
check('and the failure is logged', logs.some((l) => /pi refused/.test(l)));
q.settled();

// 5
await q.submit('run');
await q.submit('x');
await q.submit('y');
await q.submit('z');
check('a waiting message can be taken back', q.take(1).removed === true && q.items.join() === 'x,z');
check('a place that is not there takes nothing', q.take(9).removed === false && q.take(-1).removed === false && q.take('a').removed === false);
q.clear();
check('stop drops all that waits, and does not touch the turn', q.items.length === 0 && q.busy);
await q.submit('late1');
q.closed();
check('a process that goes away ends the turn and drops what waited', !q.busy && q.items.length === 0);
q.began();
check('a turn started elsewhere makes the dispatcher busy', q.busy);
q.settled();

// 6
const before = sent.length;
let release;
const holding = q.hold(() => new Promise((r) => (release = r)));
const rh = await q.submit('during');
check('while holding, a message waits', q.busy && rh.disposition === 'queued' && sent.length === before);
release();
await holding;
await tick();
check('after holding it goes', sent.at(-1) === 'during' && q.items.length === 0);
q.settled();
const failing = q.hold(async () => {
  throw new Error('compaction failed');
});
await q.submit('after-fail');
await failing.catch(() => {});
await tick();
check('also when the work failed', sent.at(-1) === 'after-fail' && q.busy);
q.settled();

// 7
check('each change of the waiting count was announced', changes.length > 0 && changes.at(-1) === 0 && changes.every((n) => Number.isInteger(n) && n >= 0), changes.join());

console.log(process.exitCode ? '\n=> ✗ TURN QUEUE BROKEN' : '\n=> ✓ TURN QUEUE OK');
process.exit(process.exitCode ?? 0);
