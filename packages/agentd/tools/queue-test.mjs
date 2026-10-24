/**
 * Prompts waiting behind another, and cancelling by run. Fake ACP agent, no real CLI.
 *
 * Checks:
 *   1. the first prompt has nothing ahead and starts at once; the second is told one is ahead and starts only after
 *   2. the "really started" notice comes once per prompt, in order; nothing stays in flight afterwards
 *   3. cancelling a waiting run drops it before it reaches the CLI, and leaves the others alone
 *   4. cancelling the running one asks the CLI to stop it; one that is already over is left alone
 *   5. a stop the CLI ignores is not waited for for ever: after a grace period its process is ended, as for a timeout
 *   6. a failure says where it comes from: the CLI's own error is passed on as it came, a timeout is agentd's
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.AGENTD_CANCEL_GRACE_MS = '600'; // read when the pool loads
const { buildInstance } = await import('../core/agent-pool.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== queued prompts ===\n');

const dir = mkdtempSync(join(tmpdir(), 'agentd-queue-'));
const script = join(dir, 'fake.mjs');
const seen = join(dir, 'seen.txt');
writeFileSync(seen, '');
writeFileSync(
  script,
  `
import { appendFileSync } from 'node:fs';
const send = (o) => console.log(JSON.stringify({ jsonrpc: '2.0', ...o }));
let slowId = null;
let slowTimer = null;
process.stdin.on('data', (d) => {
  for (const line of String(d).split(String.fromCharCode(10)).filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: { agentInfo: { name: 'fake' }, agentCapabilities: {} } });
    else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'S1' } });
    else if (m.method === 'session/cancel') {
      if (slowId != null) { clearTimeout(slowTimer); send({ id: slowId, result: { stopReason: 'cancelled' } }); slowId = null; }
    } else if (m.method === 'session/prompt') {
      const text = m.params.prompt[0].text;
      appendFileSync(${JSON.stringify(seen)}, text + String.fromCharCode(10));
      const finish = () => {
        send({ method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      };
      if (text.startsWith('slow')) { slowId = m.id; slowTimer = setTimeout(() => { slowId = null; finish(); }, 1200); }
      else if (text === 'boom') send({ id: m.id, error: { code: -32000, message: 'quota exceeded for this plan (429)' } });
      else if (text === 'silent' || text === 'stubborn') { /* never answers, and ignores a cancel */ }
      else finish();
    } else if (m.id != null) send({ id: m.id, result: {} });
  }
});
`,
);
const prompts = () => readFileSync(seen, 'utf8').split('\n').filter(Boolean);

const a = buildInstance({ id: 'queue-test', type: 'dsh', cwd: dir });
a.spec.cmd = process.execPath;
a.spec.args = [script];
const started = [];
a.onRunStart = ({ jobId }) => started.push({ jobId, at: Date.now() });
const outcome = (p) => p.done.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));

// 1, 2
const t0 = Date.now();
const p1 = a.startPrompt('slow-1');
const p2 = a.startPrompt('second');
check('the first prompt has nothing ahead', p1.ahead === 0, String(p1.ahead));
check('the second is told one is ahead', p2.ahead === 1, String(p2.ahead));
check('inflight counts both', a.inflight === 2, String(a.inflight));
const r1 = await p1.done;
const r1At = Date.now();
const r2 = await p2.done;
check('both finish in order', r1.text === 'slow-1' && r2.text === 'second');
check('the start notice came once per prompt, in order', started.length === 2 && started[0].jobId === p1.jobId && started[1].jobId === p2.jobId);
check('the second really started only after the first finished', started[1].at >= r1At - 50, `${started[1].at - r1At} ms after`);
check('the first started at once', started[0].at - t0 < 1000, `${started[0].at - t0} ms`);
check('nothing is in flight afterwards', a.inflight === 0, String(a.inflight));

// 3: a waiting run is cancelled by its id
const q1 = a.startPrompt('slow-2');
const q2 = a.startPrompt('cancel-me');
const q3 = a.startPrompt('third');
const c = a.cancel(q2.jobId);
check('a waiting run can be cancelled', c.cancelled === true && c.queued === true, JSON.stringify(c));
const listed = a.waitingJobs();
check('the waiting list shows the others, not the cancelled one', !listed.some((j) => j.jobId === q2.jobId) && listed.some((j) => j.jobId === q3.jobId && j.text === 'third'), JSON.stringify(listed));
const o2 = await outcome(q2);
check('it is answered at once, while the run in front of it still goes on', a.run != null && a.run.jobId === q1.jobId);
check('it ends as cancelled, without an error from the CLI', !o2.ok && o2.e.kind === 'cancelled' && o2.e.metrics?.outcome === 'cancelled', o2.e?.message);
check('the run in front of it was not touched', (await outcome(q1)).ok);
check('the one behind it still ran', (await outcome(q3)).ok);
check('the cancelled prompt never reached the CLI', !prompts().includes('cancel-me'), prompts().join(','));
check('and nothing is left in flight', a.inflight === 0 && a.queuedJobs.size === 0 && a.cancelledJobs.size === 0 && a.earlyCancel.size === 0);

// 4: the running one, and one that is over
const s1 = a.startPrompt('slow-3');
await new Promise((r) => setTimeout(r, 300));
const stop = a.cancel(s1.jobId);
check('the running run is asked to stop', stop.cancelled === true && !stop.queued, JSON.stringify(stop));
const so = await outcome(s1);
check('and ends as cancelled', so.ok && so.r.stopReason === 'cancelled' && so.r.metrics.outcome === 'cancelled', JSON.stringify(so.ok ? so.r.stopReason : so.e.message));
const late = a.cancel(s1.jobId);
check('cancelling one that is already over does nothing', late.cancelled === false, JSON.stringify(late));
const other = a.startPrompt('slow-4');
await new Promise((r) => setTimeout(r, 200));
const wrong = a.cancel('not-this-one');
check('a run id that is not running does not stop the running one', wrong.cancelled === false);
check('which then finishes normally', (await outcome(other)).ok);

// 5: a stop that is ignored
const stub = a.startPrompt('stubborn', { timeoutMs: 60_000 });
await new Promise((r) => setTimeout(r, 300));
const pid = a.child?.pid;
a.cancel(stub.jobId);
const tStop = Date.now();
const so2 = await outcome(stub);
check('a stop the CLI ignores ends the run as cancelled, forced', !so2.ok && so2.e.kind === 'cancelled' && so2.e.metrics?.outcome === 'cancelled' && so2.e.metrics?.forced === true, JSON.stringify([so2.e?.kind, so2.e?.metrics?.outcome, so2.e?.metrics?.forced]));
check('after the grace period, not before and not much later', Date.now() - tStop >= 500 && Date.now() - tStop < 3000, `${Date.now() - tStop} ms`);
check('the stuck process is gone', a.child === null && pid !== a.child?.pid);
const again = await outcome(a.startPrompt('after-stop'));
check('the next prompt works on a fresh process', again.ok && again.r.text === 'after-stop');

// 6: where a failure comes from
const bad = await outcome(a.startPrompt('boom'));
check('the CLI\'s own error is passed on as it came', !bad.ok && bad.e.message === 'quota exceeded for this plan (429)' && bad.e.metrics?.failureSource === 'cli', JSON.stringify([bad.e?.message, bad.e?.metrics?.failureSource]));
const quiet = await outcome(a.startPrompt('silent', { timeoutMs: 600 }));
check('a timeout is agentd\'s own failure', !quiet.ok && quiet.e.metrics?.failureSource === 'agentd' && quiet.e.metrics?.outcome === 'timeout', JSON.stringify([quiet.e?.metrics?.failureSource, quiet.e?.metrics?.outcome]));
const ok = await outcome(a.startPrompt('fine'));
check('a run that works has no failure source', ok.ok && ok.r.metrics.failureSource === null);

await a.shutdown();
console.log(process.exitCode ? '\n=> ✗ QUEUED PROMPTS BROKEN' : '\n=> ✓ QUEUED PROMPTS OK');
process.exit(process.exitCode ?? 0);
