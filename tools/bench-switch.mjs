/**
 * Session switch cost benchmark (live switch vs. resume from disk).
 *
 * Usage: node tools/bench-switch.mjs [agent]
 */

import { Scheduler, check } from './lib/scheduler.mjs';

const AG = process.argv[2] || 'dsh';
const ms = (n) => `${n.toFixed(2)}ms`;
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

console.log(`\n=== switch cost: ${AG} ===\n`);

const s = await Scheduler.open();

const tNew1 = performance.now();
const A = (await s.create(AG)).sessionId;
const new1 = performance.now() - tNew1;

const tNew2 = performance.now();
const B = (await s.create(AG)).sessionId;
const new2 = performance.now() - tNew2;

await s.run(AG, 'Reply with exactly A1');
await s.use(AG, A);
await s.run(AG, 'Reply with exactly A2');
await s.use(AG, B);
await s.run(AG, 'Reply with exactly B1');

const before = await s.status(AG);
console.log(`  session/new: ${ms(new1)} (cold), ${ms(new2)} (warm)`);
console.log(`  pid before: ${before.pid}, spawns: ${before.spawns}`);

const live = [];
for (let i = 0; i < 6; i++) {
  const target = i % 2 === 0 ? A : B;
  const t = performance.now();
  await s.use(AG, target);
  live.push(performance.now() - t);
}

const after = await s.status(AG);
console.log(`\n  live switch samples: ${live.map(ms).join(', ')}`);
console.log(`  median: ${ms(median(live))}`);
check('agent process unchanged', after.pid === before.pid, `${after.pid}`);
check('spawn count unchanged', after.spawns === before.spawns, `${after.spawns}`);
check('switch is sub-10ms (pointer swap, no RPC)', median(live) < 10, ms(median(live)));

s.close();
console.log(process.exitCode ? '\n=> ✗ SWITCH IS EXPENSIVE' : '\n=> ✓ SWITCHING IS A POINTER SWAP');
