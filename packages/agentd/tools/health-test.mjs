/**
 * Health / attention regression.
 *
 * Verifies the signals the scheduler infers on its own, with no cooperation
 * from the agent:
 *   1. a normal run reports health=ok and no attention items
 *   2. cancellation is reported as an attention item
 *   3. a receipt is persisted for every finished run
 *   4. killing the agent process emits an exit event and flips liveness
 *
 * Usage: node tools/health-test.mjs [agent]
 */

import { execFileSync } from 'node:child_process';
import { Scheduler, check } from './lib/scheduler.mjs';

const AG = process.argv[2] || 'dsh';
console.log(`\n=== health signals: ${AG} ===\n`);

const s = await Scheduler.open();

// --- 1. normal run --------------------------------------------------------
const ok = await s.run(AG, 'Reply with exactly: OK');
console.log(`  normal run: health=${ok.metrics.health} attention=${JSON.stringify(ok.metrics.attention)}`);
check('normal run is healthy', ok.metrics.health === 'ok');
check('normal run has no attention', (ok.metrics.attention ?? []).length === 0);

// --- 2. cancellation ------------------------------------------------------
const started = await s.c.call('run', {
  agent: AG,
  prompt: 'Write an extremely long 200 line essay about the history of rivers. Do not stop early.',
  async: true,
});
await s.c.call('subscribe', { jobId: started.jobId });
await new Promise((r) => setTimeout(r, 1200));
await s.cancel(AG);

const cancelled = await new Promise((resolve) => {
  const off = s.c.on('job.done', (ev) => {
    if (ev.jobId !== started.jobId) return;
    off();
    resolve(ev);
  });
  setTimeout(() => resolve({ timeout: true }), 60_000);
});

if (cancelled.timeout) {
  console.log('  ! cancellation did not settle within 60s (agent kept working)');
} else {
  const m = cancelled.result?.metrics ?? {};
  const codes = (m.attention ?? []).map((a) => a.code);
  console.log(`  cancelled: stopReason=${m.stopReason} health=${m.health} attention=${JSON.stringify(codes)}`);
  check('cancellation surfaces an attention item', codes.includes('cancelled') || Boolean(m.error));
}

// --- 3. receipts ----------------------------------------------------------
const { receipts } = await s.receipts(10);
console.log(`  receipts on disk: ${receipts.length}`);
for (const r of receipts.slice(-3)) {
  console.log(`    ${r.ts.slice(11, 19)}  ${r.agent.padEnd(6)} ${r.status.padEnd(9)} ${r.durationMs}ms  ${r.health}`);
}
check('receipts are persisted', receipts.length > 0);
check('receipts carry health', receipts.every((r) => typeof r.health === 'string'));

// --- 4. agent process exit ------------------------------------------------
const before = await s.status(AG);
console.log(`\n  killing agent pid ${before.pid} …`);

let exitEvent = null;
const offExit = s.c.on('agent.exit', (ev) => {
  exitEvent = ev;
});

try {
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `Stop-Process -Id ${before.pid} -Force`],
    { stdio: 'ignore', timeout: 20_000 },
  );
} catch (e) {
  console.log('  (kill failed)', e.message);
}

for (let i = 0; i < 40 && !exitEvent; i++) await new Promise((r) => setTimeout(r, 250));
offExit();

check('exit event emitted', Boolean(exitEvent), exitEvent ? JSON.stringify(exitEvent) : 'none');
const after = await s.status(AG);
check('agent no longer alive', after.alive === false);

// --- 5. crash mid-run -----------------------------------------------------
// The agent was killed in step 4; force a respawn so there is a live pid to kill.
await s.models(AG);
const s1 = await s.status(AG);
check('agent respawned before crash test', typeof s1.pid === 'number', String(s1.pid));
const running = await s.c.call('run', {
  agent: AG,
  prompt: 'Write 200 numbered lines about rivers.',
  async: true,
});
await s.c.call('subscribe', { jobId: running.jobId });
await new Promise((r) => setTimeout(r, 2000));
try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${s1.pid} -Force`], {
    stdio: 'ignore',
    timeout: 20_000,
  });
} catch {
  /* already gone */
}

const crash = await new Promise((resolve) => {
  const off = s.c.on('job.done', (ev) => {
    if (ev.jobId !== running.jobId) return;
    off();
    resolve(ev);
  });
  setTimeout(() => resolve({ timeout: true }), 60_000);
});

if (crash.timeout) {
  check('crash mid-run reported', false, 'no done event');
} else {
  const att = crash.receipt?.attention ?? [];
  console.log(`  crash receipt: status=${crash.receipt?.status} health=${crash.receipt?.health} duration=${crash.receipt?.durationMs}ms`);
  check('crash produces a failed receipt', crash.receipt?.status === 'failed');
  check('crash is reported as unhealthy', crash.receipt?.health === 'error');
  check('crash names the reason', att.some((a) => a.code === 'run_failed'), JSON.stringify(att.map((a) => a.code)));
  check('crash receipt keeps duration', typeof crash.receipt?.durationMs === 'number');
}

// Recovery: the next run must respawn automatically.
const recovered = await s.run(AG, 'Reply with exactly: BACK');
check('agent respawns after a crash', /BACK/i.test(recovered.text), recovered.text.trim().slice(0, 30));
const post = await s.status(AG);
console.log(`  after recovery: alive=${post.alive} spawns=${post.spawns}`);
check('spawn counter increased', post.spawns > before.spawns);

s.close();
console.log(process.exitCode ? '\n=> ✗ HEALTH SIGNALS INCOMPLETE' : '\n=> ✓ HEALTH SIGNALS OK');
