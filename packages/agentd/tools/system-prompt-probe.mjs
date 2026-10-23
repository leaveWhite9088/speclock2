/**
 * Probe: does each CLI obey rules we hand it through its own system-prompt channel, with nothing written into the project?
 *
 * For every type an executor starts in an empty temporary folder (no AGENTS.md, no CLAUDE.md) with a rule that makes
 * every reply end in a marker word. It is asked something harmless twice: once in the new session, and once after its
 * process was stopped and the session resumed (does the rule survive a restart?). In-process: the shared daemon is
 * not involved. Uses real models (a few thousand tokens per CLI).
 *
 * Usage: node tools/system-prompt-probe.mjs [type ...]      (default: mcode dsh opencode claude codex pi)
 */

import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInstance } from '../core/agent-pool.mjs';

const TYPES = process.argv.slice(2).length ? process.argv.slice(2) : ['mcode', 'dsh', 'opencode', 'claude', 'codex', 'pi'];
const rows = [];

for (const type of TYPES) {
  const marker = `ZEBRA-${type.toUpperCase()}`;
  const rule = `Rule from the project owner, it applies to every reply you write in this conversation: finish every reply with the exact word ${marker} on a line of its own, whatever the question is.`;
  const dir = mkdtempSync(join(tmpdir(), `agentd-sp-${type}-`));
  const a = buildInstance({ id: `sp-${type}`, type, cwd: dir, systemPrompt: rule });
  const inj = a._inj();
  const row = { type, via: inj.prefix ? 'first message' : inj.args.length ? inj.args[0] : Object.keys(inj.env)[0] ?? (inj.meta ? `_meta.${Object.keys(inj.meta)[0]}` : '-') };
  try {
    const r1 = await a.startPrompt('Say hello in one short sentence.', { timeoutMs: 240_000 }).done;
    row.first = r1.text.includes(marker);
    row.sample1 = JSON.stringify(r1.text.trim().slice(-60));
    const sid = r1.sessionId;
    await a.shutdown();
    await new Promise((r) => setTimeout(r, 1500));
    const r2 = await a.startPrompt('Now name one colour in one short sentence.', { timeoutMs: 240_000, sessionId: sid }).done;
    row.resumed = r2.sessionId === sid;
    row.second = r2.text.includes(marker);
    row.sample2 = JSON.stringify(r2.text.trim().slice(-60));
    row.projectFiles = readdirSync(dir).filter((f) => !f.startsWith('.')).length + readdirSync(dir).filter((f) => f.startsWith('.')).length;
  } catch (e) {
    row.error = e.message.slice(0, 140);
  }
  await a.shutdown().catch(() => {});
  rows.push(row);
  console.log(JSON.stringify(row));
}

console.log('\ntype      via                                first reply  after resume  files in project');
for (const r of rows) {
  console.log(
    r.error
      ? `${r.type.padEnd(9)} ERROR ${r.error}`
      : `${r.type.padEnd(9)} ${String(r.via).slice(0, 34).padEnd(34)} ${String(r.first).padEnd(12)} ${String(r.second).padEnd(13)} ${r.projectFiles}`,
  );
}
process.exit(0);
