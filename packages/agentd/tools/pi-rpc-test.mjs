/**
 * The shared pi RPC client, against a fake pi process (no model, no real pi).
 *
 * Checks:
 *   1. a command gets pi's `data`; a failed answer rejects with the pi's message and the label
 *   2. a command that is not answered times out; a command with no process fails at once
 *   3. a turn sets `streaming` from agent_start to agent_settled, and waiters resolve at the settle
 *   4. listeners see every record that is not a command's answer, a broken listener does not stop the others
 *   5. the context figure is read from pi's statistics
 *   6. pi exiting fails what was pending and what waited for a settle, and calls onClose
 *   7. the named commands send the right command names
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiRpc } from '../core/pi-rpc.mjs';
import { check } from './lib/scheduler.mjs';

console.log('\n=== pi rpc client ===\n');

const dir = mkdtempSync(join(tmpdir(), 'agentd-pirpc-'));
const script = join(dir, 'fake-pi.mjs');
writeFileSync(
  script,
  `
import { appendFileSync } from 'node:fs';
const out = (o) => console.log(JSON.stringify(o));
const log = ${JSON.stringify(join(dir, 'seen.txt'))};
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf(String.fromCharCode(10))) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    appendFileSync(log, m.type + String.fromCharCode(10));
    const ok = (data) => out({ type: 'response', id: m.id, success: true, data });
    if (m.type === 'get_state') ok({ sessionFile: '/x/s.jsonl' });
    else if (m.type === 'get_session_stats') ok({ contextUsage: { tokens: 1234, contextWindow: 10000, percent: 12.34 }, tokens: { input: 5 } });
    else if (m.type === 'bad') out({ type: 'response', id: m.id, success: false, error: 'no such thing' });
    else if (m.type === 'silent') { /* never answers */ }
    else if (m.type === 'prompt') {
      ok({ disposition: 'started' });
      out({ type: 'agent_start' });
      out({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } });
      setTimeout(() => out({ type: 'agent_settled' }), 150);
    } else if (m.type === 'die') process.exit(3);
    else ok({ echoed: m.type, params: m });
  }
});
`,
);

const closed = [];
const pi = new PiRpc({ label: 'fakepi', log: () => {} });
pi.onClose = (code) => closed.push(code);

// 2: no process yet
await pi.command('get_state').then(
  () => check('a command with no process fails at once', false),
  (e) => check('a command with no process fails at once', /not running/.test(e.message), e.message),
);

pi.start({ cmd: process.execPath, args: [script], cwd: dir, env: process.env });
check('it reports running once started', pi.running === true);
check('starting twice is refused', (() => { try { pi.start({ cmd: process.execPath, args: [script], cwd: dir, env: process.env }); return false; } catch { return true; } })());

// 1
const st = await pi.state();
check('a command resolves with pi\'s data', st?.sessionFile === '/x/s.jsonl', JSON.stringify(st));
await pi.command('bad').then(
  () => check('a failed answer rejects', false),
  (e) => check('a failed answer rejects with pi\'s message and the label', e.message === 'fakepi bad failed: no such thing', e.message),
);

// 2
const t0 = Date.now();
await pi.command('silent', {}, 300).then(
  () => check('an unanswered command times out', false),
  (e) => check('an unanswered command times out', /timed out after 300ms/.test(e.message) && Date.now() - t0 < 2000, e.message),
);
check('and leaves nothing pending', pi.pending.size === 0);

// 3, 4
const seen = [];
const off = pi.addListener((rec) => seen.push(rec.type));
pi.addListener(() => {
  throw new Error('a broken listener');
});
let after = null;
pi.addListener((rec) => rec.type === 'message_update' && (after = rec.assistantMessageEvent.delta));
const settled = pi.waitSettled(5000);
const r = await pi.command('prompt', { message: 'x' });
check('prompt is answered', r?.disposition === 'started');
await new Promise((r) => setTimeout(r, 50));
check('streaming is on during the turn', pi.streaming === true);
await settled;
check('a waiter resolves at the settle, and streaming is off', pi.streaming === false);
check('listeners saw the events, not the command answers', seen.join() === 'agent_start,message_update,agent_settled', seen.join());
check('a broken listener did not stop the next one', after === 'hi');
off();

// 5
const ctx = await pi.context();
check('the context figure comes from pi statistics', ctx?.used === 1234 && ctx.size === 10000 && ctx.percent === 12.3, JSON.stringify(ctx));
check('no statistics, no figure', PiRpc.contextOf({}) === null && PiRpc.contextOf(null) === null);

// 7
await pi.compact();
await pi.abort();
await pi.newSession();
await pi.switchSession('/x/y.jsonl');
await pi.setModel('p', 'm');
await pi.setThinking('high');
await pi.models();
await pi.thinkingLevels();
await pi.messages();
const sent = (await import('node:fs')).readFileSync(join(dir, 'seen.txt'), 'utf8').split('\n').filter(Boolean);
check('the named commands send the right names', ['compact', 'abort', 'new_session', 'switch_session', 'set_model', 'set_thinking_level', 'get_available_models', 'get_available_thinking_levels', 'get_messages'].every((n) => sent.includes(n)), sent.slice(-9).join());

// 6
const waiter = pi.waitSettled(5000).then(() => 'settled', (e) => e.message);
const pend = pi.command('die', {}, 5000).then(() => 'answered', (e) => e.message);
check('a command pending when pi exits fails', /pi rpc exited/.test(await pend));
check('a waiter pending when pi exits fails too', /exited before the run settled/.test(await waiter));
await new Promise((r) => setTimeout(r, 100));
check('onClose was called with the exit code', closed.join() === '3', closed.join());
check('and it no longer reports running', pi.running === false && pi.streaming === false);

console.log(process.exitCode ? '\n=> ✗ PI RPC BROKEN' : '\n=> ✓ PI RPC OK');
process.exit(process.exitCode ?? 0);
