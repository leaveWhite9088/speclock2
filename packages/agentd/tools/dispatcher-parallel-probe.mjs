/**
 * Probe, not a test: does a dispatcher that is asked to use two executors at once run them in parallel?
 *
 * Two dsh executors in a temporary project each get a 40 s sleep. If the dispatcher's two agent_run calls run
 * side by side, both jobs start within moments of each other and the whole thing takes about 40 s plus model
 * time; if they run one after the other, the second job starts only after the first has finished.
 *
 * Uses a real LLM for the dispatcher and real dsh executors (a few thousand tokens).
 */

import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler, stopDaemon } from './lib/scheduler.mjs';

const P = `pp${Date.now().toString(36)}`;
const root = mkdtempSync(join(tmpdir(), 'agentd-parallel-'));
for (const d of ['a', 'b']) mkdirSync(join(root, d));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const s = await Scheduler.open();
const call = (op, args) => s.c.call(op, args, { timeoutMs: 180_000 });
await call('project.create', { id: P, name: 'probe', root });
for (const d of ['a', 'b']) await call('project.addInstance', { project: P, id: d, type: 'dsh', dir: `./${d}`, role: `shell worker ${d}` });

const log = [];
const mark = (what) => {
  log.push(`${at()}  ${what}`);
  console.log(`${at()}  ${what}`);
};
s.c.on('job.started', (ev) => mark(`job.started  ${ev.agent.split('~')[1]}`));
s.c.on('job.done', (ev) => mark(`job.done     ${ev.agent.split('~')[1]}`));
s.c.on('dispatcher.event', (ev) => {
  const d = ev.data ?? ev;
  if (d.type === 'tool_execution_start' || d.type === 'tool_execution_end') mark(`${d.type.replace('tool_execution_', 'tool ')}  ${d.toolName}`);
});
await call('subscribe', { jobId: '*' }).catch(() => {});

mark('prompt sent');
await call('dispatcher.prompt', {
  project: P,
  message:
    'Executors a and b are independent. I need both to run the PowerShell command "Start-Sleep -Seconds 40" at the same time, ' +
    'so send the two tasks together, one to a and one to b, then tell me both replies.',
});
await s.c.waitFor('dispatcher.event', (ev) => (ev.data ?? ev).type === 'agent_settled', 400_000);
mark('dispatcher settled');

await call('project.remove', { project: P, force: true }).catch(() => {});
s.close();
await stopDaemon();
process.exit(0);
