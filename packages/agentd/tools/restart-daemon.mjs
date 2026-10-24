/**
 * Restart the daemon so it runs the current code, without killing it: it is asked to shut down (the same clean
 * shutdown as when it is idle), and refuses while anything is working or waiting, so nobody's task is lost. Then a
 * fresh one is started unless --stop-only is given.
 *
 * Usage (works from the repo root or packages/agentd):
 *   npm run restart-daemon
 *   npm run restart-daemon -- --stop-only
 *   npm run restart-daemon -- --help
 *
 * Direct equivalents:
 *   repo root:        node packages/agentd/tools/restart-daemon.mjs
 *   packages/agentd:  node tools/restart-daemon.mjs
 *
 * Exit code 0: restarted (or stopped); 1: it was busy, nothing was changed; 2: it did not stop or usage was invalid.
 */

import { connect, ENDPOINT_FILE } from '../client/agentd-client.mjs';

const USAGE = `Usage (works from the repo root or packages/agentd):
  npm run restart-daemon
  npm run restart-daemon -- --stop-only
  npm run restart-daemon -- --help

Direct equivalents:
  repo root:        node packages/agentd/tools/restart-daemon.mjs
  packages/agentd:  node tools/restart-daemon.mjs

Exit codes: 0 = success, 1 = refused because tasks are running/waiting (nothing changed), 2 = did not stop or bad usage.`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(USAGE);
  process.exit(0);
}
const unknown = args.filter((arg) => arg !== '--stop-only');
if (unknown.length) {
  console.error(`unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}\n\n${USAGE}`);
  process.exit(2);
}
const stopOnly = args.includes('--stop-only');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let c = null;
try {
  c = await connect({ spawnOnDemand: false });
} catch {
  /* not running */
}

if (c) {
  const { pid } = await c.call('hello');
  try {
    await c.call('daemon.shutdown');
  } catch (err) {
    const action = stopOnly ? 'stopped' : 'restarted';
    console.log(`not ${action}: ${err.message}; nothing was changed`);
    c.close();
    process.exit(1);
  }
  c.close();
  const until = Date.now() + 30_000;
  while (alive(pid) && Date.now() < until) await sleep(200);
  if (alive(pid)) {
    console.log(`the daemon (pid ${pid}) was asked to stop but is still running`);
    process.exit(2);
  }
  console.log(`stopped the daemon (pid ${pid})`);
} else {
  console.log('no daemon was running');
}

if (stopOnly) {
  console.log('not starting a new daemon (--stop-only)');
  process.exit(0);
}

const fresh = await connect({ spawnOnDemand: true });
const hello = await fresh.call('hello');
console.log(`started a daemon (pid ${hello.pid}, ${hello.startedAt}); endpoint file: ${ENDPOINT_FILE}`);
fresh.close();
process.exit(0);
