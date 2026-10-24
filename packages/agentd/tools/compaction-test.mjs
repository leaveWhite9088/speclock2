/**
 * The compaction rule, for anything that can say how full its conversation is and compact it (no CLI involved).
 *
 * Checks: nothing happens with no threshold, below it, while busy, with no conversation or no figure; past it the
 * thing is compacted once and recorded; the threshold is capped at 90 % of the window; it does not loop when a
 * compaction did not help; a failed compaction leaves it free to try again and is not recorded.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTD_LABELS_FILE = join(mkdtempSync(join(tmpdir(), 'agentd-compact-')), 'labels.json');
const { compactIfNeeded } = await import('../core/pool/compaction.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== compaction rule ===\n');

let n = 0;
const target = (over = {}) => {
  const t = {
    name: `t${++n}`,
    owner: {},
    compactAt: 100_000,
    busy: false,
    sessionKey: 'S1',
    figure: { used: 150_000, size: 1_000_000, percent: 15 },
    compacted: 0,
    infos: [],
    context() {
      return this.figure;
    },
    async compact() {
      this.compacted++;
      if (this.fail) throw new Error('pi said no');
    },
    onCompact(i) {
      this.infos.push(i);
    },
    ...over,
  };
  return t;
};
const run = async (t) => {
  await compactIfNeeded(t);
  return t;
};

check('no threshold: nothing', (await run(target({ compactAt: null }))).compacted === 0);
check('below the threshold: nothing', (await run(target({ figure: { used: 50_000, size: 1_000_000, percent: 5 } }))).compacted === 0);
check('busy: nothing', (await run(target({ busy: true }))).compacted === 0);
check('no conversation: nothing', (await run(target({ sessionKey: null }))).compacted === 0);
check('no figure: nothing', (await run(target({ figure: null }))).compacted === 0 && (await run(target({ figure: { used: null, size: null, percent: null } }))).compacted === 0);

const t = await run(target());
check('past the threshold: compacted once', t.compacted === 1);
check('and announced, with how many times so far', t.infos.length === 1 && t.infos[0].compactions === 1 && t.infos[0].before.used === 150_000, JSON.stringify(t.infos[0]));
check('the flag is free again afterwards', t.owner._compacting === false);

// the same conversation again at once: the last compaction did not bring it down, so do not loop
const again = await run({ ...t, compacted: 0, infos: [] });
check('it does not loop when the size did not come down', again.compacted === 0);

// the threshold is at most 90 % of the window
const small = await run(target({ compactAt: 900_000, figure: { used: 95_000, size: 100_000, percent: 95 } }));
check('a threshold above the window still acts at 90 % of it', small.compacted === 1);

// a failure is not recorded, and the next check may try again
const bad = target({ fail: true });
await run(bad);
check('a failed compaction is not announced', bad.compacted === 1 && bad.infos.length === 0);
check('and the flag is released', bad.owner._compacting === false);
bad.fail = false;
await run(bad);
check('the next check tries again', bad.compacted === 2 && bad.infos.length === 1);

// a second call while one runs does nothing
let release;
const slow = target({ compact: () => new Promise((r) => (release = r)) });
const first = compactIfNeeded(slow);
await new Promise((r) => setTimeout(r, 20));
let second = 0;
await compactIfNeeded({ ...slow, compact: async () => second++ });
check('a check while one compaction runs does nothing', second === 0);
release();
await first;

// the figure after comes from contextAfter when there is one
const withAfter = target({ contextAfter: async () => ({ used: 20_000, size: 1_000_000, percent: 2 }) });
await run(withAfter);
check('the figure after is taken fresh when it can be', withAfter.infos[0]?.after?.used === 20_000);

console.log(process.exitCode ? '\n=> ✗ COMPACTION RULE BROKEN' : '\n=> ✓ COMPACTION RULE OK');
process.exit(process.exitCode ?? 0);
