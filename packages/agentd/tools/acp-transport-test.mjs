/**
 * The wire to an agent process, on its own: a small fake agent, no sessions, no runs.
 *
 * Checks:
 *   1. a request gets its answer; an error answer is passed on as it came and marked as the CLI's own
 *   2. what the agent announces goes to `onNotification`; what it asks of us is answered (permission: allowed)
 *   3. a request with a deadline fails when the agent never answers
 *   4. a prompt that goes silent is told to cancel; one that ignores it gets its process stopped through `forceStop`
 *   5. abandoning a process fails what waits on it, and is not reported as a crash
 *   6. a process that ends by itself is reported once, and fails what waits on it
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTD_CANCEL_GRACE_MS = '400';
const { AcpTransport } = await import('../core/pool/acp-transport.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== acp transport ===\n');

const dir = mkdtempSync(join(tmpdir(), 'agentd-transport-'));
const script = join(dir, 'fake.mjs');
writeFileSync(
  script,
  `
const send = (o) => console.log(JSON.stringify({ jsonrpc: '2.0', ...o }));
process.stdin.on('data', (d) => {
  for (const line of String(d).split(String.fromCharCode(10)).filter(Boolean)) {
    const m = JSON.parse(line);
    if (m.method === 'echo') send({ id: m.id, result: { got: m.params } });
    else if (m.method === 'fail') send({ id: m.id, error: { code: -32000, message: 'quota exceeded' } });
    else if (m.method === 'announce') {
      send({ method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } } } });
      send({ id: 900, method: 'session/request_permission', params: { options: [{ optionId: 'no', kind: 'reject_once' }, { optionId: 'yes', kind: 'allow_once' }] } });
      send({ id: 901, method: 'fs/unknown', params: {} });
      send({ id: m.id, result: {} });
    } else if (m.method === 'die') process.exit(3);
    else if (m.id != null && m.method !== 'session/prompt') send({ id: m.id, result: {} });
    // session/prompt and 'silent' are never answered; session/cancel is ignored
  }
});
`,
);

const events = { notes: [], closes: [], writes: [] };
const t = new AcpTransport({
  name: 'transport-test',
  onNotification: (m) => events.notes.push(m),
  onClose: (e) => events.closes.push(e),
});
const start = () => t.spawn({ cmd: process.execPath, args: [script], env: process.env });
const settle = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

start();

// 1
const r = await t.request('echo', { a: 1 }, { timeoutMs: 5000 });
check('a request gets its answer', r?.got?.a === 1, JSON.stringify(r));
const f = await settle(t.request('fail', {}, { timeoutMs: 5000 }));
check('an error answer is passed on as it came, marked as the CLI\'s', !f.ok && f.e.message === 'quota exceeded' && f.e.source === 'cli' && f.e.code === -32000, f.e?.message);

// 2: wrap write to see what we answered
const realWrite = t.write.bind(t);
t.write = (o) => {
  events.writes.push(o);
  realWrite(o);
};
await t.request('announce', {}, { timeoutMs: 5000 });
check('what the agent announces goes to onNotification', events.notes.length === 1 && events.notes[0].params.update.content.text === 'hi');
const perm = events.writes.find((w) => w.id === 900);
check('a permission request is answered with the allowing option', perm?.result?.outcome?.optionId === 'yes', JSON.stringify(perm));
const unk = events.writes.find((w) => w.id === 901);
check('a request we do not know is refused, not left hanging', unk?.error?.code === -32601);

// 3
const slow = await settle(t.request('session/new', {}, { timeoutMs: 5000 }).then(() => t.request('session/prompt', {}, { timeoutMs: 300 })));
check('a request with a deadline fails when nothing answers', !slow.ok && /timed out after 300ms/.test(slow.e.message), slow.e?.message);
check('and leaves nothing waiting', t.pending.size === 0 || (await sleep(50), t.pending.size === 0));

// 4
events.writes.length = 0;
let forced = null;
const quiet = { begin() { this.at = Date.now(); }, quiet() { return { forMs: Date.now() - this.at, waitingOnTool: false }; } };
const t0 = Date.now();
const idle = await settle(t.request('session/prompt', { sessionId: 'S' }, { timeoutMs: 60_000, idleMs: 300, quiet, forceStop: (why) => ((forced = why), true) }));
check('a silent prompt fails after the idle time', !idle.ok && idle.e.kind === 'timeout' && /no activity for/.test(idle.e.message), idle.e?.message);
check('it was told to cancel first', events.writes.some((w) => w.method === 'session/cancel' && w.params.sessionId === 'S'));
check('then, still no answer, its process is given up on', forced && /no answer/.test(forced) && idle.e.forced === true && /process was stopped/.test(idle.e.message), String(forced));
check('after the idle time plus the grace period', Date.now() - t0 >= 600 && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);

// waiting on a tool is not silence
const busy = { begin() {}, quiet: () => ({ forMs: 99_999, waitingOnTool: true }) };
const waited = await Promise.race([settle(t.request('session/prompt', { sessionId: 'S' }, { timeoutMs: 60_000, idleMs: 300, quiet: busy })), sleep(900).then(() => 'still waiting')]);
check('waiting on a running tool is not silence', waited === 'still waiting');

// 5: abandon
const pendingReq = settle(t.request('session/prompt', { sessionId: 'S' }, { timeoutMs: 60_000 }));
await sleep(100);
const had = t.abandon(() => Object.assign(new Error('stopped'), { forced: true }));
const abandoned = await pendingReq;
check('abandoning fails what waits, with the error given', had === true && !abandoned.ok && abandoned.e.forced === true);
await sleep(500);
check('the process is gone and not reported as a crash', t.child === null && events.closes.length === 0, JSON.stringify(events.closes));
check('abandoning again does nothing', t.abandon(() => new Error('x')) === false);

// 6: ends by itself
start();
const dying = settle(t.request('session/prompt', {}, { timeoutMs: 60_000 }));
t.write({ jsonrpc: '2.0', method: 'die', id: 77 });
const died = await dying;
await sleep(200);
check('a process that ends by itself fails what waits on it', !died.ok && /ACP exited/.test(died.e.message), died.e?.message);
check('and is reported once, with its exit code', events.closes.length === 1 && events.closes[0].code === 3 && events.closes[0].replaced === false, JSON.stringify(events.closes));
check('no process is left', t.child === null);

console.log(process.exitCode ? '\n=> ✗ TRANSPORT BROKEN' : '\n=> ✓ TRANSPORT OK');
process.exit(process.exitCode ?? 0);
