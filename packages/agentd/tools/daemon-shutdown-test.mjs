/**
 * Ending the daemon cleanly, and the script that restarts it. Run against a private daemon (tools/run-isolated.mjs);
 * with the shared one it would restart it, so it refuses to run there.
 *
 * Checks:
 *   1. the dispatcher may not ask for it
 *   2. while an executor works the daemon refuses, keeps running, and the task finishes
 *   3. when idle it stops, and its process is gone
 *   4. the restart script starts a new daemon (a different process), and reports a busy daemon without touching it
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Scheduler, check } from './lib/scheduler.mjs';

if (!process.env.AGENTD_DATA_DIR) {
  console.log('this test restarts the daemon: run it with tools/run-isolated.mjs (a private daemon), not the shared one.');
  process.exit(0);
}

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const restart = (...args) => spawnSync(process.execPath, [join(ROOT, 'tools', 'restart-daemon.mjs'), ...args], { encoding: 'utf8', env: process.env, timeout: 60_000 });

console.log('\n=== daemon shutdown ===\n');

let s = await Scheduler.open();
const pid1 = (await s.hello()).pid;

// 1
const denied = await s.c.call('daemon.shutdown', { caller: 'dispatcher', project: 'whatever' }).then(() => 'allowed', (e) => e.message);
check('the dispatcher cannot ask for it', /the dispatcher cannot do "daemon.shutdown"/.test(denied), denied);
check('and the daemon is still there', alive(pid1));

// 2: busy
const job = s.c.call('run', { agent: 'dsh', prompt: 'Run the PowerShell command Start-Sleep -Seconds 12 with your shell tool, then reply DONE', timeoutMs: 120000 }, { timeoutMs: 180000 });
await sleep(4000);
const refused = await s.c.call('daemon.shutdown').then(() => 'stopped', (e) => e.message);
check('while an executor works the daemon refuses', /still working on/.test(refused), refused);
const script = restart();
check('the restart script reports it and changes nothing', script.status === 1 && /not restarted: not stopping: still working on/.test(script.stdout), `${script.status} ${script.stdout.trim().slice(0, 100)}`);
check('the daemon is still running', alive(pid1));
const r = await job;
check('and the task it was running finishes', /DONE/i.test(r.text), JSON.stringify(r.text.slice(0, 30)));
await sleep(1500);

// 3: idle
s.close();
const stop = restart('--stop-only');
check('when idle the script stops it', stop.status === 0 && /stopped the daemon/.test(stop.stdout), `${stop.status} ${stop.stdout.trim().slice(0, 100)}`);
check('its process is gone', !alive(pid1));

// 4: restart
s = await Scheduler.open();
const pid2 = (await s.hello()).pid;
s.close();
const again = restart();
const m = /started a daemon \(pid (\d+)/.exec(again.stdout);
check('the restart script starts a new daemon', again.status === 0 && m && Number(m[1]) !== pid2 && alive(Number(m[1])), `${again.status} ${again.stdout.trim().slice(0, 120)}`);
check('and the old one is gone', !alive(pid2));

console.log(process.exitCode ? '\n=> ✗ DAEMON SHUTDOWN BROKEN' : '\n=> ✓ DAEMON SHUTDOWN OK');
process.exit(process.exitCode ?? 0);
