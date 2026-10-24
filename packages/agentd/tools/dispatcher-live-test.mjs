/**
 * The dispatcher, live, in-process (real pi and a real model; the shared daemon is not involved):
 *   1. it compacts by itself past a set size, between turns, and the figure comes down
 *   2. it can be handed over to a fresh conversation: the document is its own reply, the new conversation is told
 *      what the document said, the old conversation is still there
 *
 * Usage: node tools/dispatcher-live-test.mjs
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agentd-dlive-'));
process.env.AGENTD_LABELS_FILE = join(dir, 'labels.json');
const { Dispatcher } = await import('../core/dispatcher.mjs');
const { createHandoffs } = await import('../core/handoff.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== dispatcher live: compaction and handoff ===\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = [];
const d = new Dispatcher({ cwd: dir, project: 'livetest', sessionDir: join(dir, 'sessions'), onEvent: (e) => events.push(e), compactAt: 50_000 });
const compacted = [];
d.onCompact = (i) => compacted.push(i);

const turn = async (message) => {
  await d.prompt(message);
  for (let i = 0; i < 120 && (d.busy || d.queue.length); i++) await sleep(1000);
  await sleep(1500); // the figure is read when the turn ends
};
const figure = () => d.context?.used ?? null;

try {
  // 1. pi only compacts what lies before its last ~20K tokens, and cannot cut inside one message: so the conversation has
  // to be big AND made of many turns, as a real one is
  await turn('Remember the codename MANGO-77. Reply with exactly: OK');
  const sizes = [figure()];
  const filler = (n) => Array.from({ length: 1500 }, (_, i) => `entry${n}x${i}`).join(' ');
  for (let i = 0; i < 12 && compacted.length === 0; i++) {
    await turn(`Here is a log, only read it and reply with exactly: OK
${filler(i)}`);
    sizes.push(figure());
    await sleep(compacted.length || sizes.at(-1) > 45_000 ? 20000 : 500); // a compaction, once started, takes a moment
  }
  console.log(`  context sizes after each turn: ${sizes.join(' -> ')}`);
  check('the dispatcher has a context figure', sizes[0] > 0, String(sizes[0]));
  check('past its threshold it compacted by itself', compacted.length >= 1, `${compacted.length} compaction(s)`);
  // pi reports the size as unknown until the next reply, so "after" may be empty right away; the next turn shows it
  const before = compacted[0]?.before?.used;
  check('the compaction started from a big conversation', before > 45_000, String(before));;
  check('it was counted once', compacted[0]?.compactions === 1 && d.compactions() === 1, String(d.compactions()));
  check('and the conversation still works', (await (async () => { await turn('Reply with exactly: STILL-HERE'); return d.messages(); })()).messages.some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('STILL-HERE')));
  check('and the figure is down on the next turn', figure() != null && figure() < before - 10_000, JSON.stringify([before, figure()]));

  // 2
  d.compactAt = null;
  const old = (await d.state()).sessionFile;
  const handoffs = createHandoffs({ getAgent: () => d.asHandoffTarget(), keyOf: (p, i) => `${p}~${i}`, onChange: () => {} });
  const prop = handoffs.propose({ project: 'livetest', agent: '@dispatcher', reason: 'test', evidence: 'e' });
  handoffs.generate({ id: prop.id });
  let h = null;
  for (let i = 0; i < 90; i++) {
    h = handoffs.list({ project: 'livetest' }).handoffs.find((x) => x.id === prop.id);
    if (h?.status === 'review' || h?.error) break;
    await sleep(2000);
  }
  check('the dispatcher wrote a handoff document as its reply', h?.status === 'review' && h.doc?.length > 50, h?.error ?? `${h?.doc?.length} chars`);
  check('which carries what was worth keeping', /MANGO-77/.test(h?.doc ?? ''));

  handoffs.apply({ id: prop.id, text: h.doc });
  for (let i = 0; i < 90; i++) {
    h = handoffs.list({ project: 'livetest' }).handoffs.find((x) => x.id === prop.id);
    if (!h || h.error) break; // done leaves the list
    await sleep(2000);
  }
  check('the handoff was applied', !h, h?.error ?? h?.status);
  await sleep(1500);
  const fresh = (await d.state()).sessionFile;
  check('the dispatcher is on a new conversation', fresh && fresh !== old, JSON.stringify([old?.slice(-14), fresh?.slice(-14)]));
  await turn('What is the codename of this project? Reply with only the codename.');
  const last = [...(await d.messages()).messages].reverse().find((m) => m.role === 'assistant');
  check('and it knows what the document said', /MANGO-77/.test(JSON.stringify(last?.content ?? '')), JSON.stringify(last?.content ?? '').slice(0, 80));
  check('the old conversation is still in the list', d.sessions().sessions.some((s) => s.file === old));
} finally {
  await d.shutdown();
}
console.log(process.exitCode ? '\n=> ✗ DISPATCHER LIVE BROKEN' : '\n=> ✓ DISPATCHER LIVE OK');
process.exit(process.exitCode ?? 0);
