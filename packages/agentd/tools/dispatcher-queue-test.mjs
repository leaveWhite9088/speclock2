/**
 * The dispatcher takes messages while it works: they wait their turn, in order. Its context figure is read right.
 * The dispatcher class runs against a faked pi (no real process, no model).
 *
 * Checks:
 *   1. a message while a turn runs is queued, not refused; the first turn is untouched
 *   2. when a turn ends the next message is sent, one at a time, in order
 *   3. a waiting message can be taken back; stopping a turn drops what waits behind it
 *   4. a message pi handles without a turn (a command) lets the next one go
 *   5. a failed send does not block the ones behind it
 *   6. the context figure comes from pi's statistics (it was unwrapped twice, so it was always empty)
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Dispatcher } from '../core/dispatcher.mjs';
import { check } from './lib/scheduler.mjs';

console.log('\n=== dispatcher queue ===\n');

const events = [];
const dir = mkdtempSync(join(tmpdir(), 'agentd-dq-'));
const d = new Dispatcher({ cwd: dir, project: null, sessionDir: dir, onEvent: (e) => events.push(e) });

const sent = [];
d.ensureStarted = async () => {};
d.child = {}; // "running"
d.command = async (type, params) => {
  if (type === 'prompt') {
    sent.push(params.message);
    if (params.message === '/handled') return { disposition: 'handled' };
    if (params.message === 'boom') throw new Error('pi refused');
    return { disposition: 'started' };
  }
  if (type === 'get_session_stats') return { contextUsage: { percent: 12.34, tokens: 1234, contextWindow: 10000 } };
  return {};
};
const tick = () => new Promise((r) => setTimeout(r, 20));
const settle = async () => {
  d._onRecord(JSON.stringify({ type: 'agent_settled' }));
  await tick();
};

// 1
const r1 = await d.prompt('first');
check('the first message starts a turn', r1.disposition === 'started' && d.busy && sent.join() === 'first', JSON.stringify(r1));
const r2 = await d.prompt('second');
const r3 = await d.prompt('third');
check('a message while the turn runs is queued', r2.disposition === 'queued' && r2.position === 1 && r3.position === 2, JSON.stringify([r2, r3]));
check('it was not sent yet', sent.join() === 'first' && d.queue.join() === 'second,third');
check('a queue event says so', events.some((e) => e.type === 'dispatcher_queue' && e.queued === 2));

// 2
await settle();
check('when the turn ends the next message is sent', sent.join() === 'first,second' && d.queue.join() === 'third' && d.busy, sent.join());
await settle();
check('and then the one after, in order', sent.join() === 'first,second,third' && d.queue.length === 0);
await settle();
check('the dispatcher is idle once the queue is empty', !d.busy);

// 3
await d.prompt('a');
await d.prompt('b');
await d.prompt('c');
check('a waiting message can be taken back', d.dequeue(0).removed === true && d.queue.join() === 'c');
check('an index that is not there is refused', d.dequeue(5).removed === false);
await d.abort();
check('stopping the turn drops what waited behind it', d.queue.length === 0);
await settle();
check('and nothing is sent after it', sent.at(-1) === 'a', sent.join());

// 4
await d.prompt('/handled');
check('a command pi handles without a turn leaves the dispatcher free', !d.busy);
await d.prompt('x');
await d.prompt('/handled');
await d.prompt('y');
await settle();
check('a queued command lets the next message go', sent.join().endsWith('x,/handled,y'), sent.slice(-3).join());
await settle();

// 5
await d.prompt('one');
await d.prompt('boom');
await d.prompt('two');
await settle();
await tick();
check('a message that cannot be sent does not block the ones behind it', sent.slice(-3).join() === 'one,boom,two' && d.queue.length === 0, sent.slice(-3).join());

// 6
await settle();
check('the context figure comes from pi statistics', d.context?.percent === 12.3 && d.context?.used === 1234 && d.context?.size === 10000, JSON.stringify(d.context));

console.log(process.exitCode ? '\n=> ✗ DISPATCHER QUEUE BROKEN' : '\n=> ✓ DISPATCHER QUEUE OK');
process.exit(process.exitCode ?? 0);
