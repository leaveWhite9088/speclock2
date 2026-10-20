/**
 * Start-up resilience, with no real CLI involved.
 *
 * Checks:
 *   1. a process that dies while starting is retried, then fails with a message that names
 *      the reason and carries the tail of its stderr
 *   2. a process that fails once and then works is started on the retry
 *   3. a later use tries again (a failed start does not poison the instance)
 */

import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstance } from '../core/agent-pool.mjs';
import { check } from './lib/scheduler.mjs';

console.log('\n=== start retry ===\n');

const dir = mkdtempSync(join(tmpdir(), 'agentd-retry-'));
const counter = join(dir, 'count');
writeFileSync(counter, '0');

// A fake ACP agent: dies on the first N starts, answers `initialize` afterwards.
const script = join(dir, 'fake.mjs');
writeFileSync(
  script,
  `
import { readFileSync, writeFileSync } from 'node:fs';
const f = ${JSON.stringify(counter)};
const n = Number(readFileSync(f, 'utf8')) + 1;
writeFileSync(f, String(n));
const failFirst = Number(process.argv[2]);
if (n <= failFirst) { console.error('boom: lock held by another process'); process.exit(1); }
process.stdin.on('data', (d) => {
  for (const line of String(d).split('\\n').filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.method === 'initialize') console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { agentInfo: { name: 'fake' }, agentCapabilities: {} } }));
  }
});
`,
);

const make = (id, failFirst) => {
  const a = buildInstance({ id, type: 'dsh', cwd: dir });
  a.spec.cmd = process.execPath;
  a.spec.args = [script, String(failFirst)];
  return a;
};

// 1. always dies
const dead = make('retry-dead', 99);
await dead._init().then(
  () => check('a process that never starts fails', false),
  (e) => {
    check('failure says it could not start', /could not start/.test(e.message), e.message);
    check('failure carries the stderr tail', /lock held/.test(e.message), e.message);
  },
);
check('it was tried three times', dead.spawnCount === 3, `${dead.spawnCount}`);

// 2. dies once, then works
writeFileSync(counter, '0');
const flaky = make('retry-flaky', 1);
const caps = await flaky._init().then(() => 'ok', (e) => e.message);
check('a process that dies once starts on the retry', caps === 'ok', String(caps));
check('it took two spawns', flaky.spawnCount === 2, `${flaky.spawnCount}`);
await flaky.shutdown();

// 3. a later use tries again
writeFileSync(counter, '0');
const later = make('retry-later', 3);
await later._init().catch(() => {});
const again = await later._init().then(() => 'ok', (e) => e.message);
check('a failed start does not poison the instance', again === 'ok', String(again));
await later.shutdown();

console.log(process.exitCode ? '\n=> ✗ START RETRY BROKEN' : '\n=> ✓ START RETRY OK');
process.exit(process.exitCode ?? 0);
