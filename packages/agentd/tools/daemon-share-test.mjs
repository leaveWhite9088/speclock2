/**
 * The point of the daemon: independent clients share one set of agents.
 *
 * Opens two separate client connections (like two pi sessions would), runs on
 * both, then checks that the daemon reports one spawn, one agent pid and one
 * active session, and that it survives both clients disconnecting.
 *
 * Usage: node tools/daemon-share-test.mjs [agent]
 */

import { Scheduler, check } from './lib/scheduler.mjs';

const AG = process.argv[2] || 'dsh';
console.log(`\n=== shared daemon: ${AG} ===\n`);

const A = await Scheduler.open();
const B = await Scheduler.open();

const hello = await A.hello();
console.log(`  daemon pid ${hello.pid}, started ${hello.startedAt}`);
console.log(`  base cwd ${hello.baseCwd}`);

const ra = await A.run(AG, 'Reply with exactly: A-SIDE');
const rb = await B.run(AG, 'Reply with exactly: B-SIDE');
console.log(`  client A -> ${JSON.stringify(ra.text.trim().slice(0, 40))}`);
console.log(`  client B -> ${JSON.stringify(rb.text.trim().slice(0, 40))}`);

const sa = await A.status(AG);
const sb = await B.status(AG);
console.log(`  A sees pid ${sa.pid}, session ${sa.sessionId}`);
console.log(`  B sees pid ${sb.pid}, session ${sb.sessionId}`);

const { agents } = await A.agents();
const entry = agents.find((x) => x.name === AG);

check('one spawn for the agent', entry?.spawns === 1, `spawns=${entry?.spawns}`);
check('both clients see the same agent process', sa.pid === sb.pid, `${sa.pid}`);
check('both clients see the same active session', sa.sessionId === sb.sessionId);
check(
  'each agent is listed once (no duplicate connections)',
  new Set(agents.map((x) => x.name)).size === agents.length,
  agents.map((x) => x.name).join(','),
);

A.close();
B.close();

// The daemon must outlive its clients.
await new Promise((r) => setTimeout(r, 800));
const C = await Scheduler.open();
const hello2 = await C.hello();
check('daemon survives clients disconnecting', hello2.pid === hello.pid, `pid ${hello2.pid}`);
C.close();

console.log(
  process.exitCode ? '\n=> ✗ NOT UNIFIED' : '\n=> ✓ ONE DAEMON, ONE SET OF AGENTS',
);
