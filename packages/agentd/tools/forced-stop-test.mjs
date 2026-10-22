/**
 * An agent that ignores a cancel is killed, not waited for. Runs against a fake ACP agent, no real CLI involved.
 *
 * Checks:
 *   1. a silent agent that also ignores the cancel is stopped after the grace period, with everything it started
 *   2. the run ends as `timeout` with `forced` set, and the message tells what happened
 *   3. the stop is not reported as a crash
 *   4. the next task starts a fresh process and works
 *   5. killed three times in a row, the executor is marked unstable and refuses work until recovered
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTD_CANCEL_GRACE_MS = '1000';
const { buildInstance } = await import('../core/agent-pool.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== forced stop ===\n');

const dir = mkdtempSync(join(tmpdir(), 'agentd-force-'));
const pidFile = join(dir, 'grandchild.pid');
const script = join(dir, 'fake.mjs');
writeFileSync(
  script,
  `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const send = (o) => console.log(JSON.stringify({ jsonrpc: '2.0', ...o }));
process.stdin.on('data', (d) => {
  for (const line of String(d).split(String.fromCharCode(10)).filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.method === 'initialize') send({ id: m.id, result: { agentInfo: { name: 'fake' }, agentCapabilities: {} } });
    else if (m.method === 'session/cancel') { /* ignored on purpose */ }
    else if (m.method === 'session/prompt') {
      const text = m.params.prompt[0].text;
      if (text === 'hang') {
        // a tool process the agent started and that would outlive it
        const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true, detached: true });
        writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));
      } else {
        send({ method: 'session/update', params: { sessionId: 'S1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fine' } } } });
        send({ id: m.id, result: { stopReason: 'end_turn' } });
      }
    } else if (m.id != null) send({ id: m.id, result: m.method === 'session/new' ? { sessionId: 'S1' } : {} });
  }
});
`,
);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const a = buildInstance({ id: 'force-test', type: 'dsh', cwd: dir });
a.spec.cmd = process.execPath;
a.spec.args = [script];
let exits = 0;
a.onExit = () => exits++;
const stops = [];
a.onForcedStop = (info) => stops.push(info);

const run = (text, idleMs = 700) => a.startPrompt(text, { timeoutMs: idleMs }).done.then((r) => r, (e) => e);

const first = await run('ok');
check('a normal task works', first.text === 'fine' && first.metrics.outcome === 'done', first.message ?? first.text);
const pid1 = a.child.pid;

const t0 = Date.now();
const hung = await run('hang');
const took = Date.now() - t0;
check('the hung task fails', hung instanceof Error, hung.message);
check('it ended as a timeout', hung.metrics?.outcome === 'timeout', hung.metrics?.outcome);
check('it is marked as forced', hung.metrics?.forced === true);
check('the message says the process was stopped', /process was stopped/.test(hung.message), hung.message);
check('it took the idle limit plus the grace period, not longer', took > 1500 && took < 4500, `${took} ms`);
check('the attention list says forced_stop', JSON.stringify(hung.metrics?.attention).includes('forced_stop'));

await sleep(1500);
check('the agent process is gone', !alive(pid1));
const grandchild = Number(readFileSync(pidFile, 'utf8'));
check('so is the process it started', !alive(grandchild), `pid ${grandchild}`);
check('the stop is not reported as a crash', exits === 0, `${exits} exit events`);
check('a forced-stop notice was raised', stops.length === 1 && stops[0].forcedStops === 1, JSON.stringify(stops));

const again = await run('ok');
check('the next task starts a fresh process and works', again.text === 'fine' && a.spawnCount === 2, again.message ?? `spawns ${a.spawnCount}`);

for (let i = 0; i < 2; i++) await run('hang');
check('killed three times: marked unstable', a.unstable === true && a.status().unstable === true);
const spawnsBefore = a.spawnCount;
const refused = await run('ok');
check('an unstable executor refuses work at once', refused instanceof Error && refused.metrics?.outcome === 'unstable', refused.message ?? refused.text);
check('and starts no process for it', a.spawnCount === spawnsBefore);

a.recover();
const back = await run('ok');
check('after recovery it works again', back.text === 'fine' && !a.unstable, back.message ?? back.text);

await a.shutdown();
await sleep(500);
if (existsSync(pidFile) && alive(Number(readFileSync(pidFile, 'utf8')))) process.kill(Number(readFileSync(pidFile, 'utf8')));
console.log(process.exitCode ? '\n=> ✗ FORCED STOP BROKEN' : '\n=> ✓ FORCED STOP OK');
process.exit(process.exitCode ?? 0);
