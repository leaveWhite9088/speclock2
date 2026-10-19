import { Scheduler } from './lib/scheduler.mjs';

const s = await Scheduler.open();
const t0 = performance.now();
const h = await s.hello();
const connectMs = performance.now() - t0;
console.log(`connect (daemon already up): ${connectMs.toFixed(0)}ms  pid=${h.pid}`);

for (const ag of ['dsh', 'mcode']) {
  // warm?
  const before = await s.status(ag);
  console.log(`\n${ag}: alive=${before.alive} pid=${before.pid}`);

  const t1 = performance.now();
  const r = await s.run(ag, 'Reply with exactly: OK');
  const total = performance.now() - t1;
  const m = r.metrics;
  console.log(`  total ${total.toFixed(0)}ms  | agent duration ${m.durationMs}ms  | scheduler overhead ${(total - m.durationMs).toFixed(0)}ms`);
  console.log(`  ttft ${m.timeToFirstTokenMs}ms  model ${m.modelName}`);
}
s.close();
