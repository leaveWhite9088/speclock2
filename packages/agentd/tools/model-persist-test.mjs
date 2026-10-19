/**
 * Model behaviour regression.
 *
 * 1. per-session isolation: two sessions keep different models at the same time
 * 2. persistence: the model survives the agent process being restarted
 *
 * dsh and pi reset a resumed session to the default model, so the pool keeps its
 * own copy and re-applies it. mcode stores it natively.
 *
 * Usage: node tools/model-persist-test.mjs [agent]
 */

import { execFileSync } from 'node:child_process';
import { Scheduler, check } from './lib/scheduler.mjs';

const AG = process.argv[2] || 'dsh';
console.log(`\n=== model isolation + persistence: ${AG} ===\n`);

// --- per-session isolation ------------------------------------------------
const s = await Scheduler.open();

const models = await s.models(AG);
const modelOpt = models.configOptions.find((o) => o.id === 'model');
const values = modelOpt.options.map((o) => o.value);
// mcode rejects one advertised option with "Internal error", so use the tail.
const mB = values[values.length - 1];
const mA = values[values.length - 2] ?? values[0];

const A = models.sessionId;
const B = (await s.create(AG)).sessionId;

await s.setModel(AG, mA, 'model', A);
await s.setModel(AG, mB, 'model', B);

const afterA = (await s.models(AG, A)).configOptions.find((o) => o.id === 'model').currentValue;
const afterB = (await s.models(AG, B)).configOptions.find((o) => o.id === 'model').currentValue;

check('session A keeps its model', afterA === mA, String(afterA).slice(0, 40));
check('session B keeps its model', afterB === mB, String(afterB).slice(0, 40));
check('models differ', mA !== mB);

await s.run(AG, 'Reply with exactly OK');
const stillA = (await s.models(AG, A)).configOptions.find((o) => o.id === 'model').currentValue;
check('model survives a prompt', stillA === mA);

s.close();

// --- persistence across a process restart ---------------------------------
console.log('\n  restarting the daemon…');
const stopped = stopDaemon();
console.log(`  ${stopped ? 'daemon stopped' : 'no daemon was running'}`);

const s2 = await Scheduler.open();
await s2.use(AG, A);
const resumed = (await s2.models(AG, A)).configOptions.find((o) => o.id === 'model').currentValue;
check('model restored after restart', resumed === mA, String(resumed).slice(0, 45));

const st = await s2.status(AG);
check('fresh agent process', st.alive === true);
s2.close();

console.log(
  process.exitCode
    ? '\n=> ✗ MODEL HANDLING BROKEN'
    : '\n=> ✓ MODELS ARE PER-SESSION AND SURVIVE RESTART',
);

/** Kill the daemon (Windows) so the next connect spawns a fresh one. */
function stopDaemon() {
  stopDaemonViaPowerShell();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      execFileSync(
        'D:/Environment/nodejs/node.exe',
        [
          '--input-type=module',
          '-e',
          "import('file:///D:/Project2/code-261013-speclock2/speclock2/packages/agentd/client/agentd-client.mjs').then(async m=>{const r=await m.isRunning();process.exit(r?0:1)});",
        ],
        { stdio: 'ignore', timeout: 4000 },
      );
    } catch {
      return true;
    }
  }
  return false;
}

function stopDaemonViaPowerShell() {
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
