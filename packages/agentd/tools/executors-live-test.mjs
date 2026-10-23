/**
 * Live check of the newer CLI types (opencode, claude, codex) as project executors.
 *
 * One project, one executor per type, each in its own folder. For each: the guide and skill files land where that
 * CLI reads them, the executor really writes a file in its own folder, the context figure shows up, the session
 * survives a daemon restart, and a second turn remembers the first.
 *
 * Usage: node tools/executors-live-test.mjs [type ...]      (default: opencode claude codex)
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler, check, stopDaemon } from './lib/scheduler.mjs';

const TYPES = process.argv.slice(2).length ? process.argv.slice(2) : ['opencode', 'claude', 'codex'];
console.log(`\n=== live executors: ${TYPES.join(', ')} ===\n`);

const P = `lv${Date.now().toString(36)}`;
const root = mkdtempSync(join(tmpdir(), 'agentd-live-'));
for (const t of TYPES) mkdirSync(join(root, t));

let s = await Scheduler.open();
const call = (op, args) => s.c.call(op, args);
const key = (t) => `${P}~${t}`;
const sessions = {};

try {
  await call('project.create', { id: P, name: 'live', root });
  for (const t of TYPES) await call('project.addInstance', { project: P, id: t, type: t, dir: `./${t}` });

  for (const t of TYPES) {
    const dir = join(root, t);
    console.log(`\n-- ${t}`);
    check(`${t}: no guide or skill file is written into the project`, ['AGENTS.md', 'CLAUDE.md', '.agents', '.claude', '.opencode', '.minimax'].every((f) => !existsSync(join(dir, f))));
    const via = (await s.status(key(t))).rules?.via;
    check(`${t}: the rules are handed over as system instructions`, Boolean(via), String(via));

    const r = await s.run(key(t), `Create a file named hello.txt in the current directory containing exactly the word BANANA-${t}. Then reply with only: DONE`, { timeoutMs: 240_000 });
    sessions[t] = r.sessionId;
    check(`${t}: replies`, /DONE/i.test(r.text), JSON.stringify(r.text.trim().slice(0, 60)));
    const file = join(dir, 'hello.txt');
    check(`${t}: wrote the file in its own folder`, existsSync(file) && readFileSync(file, 'utf8').includes(`BANANA-${t}`));
    check(`${t}: run has metrics`, r.metrics?.durationMs > 0, `${r.metrics?.durationMs}ms`);

    const row = (await call('projects')).projects.find((p) => p.id === P).instances.find((i) => i.id === t);
    check(`${t}: context figure is reported`, row?.context?.used > 0, JSON.stringify(row?.context));
    check(`${t}: canCompact is ${['claude', 'codex', 'opencode'].includes(t)}`, row?.canCompact === ['claude', 'codex', 'opencode'].includes(t));

    const r2 = await s.run(key(t), 'What word was in the file you just created? Reply with only that word.', { timeoutMs: 240_000 });
    check(`${t}: second turn remembers the first`, r2.text.includes(`BANANA-${t}`) && r2.sessionId === sessions[t], JSON.stringify(r2.text.trim().slice(0, 60)));
  }

  console.log('\n  restarting the daemon…');
  s.close();
  await stopDaemon();
  s = await Scheduler.open();
  for (const t of TYPES) {
    const r = await s.run(key(t), 'Reply with only the word from hello.txt in this folder (read the file).', { timeoutMs: 240_000 });
    check(`${t}: same session after restart`, r.sessionId === sessions[t], r.sessionId);
    check(`${t}: still works after restart`, r.text.includes(`BANANA-${t}`), JSON.stringify(r.text.trim().slice(0, 60)));
  }
} finally {
  await s.c.call('project.remove', { project: P, force: true }).catch(() => {});
}

s.close();
console.log(process.exitCode ? '\n=> ✗ LIVE EXECUTORS BROKEN' : '\n=> ✓ LIVE EXECUTORS OK');
