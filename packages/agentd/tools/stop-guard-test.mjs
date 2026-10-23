/**
 * The test helper that stops the daemon does not kill it while a task runs: the daemon is shared with the
 * dashboard, and killing it destroys whoever's work is in flight.
 *
 * Checks: a busy daemon is not stopped (the helper refuses), the task it was running still finishes, and once
 * the daemon is idle it is stopped. Uses one tiny real dsh run.
 */

process.env.AGENTD_STOP_WAIT_MS = '3000';
import { Scheduler, stopDaemon, check } from './lib/scheduler.mjs';
const s = await Scheduler.open();
// a slow task on the global dsh agent
const job = s.c.call('run', { agent: 'dsh', prompt: 'Run the PowerShell command Start-Sleep -Seconds 15 with your shell tool, then reply DONE', timeoutMs: 120000 }, { timeoutMs: 180000 });
await new Promise((r) => setTimeout(r, 4000));
let refused = null;
try { await stopDaemon(); } catch (e) { refused = e.message; }
check('a busy daemon is not killed', Boolean(refused) && /still working on dsh/.test(refused), refused);
const r = await job;
check('and the task it was running finishes', /DONE/i.test(r.text), JSON.stringify(r.text.slice(0, 30)));
await new Promise((r) => setTimeout(r, 1500));
await stopDaemon(); // idle now: allowed
check('an idle daemon is stopped', true);
s.close();
process.exit(process.exitCode ?? 0);
