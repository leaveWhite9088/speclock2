/**
 * Probe, not a test: what happens to a dispatcher conversation when the daemon dies while agent_run is waiting.
 *
 * A temporary project gets one executor and a dispatcher. The dispatcher is asked to run a slow command through
 * the executor; once the job is running the daemon is killed. After a restart we look at the dispatcher's
 * history and send it a message, to see whether the conversation still works.
 *
 * Uses a real LLM for the dispatcher and a real dsh executor (a few thousand tokens).
 */

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler, stopDaemon } from './lib/scheduler.mjs';

const P = `rs${Date.now().toString(36)}`;
const root = mkdtempSync(join(tmpdir(), 'agentd-restart-'));
mkdirSync(join(root, 'w'));
const show = (v) => JSON.stringify(v)?.slice(0, 400);

let s = await Scheduler.open();
const call = (op, args) => s.c.call(op, args, { timeoutMs: 180_000 });
await call('project.create', { id: P, name: 'probe', root });
await call('project.addInstance', { project: P, id: 'w', type: 'dsh', dir: './w', role: 'runs shell commands' });

await call('subscribe', { jobId: '*' }).catch(() => {});
await call('dispatcher.prompt', {
  project: P,
  message: 'Ask executor w to run this PowerShell command and wait for it: Start-Sleep -Seconds 45. Then tell me what it replied.',
});
const started = await s.c.waitFor('job.started', () => true, 120_000);
console.log('job started:', started.jobId, 'agent', started.agent);
await new Promise((r) => setTimeout(r, 3000));

const before = await call('dispatcher.messages', { project: P });
console.log('messages before the kill:', before.messages.length, before.messages.map((m) => `${m.role}${m.stopReason ? '/' + m.stopReason : ''}`).join(' '));

s.close();
await stopDaemon({ force: true });
console.log('daemon killed; restarting');
await new Promise((r) => setTimeout(r, 2000));
s = await Scheduler.open();

const after = await call('dispatcher.messages', { project: P });
console.log('messages after restart:', after.messages.length, after.messages.map((m) => `${m.role}${m.stopReason ? '/' + m.stopReason : ''}`).join(' '));
const last = after.messages.at(-1);
console.log('last message:', show(last));

const types = [];
const errors = [];
s.c.on('dispatcher.event', (ev) => {
  const d = ev.data ?? ev;
  types.push(d.type);
  const m = d.message ?? d;
  if (m?.errorMessage || m?.stopReason === 'error') errors.push(m.errorMessage ?? 'stopReason=error');
});
await call('subscribe', { jobId: '*' }).catch(() => {});
const t0 = Date.now();
try {
  await call('dispatcher.prompt', { project: P, message: 'Hello again. What happened with the task you gave executor w?' });
  await s.c.waitFor('dispatcher.event', (ev) => (ev.data ?? ev).type === 'agent_settled', 150_000);
  console.log(`dispatcher settled after ${Math.round((Date.now() - t0) / 1000)}s; event types:`, [...new Set(types)].join(', '));
} catch (e) {
  console.log('dispatcher turn failed:', e.message);
}
console.log('errors seen:', errors.length ? errors.join(' | ') : 'none');
const fin = await call('dispatcher.messages', { project: P });
console.log('final messages:', fin.messages.length);
for (const m of fin.messages.slice(-3)) console.log(' -', show(m));

await call('project.remove', { project: P, force: true }).catch(() => {});
s.close();
await stopDaemon();
process.exit(0);
