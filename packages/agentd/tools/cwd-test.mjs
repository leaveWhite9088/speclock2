/**
 * Per-agent working directory regression.
 *
 * Each agent instance may start in its own directory (agentd.config.json). This
 * checks that the configured default is actually used for sessions, and that an
 * explicit cwd on a request still wins.
 *
 * Usage: node tools/cwd-test.mjs
 */

import { existsSync } from 'node:fs';
import { Scheduler, check } from './lib/scheduler.mjs';

console.log('\n=== per-agent working directory ===\n');

const s = await Scheduler.open();
const { agents } = await s.agents();
let configured = 0;

for (const a of agents) {
  const st = await s.status(a.name);
  const want = st.defaultCwd;
  if (!want) {
    console.log(`  ${a.name.padEnd(6)} (no configured cwd, uses base)`);
    continue;
  }
  if (!existsSync(want)) {
    console.log(`  ${a.name.padEnd(6)} (its directory is gone: left over from another test, skipped)`);
    continue;
  }
  configured += 1;
  await s.models(a.name); // force a session so cwd is materialised
  const now = await s.status(a.name);
  console.log(`  ${a.name.padEnd(6)} cwd = ${now.cwd}`);
  check(`${a.name} starts in its configured directory`, now.cwd === want, want);
}

check('at least one agent has a configured cwd', configured > 0, `${configured}`);

// An explicit cwd must still override the configured default for that session.
const target = agents.map((a) => a.name).find((n) => n === 'dsh') ?? agents[0].name;
const override = 'D:/Project2/code-261013-speclock2/sandbox/testpath';
await s.c.call('new', { agent: target, cwd: override }).catch(() => null);
const st = await s.status(target);
const sessions = await s.sessions(target);
const usedOverride = sessions.sessions.some((x) => x.active && String(x.cwd).replace(/\\/g, '/') === override);
console.log(`  explicit cwd override on ${target}: ${usedOverride ? 'applied' : 'not applied'} (cwd now ${st.cwd})`);
check('explicit cwd overrides the configured default', usedOverride);

s.close();
console.log(process.exitCode ? '\n=> ✗ CWD HANDLING BROKEN' : '\n=> ✓ PER-AGENT CWD OK');
