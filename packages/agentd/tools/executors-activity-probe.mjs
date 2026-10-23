/**
 * Probe: what each CLI shows of its own work. One executor per type in a temporary project; each is asked to create
 * a file with its tools. Afterwards its transcript is read: tool calls, what they were given and returned, and the
 * reasoning. Uses real models (a few thousand tokens per CLI).
 *
 * Usage: node tools/executors-activity-probe.mjs [type ...]      (default: mcode dsh opencode claude codex pi)
 */

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler } from './lib/scheduler.mjs';

const TYPES = process.argv.slice(2).length ? process.argv.slice(2) : ['mcode', 'dsh', 'opencode', 'claude', 'codex', 'pi'];
const P = `ea${Date.now().toString(36)}`;
const root = mkdtempSync(join(tmpdir(), 'agentd-act-'));
for (const t of TYPES) mkdirSync(join(root, t));
const s = await Scheduler.open();
const call = (op, args) => s.c.call(op, args, { timeoutMs: 300_000 });
const rows = [];

try {
  await call('project.create', { id: P, name: 'probe', root });
  for (const t of TYPES) await call('project.addInstance', { project: P, id: t, type: t, dir: `./${t}` });
  for (const t of TYPES) {
    const key = `${P}~${t}`;
    const row = { type: t };
    try {
      const progress = [];
      const off = s.c.on('progress', (ev) => {
        if (ev.agent === key) progress.push(ev);
      });
      await call('subscribe', { jobId: '*' }).catch(() => {});
      const r = await s.run(key, 'Use your tools: create a file named a.txt in the current directory containing exactly the word HELLO. Then reply with only: DONE', { timeoutMs: 300_000 });
      off();
      const tr = await call('transcript', { agent: key, sessionId: r.sessionId, limit: 200 });
      const tools = tr.entries.filter((e) => e.role === 'tool');
      const started = tools.filter((e) => e.status !== 'completed' && e.status !== 'failed');
      const ended = tools.filter((e) => e.status === 'completed' || e.status === 'failed');
      Object.assign(row, {
        wrote: existsSync(join(root, t, 'a.txt')),
        calls: started.length,
        // the arguments may come with the start or only with a later update, so the end entry counts too
        withInput: tools.filter((e) => e.input).map((e) => e.toolCallId).filter((id, i, all) => all.indexOf(id) === i).length,
        withOutput: ended.filter((e) => e.output).length,
        thought: tr.entries.filter((e) => e.role === 'thought').length,
        thinkingChars: r.metrics?.thinkingChars ?? 0,
        progress: progress.length,
        withTool: progress.filter((e) => e.tool).length,
        sample: ended[0] ? `${ended[0].title} | in: ${String(ended[0].input ?? '').replace(/\s+/g, ' ').slice(0, 45)} | out: ${String(ended[0].output ?? '').replace(/\s+/g, ' ').slice(0, 45)}` : '-',
      });
    } catch (e) {
      row.error = e.message.slice(0, 120);
    }
    rows.push(row);
    console.log(JSON.stringify(row));
  }
} finally {
  await call('project.remove', { project: P, force: true }).catch(() => {});
}
s.close();
console.log('\ntype      wrote calls input output thought(chars) progress(with tool)');
for (const r of rows) {
  console.log(
    r.error
      ? `${r.type.padEnd(9)} ERROR ${r.error}`
      : `${r.type.padEnd(9)} ${String(r.wrote).padEnd(5)} ${String(r.calls).padEnd(5)} ${String(r.withInput).padEnd(5)} ${String(r.withOutput).padEnd(6)} ${r.thought}(${r.thinkingChars})`.padEnd(46) + ` ${r.progress}(${r.withTool})`,
  );
}
process.exit(0);
