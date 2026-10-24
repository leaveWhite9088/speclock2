/**
 * Stopping a pi executor works: the turn and its running tool end, and the run is recorded as cancelled.
 * (The pi adapter used to ignore session/cancel, so stopping a pi executor did nothing.) Real pi and a real model,
 * in-process: the shared daemon is not involved.
 *
 * Checks: a long tool call is under way; cancel by run id; the run ends within seconds, not at the end of the tool
 * (40 s); it ends as cancelled and not forced; the same process then takes the next prompt.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstance } from '../core/agent-pool.mjs';
import { check } from './lib/scheduler.mjs';

console.log('\n=== stopping a pi executor ===\n');

const dir = mkdtempSync(join(tmpdir(), 'agentd-picancel-'));
const a = buildInstance({ id: 'pi-cancel-test', type: 'pi', cwd: dir });
const p = a.startPrompt('Run the PowerShell command Start-Sleep -Seconds 40 with your bash tool, then reply DONE.', { timeoutMs: 120_000 });
const outcome = p.done.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));

let tool = null;
for (let i = 0; i < 60 && !tool; i++) {
  await new Promise((r) => setTimeout(r, 500));
  tool = a.run?.lastTool ?? null;
}
check('the long tool call is under way', Boolean(tool), String(tool));

const t0 = Date.now();
const c = a.cancel(p.jobId);
check('cancel by run id is accepted', c.cancelled === true, JSON.stringify(c));
const o = await outcome;
const took = Date.now() - t0;
check('the run ends within seconds, not at the end of the 40 s tool', took < 20_000, `${took} ms`);
check('it ends as cancelled', o.ok ? o.r.stopReason === 'cancelled' && o.r.metrics.outcome === 'cancelled' : o.e.metrics?.outcome === 'cancelled', o.ok ? o.r.stopReason : o.e.message);
check('and it was not necessary to end the process', (o.ok ? o.r.metrics.forced : o.e.metrics?.forced) === false);

const next = await a.startPrompt('Reply with exactly: AGAIN', { timeoutMs: 120_000 }).done;
check('the same executor takes the next prompt', /AGAIN/.test(next.text), JSON.stringify(next.text.trim().slice(0, 30)));

await a.shutdown();
console.log(process.exitCode ? '\n=> ✗ PI CANCEL BROKEN' : '\n=> ✓ PI CANCEL OK');
process.exit(process.exitCode ?? 0);
