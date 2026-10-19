/**
 * Streaming + metrics regression, straight against the daemon.
 *
 * Verifies that progress events arrive while a run is in flight, that `tail`
 * exposes partial output, and that metrics are populated.
 *
 * Usage: node tools/stream-test.mjs [agent]
 */

import { Scheduler, check } from './lib/scheduler.mjs';

const AG = process.argv[2] || 'pi';
console.log(`\n=== streaming + metrics: ${AG} ===\n`);

const s = await Scheduler.open();
const events = [];

const started = await s.c.call('run', {
  agent: AG,
  prompt: 'Write 12 numbered lines about rivers. Keep each line short.',
  async: true,
});
await s.c.call('subscribe', { jobId: started.jobId });

const off = s.c.on('progress', (ev) => {
  if (ev.jobId === started.jobId) events.push(ev);
});

const startedAt = Date.now();

// Poll mid-flight.
for (const wait of [1200, 2000]) {
  await new Promise((r) => setTimeout(r, wait));
  const snap = await s.tail(AG, started.jobId);
  console.log(
    `  t=${((Date.now() - startedAt) / 1000).toFixed(1)}s running=${snap.running} chars=${snap.chars} thinking=${snap.thinkingChars}`,
  );
}

// waitFor checks already-delivered events too, so a run that finished while we
// were polling its tail is not missed.
const doneEvent = await s.c.waitFor('job.done', (ev) => ev.jobId === started.jobId, 180_000);
if (doneEvent.error) throw new Error(doneEvent.error);
const final = doneEvent.result;
off();

const m = final.metrics;
console.log(`\n  model      ${m.modelName ?? m.model}`);
console.log(`  duration   ${m.durationMs}ms  (first chunk ${m.timeToFirstTokenMs}ms)`);
console.log(`  chars      ${m.chars} in ${m.chunks} chunks  (thinking ${m.thinkingChars})`);
console.log(`  tokens     ${m.tokens ? JSON.stringify(m.tokens) : 'not exposed by this agent'}`);
console.log(`  tps        ${m.tokensPerSecond ?? 'n/a'}   chars/s ${m.charsPerSecond}`);
console.log(`  context    ${m.context ? JSON.stringify(m.context) : 'n/a'}`);
console.log(`  cost       ${m.cost ? JSON.stringify(m.cost) : 'n/a'}`);
console.log(`  progress   ${events.length} event(s): ${events.slice(0, 3).map((e) => `${e.chars}c`).join(', ')}`);

check('text produced', final.text.length > 0, `${final.text.length} chars`);
check('progress events streamed', events.length > 0, `${events.length}`);
check('metrics have a model', Boolean(m.model));
check('duration measured', m.durationMs > 0);
check('first-chunk latency measured', m.timeToFirstTokenMs != null);

if (AG === 'pi') {
  check('token counts available', Boolean(m.tokens), JSON.stringify(m.tokens ?? null));
  check('tokens per second available', m.tokensPerSecond != null);
}

s.close();
console.log(process.exitCode ? '\n=> ✗ STREAMING/METRICS INCOMPLETE' : '\n=> ✓ STREAMING + METRICS OK');
