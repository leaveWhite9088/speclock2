/**
 * Restart the daemon so it runs the current code, without killing it: it is asked to shut down (the same clean
 * shutdown as when it is idle), and refuses while anything is working or waiting, so nobody's task is lost. Then a
 * fresh one is started.
 *
 * Usage: node tools/restart-daemon.mjs [--stop-only]
 * Exit code 0: restarted (or stopped); 1: it was busy, nothing was changed; 2: it did not stop.
 */

import { readFileSync } from 'node:fs';
import { connect, ENDPOINT_FILE } from '../client/agentd-client.mjs';

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
    console.log(`not restarted: ${err.message}`);
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

if (process.argv.includes('--stop-only')) process.exit(0);

const fresh = await connect({ spawnOnDemand: true });
const hello = await fresh.call('hello');
console.log(`started a daemon (pid ${hello.pid}, ${hello.startedAt}); endpoint file: ${ENDPOINT_FILE}`);
fresh.close();
process.exit(0);
