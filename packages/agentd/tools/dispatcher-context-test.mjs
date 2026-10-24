/**
 * How full the dispatcher's conversation is, and compacting it, on their own: fake pi commands and a fake turn queue.
 *
 * Checks:
 *   1. the figure is read from pi's statistics, kept on disk, and still readable without any process
 *   2. no threshold, a turn running, or no process: nothing is compacted
 *   3. past the threshold pi is asked to compact, the dispatcher is held busy meanwhile, and it is announced and counted once
 *   4. the conversation in use is the one the count follows
 *   5. a compaction that did not bring the figure down is not repeated at once; a failing one is survived
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agentd-dctx-'));
process.env.AGENTD_LABELS_FILE = join(dir, 'labels.json');
const { ContextTracker, savedContext } = await import('../core/dispatcher/context.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== dispatcher context and compaction ===\n');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let used = 5_000;
let shrink = true;
let failCompact = false;
let session = join(dir, 'one.jsonl');
const calls = [];
const holds = [];
let busy = false;
let running = true;
let compactAt = null;
const announced = [];
let resume = null;

const turns = {
  get busy() {
    return busy;
  },
  hold: async (work) => {
    busy = true;
    holds.push('start');
    try {
      return await work();
    } finally {
      busy = false;
      holds.push('end');
    }
  },
};
const command = async (type) => {
  calls.push(type);
  switch (type) {
    case 'get_session_stats':
      return { contextUsage: { tokens: used, contextWindow: 1_000_000, percent: used / 10_000 } };
    case 'get_state':
      return { sessionFile: session };
    case 'compact':
      await sleep(40);
      if (failCompact) throw new Error('pi could not compact');
      if (shrink) used = 3_000;
      return {};
    default:
      return {};
  }
};
const t = new ContextTracker({
  sessionDir: dir,
  name: 'dispatcher:ctx-test',
  command,
  turns,
  running: () => running,
  compactAt: () => compactAt,
  onCompact: (i) => announced.push(i),
  sessionFile: { get: () => resume, set: (f) => (resume = f) },
});

// 1
check('before anything is read there is no figure', t.value === null && savedContext(dir) === null);
t.refresh();
await sleep(60);
check('the figure comes from pi statistics', t.value?.used === 5_000 && t.value?.size === 1_000_000 && t.value?.percent === 0.5, JSON.stringify(t.value));
check('it is kept on disk, and readable without the process', savedContext(dir)?.used === 5_000);

// 2
used = 800_000;
await t.maybeCompact();
check('with no threshold nothing is compacted', !calls.includes('compact'));
compactAt = 100_000;
busy = true;
await t.maybeCompact();
check('while a turn runs nothing is compacted', !calls.includes('compact'));
busy = false;
running = false;
await t.maybeCompact();
check('with no process nothing is compacted', !calls.includes('compact'));
running = true;
t.value = { used: 50_000, size: 1_000_000, percent: 5 };
await t.maybeCompact();
check('under the threshold nothing is compacted', !calls.includes('compact'));

// 3
t.value = { used: 150_000, size: 1_000_000, percent: 15 };
used = 150_000;
await t.maybeCompact();
check('past the threshold pi is asked to compact', calls.includes('compact'));
check('the dispatcher was held busy for it, and is free again', holds.join() === 'start,end' && !busy, holds.join());
check('it is announced once, with the sizes before and after', announced.length === 1 && announced[0].before.used === 150_000 && announced[0].after.used === 3_000 && announced[0].compactions === 1, JSON.stringify(announced[0]));
check('and the figure is down, on disk too', t.value.used === 3_000 && savedContext(dir).used === 3_000);

// 4
check('the conversation in use is the one the count follows', resume === session && t.compactions() === 1, `${resume} / ${t.compactions()}`);
session = join(dir, 'two.jsonl');
resume = session;
check('another conversation has its own count', t.compactions() === 0);
resume = join(dir, 'one.jsonl');
check('and the first still has its own', t.compactions() === 1);

// 5
session = join(dir, 'three.jsonl');
shrink = false;
used = 200_000;
t.value = { used: 200_000, size: 1_000_000, percent: 20 };
await t.maybeCompact();
check('a second conversation can be compacted', announced.length === 2 && announced[1].compactions === 1, String(announced.length));
used = 200_000;
t.value = { used: 200_000, size: 1_000_000, percent: 20 };
const callsBefore = calls.filter((c) => c === 'compact').length;
await t.maybeCompact();
check('one that did not shrink is not compacted again at once', calls.filter((c) => c === 'compact').length === callsBefore);
session = join(dir, 'four.jsonl');
failCompact = true;
t.value = { used: 300_000, size: 1_000_000, percent: 30 };
await t.maybeCompact();
check('a compaction that fails is survived: free again, nothing announced', !busy && announced.length === 2 && t._compacting === false);

console.log(process.exitCode ? '\n=> ✗ DISPATCHER CONTEXT BROKEN' : '\n=> ✓ DISPATCHER CONTEXT OK');
process.exit(process.exitCode ?? 0);
