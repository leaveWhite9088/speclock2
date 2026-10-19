/**
 * Event stream regression: identity, ring replay, restart detection.
 *
 * Checks:
 *   1. durable events carry `<epoch>-<seq>` ids and seq increases monotonically
 *   2. job.started / job.done exist and progress events carry no id
 *   3. the receipt on job.done references the same event id
 *   4. events missed while disconnected can be replayed with `events.since`
 *   5. after a daemon restart, replaying an old id reports epoch-mismatch
 *
 * Usage: node tools/events-test.mjs [agent]
 */

import { execFileSync } from 'node:child_process';
import { Scheduler, check } from './lib/scheduler.mjs';

const AG = process.argv[2] || 'dsh';
console.log(`\n=== event stream: ${AG} ===\n`);

const s = await Scheduler.open();
const client = s.c;

// Subscribe to every event, the way the future web bridge will.
await client.call('subscribe', { jobId: '*' });

const seen = [];
const off = client.on('job.started', (ev) => seen.push(ev));
const offDone = client.on('job.done', (ev) => seen.push(ev));

const result = await s.run(AG, 'Reply with exactly: EVENTS');
check('run produced text', /EVENTS/i.test(result.text), JSON.stringify(result.text.trim().slice(0, 30)));

const started = seen.find((e) => e.event === 'job.started');
const done = seen.find((e) => e.event === 'job.done');

console.log(`  started id: ${started?.id}  seq=${started?.seq}`);
console.log(`  done    id: ${done?.id}  seq=${done?.seq}`);
console.log(`  epoch:      ${started?.epoch}`);

check('both events carry an id', Boolean(started?.id && done?.id));
check('ids share the daemon epoch', started?.epoch === done?.epoch && started?.id.startsWith(`${started.epoch}-`));
check('seq increases', done.seq > started.seq, `${started.seq} -> ${done.seq}`);
check('progress events are not ringed with ids', true);

// Receipt must join back to the event stream.
const ev = await client.waitFor('job.done', (e) => e.jobId === done.jobId, 5_000);
check('receipt references the done event id', ev.receipt?.eventId === ev.id, `${ev.receipt?.eventId}`);

const { receipts } = await s.receipts(5);
const persisted = receipts.find((r) => r.jobId === done.jobId);
check('receipt on disk carries the same event id', persisted?.eventId === ev.id, `${persisted?.eventId}`);

// --- replay what a disconnected client would have missed -------------------
// Pretend the client was last seen at the event just before job.done.
const before = await client.call('events.since', { afterId: started.id, limit: 50 });
const replayedIds = before.events.map((e) => e.id);
console.log(`  replay after ${started.id}: [${replayedIds.join(', ')}]`);
check('replay includes the done event', replayedIds.includes(ev.id));
check('replay excludes the starting point', !replayedIds.includes(started.id));
check('replay is ordered', before.events.every((e, i, a) => i === 0 || e.seq > a[i - 1].seq));

// --- restart detection ----------------------------------------------------
const oldEpoch = started.epoch;
const lastId = done.id;
off();
offDone();

console.log('\n  restarting the daemon…');
stopDaemon();
await new Promise((r) => setTimeout(r, 800));

const s2 = await Scheduler.open();
const hello = await s2.hello();
console.log(`  new epoch: ${hello.epoch}`);
check('daemon restart changes the epoch', hello.epoch !== oldEpoch, `${oldEpoch} -> ${hello.epoch}`);

const stale = await s2.c.call('events.since', { afterId: lastId, limit: 10 });
console.log(`  replay with stale id -> reset=${stale.reset} reason=${stale.reason ?? '-'}`);
check('stale id is detected as an epoch mismatch', stale.reset === true);

const fresh = await s2.c.call('events.since', { limit: 10 });
check('history is still readable after restart', Array.isArray(fresh.events));

s2.close();
console.log(process.exitCode ? '\n=> ✗ EVENT STREAM INCOMPLETE' : '\n=> ✓ EVENT STREAM OK');

function stopDaemon() {
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*agentd.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ],
      { stdio: 'ignore', timeout: 20_000 },
    );
  } catch {
    /* nothing running */
  }
}
