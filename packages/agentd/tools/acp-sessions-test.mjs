/**
 * Which session an executor's process is on, and its model, on their own: a fake CLI behind a `request` function, no
 * process.
 *
 * Checks:
 *   1. the first use starts a session in the right directory, takes the CLI's options, applies the instance's model
 *      once, and remembers the session so a restarted process comes back to it
 *   2. the same directory reuses it; another directory starts a new one
 *   3. after the process went away the remembered session is resumed (and what it was given is put back); a CLI that
 *      says it is already active, or one that cannot resume, does not leave the executor without a session
 *   4. switching to a session that is live in the process only moves the pointer
 *   5. options are remembered per session; a model change waits while it works
 *   6. models are listed flat; a new session is a new session, whatever was remembered
 *   7. the list merges what the CLI knows, what is saved, what is live and the active one; hidden ones stay out;
 *      a created instance only lists its own directory; naming and hiding
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTD_LABELS_FILE = join(mkdtempSync(join(tmpdir(), 'agentd-sess-')), 'labels.json');
const { Sessions } = await import('../core/pool/acp/sessions.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== executor client: sessions and models ===\n');

const OPTIONS = () => [
  { id: 'model', currentValue: 'cli-default', options: [{ group: 'g', options: [{ value: 'cli-default', name: 'Default' }, { value: 'fast', name: 'Fast' }] }] },
  { id: 'effort', currentValue: 'low', options: [{ value: 'low' }, { value: 'high' }] },
];
const calls = [];
let counter = 0;
const failing = new Set();
const failMessage = {};
let remoteSessions = [];
const request = async (method, params) => {
  calls.push({ method, params });
  if (failing.has(method)) throw new Error(failMessage[method] ?? `${method} failed`);
  switch (method) {
    case 'session/new':
      return { sessionId: `S${++counter}`, configOptions: OPTIONS() };
    case 'session/resume':
      return { sessionId: params.sessionId, configOptions: OPTIONS() };
    case 'session/set_config_option': {
      const opts = OPTIONS().map((o) => (o.id === params.configId ? { ...o, currentValue: params.value } : o));
      return { configOptions: opts };
    }
    case 'session/list':
      return { sessions: remoteSessions };
    default:
      return {};
  }
};
const noted = [];
const agent = { name: 'sess-test', type: 'pi', custom: false, spec: { defaultCwd: 'C:/work/a', model: 'fast' }, child: {}, busy: false, onSession: (id) => noted.push(id) };
const make = (overrides = {}) =>
  new Sessions({ agent: { ...agent, ...overrides }, request, init: async () => {}, enqueue: (fn) => fn(), rulesMeta: () => ({ _meta: { rules: 1 } }) });
const names = () => calls.map((c) => c.method).join();

// 1
let s = make();
check('before the first use it is on no session, in the directory it will start in', s.sessionId === null && s.cwd === 'C:/work/a');
const id1 = await s.ensureReady();
check('the first use starts a session', id1 === 'S1' && s.sessionId === 'S1' && calls[0].method === 'session/new' && calls[0].params.cwd === 'C:/work/a');
check('with the rules in its `_meta`, for the CLIs that take them there', calls[0].params._meta?.rules === 1);
check("it takes the CLI's options, and the session is live", s.configOptions.length === 2 && s.live.has('S1') && s.currentModel() === 'fast');
check("the instance's model is applied (the CLI's default differed)", calls.some((c) => c.method === 'session/set_config_option' && c.params.configId === 'model' && c.params.value === 'fast'));
check('the session is remembered, and the daemon told once', s.preferSession === 'S1' && noted.join() === 'S1');

// 2
const before = calls.length;
await s.ensureReady();
check('the same directory reuses the session', calls.length === before && s.sessionId === 'S1');
await s.ensureReady('C:/work/b');
check('another directory starts a new one', s.sessionId === 'S2' && s.cwd === 'C:/work/b');

// 3
s.forgetProcess();
check('when the process goes away nothing is live, but the session is remembered', s.sessionId === null && s.live.size === 0 && s.preferSession === 'S2');
calls.length = 0;
await s.ensureReady('C:/work/b');
check('the remembered session is resumed', s.sessionId === 'S2' && calls[0].method === 'session/resume' && calls[0].params.sessionId === 'S2');
s.forgetProcess();
calls.length = 0;
failing.add('session/resume');
failMessage['session/resume'] = 'session is already active';
await s.ensureReady('C:/work/b');
check('a CLI that says the session is already active does not leave it without one', s.sessionId === 'S2' && !calls.some((c) => c.method === 'session/new'));
s.forgetProcess();
calls.length = 0;
failMessage['session/resume'] = 'cannot read the session file';
await s.ensureReady('C:/work/b');
check('one that cannot resume gets a fresh session, and the old one is forgotten as the one to return to', calls.map((c) => c.method).includes('session/new') && s.sessionId !== 'S2' && s.preferSession === s.sessionId, `${s.sessionId} / ${s.preferSession}`);
failing.clear();

// 4
s = make();
await s.ensureReady();
const first = s.sessionId;
await s.ensureReady('C:/work/other');
const second = s.sessionId;
calls.length = 0;
const back = await s.useSession(first);
check('switching to a session that is live only moves the pointer', back.live === true && back.resumed === false && s.sessionId === first && !calls.some((c) => c.method === 'session/resume'));
check("and the options of that session are the ones in use", s.configOptions.length === 2);

// 5
s = make({ spec: { defaultCwd: 'C:/work/a' } });
await s.ensureReady();
calls.length = 0;
const set = await s.setConfigOption('effort', 'high');
check('an option is set and remembered for the session', set.sessionId === s.sessionId && calls[0].params.value === 'high');
s.forgetProcess();
s.live.clear();
calls.length = 0;
await s.attach(set.sessionId, 'C:/work/a');
check('after a restart what the session was given is put back', calls.some((c) => c.method === 'session/set_config_option' && c.params.configId === 'effort' && c.params.value === 'high'), names());
s.preferModel = 'fast';
const busyAgent = make({ spec: { defaultCwd: 'C:/work/a', model: 'fast' }, busy: true });
await busyAgent.ensureReady();
busyAgent.modelDirty = false;
calls.length = 0;
await busyAgent.chooseModel('cli-default');
check('a model chosen while it works waits for the next prompt', busyAgent.modelDirty === true && busyAgent.preferModel === 'cli-default' && !calls.length);
const idle = make({ spec: { defaultCwd: 'C:/work/a', model: 'cli-default' } });
await idle.ensureReady();
calls.length = 0;
await idle.chooseModel('fast');
check('when idle it is applied at once', calls.some((c) => c.method === 'session/set_config_option' && c.params.value === 'fast'));

// 6
const d = await s.describeModels();
check('models are listed flat, whatever the grouping', d.configOptions.find((o) => o.id === 'model').options.map((o) => o.value).join() === 'cli-default,fast');
const old = s.sessionId;
const fresh = await s.newSession('C:/work/a');
check('a new session is a new one, not the remembered one', fresh !== old && s.preferSession === fresh);

// 7
s = make({ spec: { defaultCwd: 'C:/work/a' } });
await s.ensureReady();
const mine = s.sessionId;
remoteSessions = [
  { sessionId: 'R1', cwd: 'C:/elsewhere', title: 'old talk', updatedAt: '2026-01-02T00:00:00Z' },
  { sessionId: 'R2', cwd: 'C:/elsewhere', title: 'hidden talk', updatedAt: '2026-01-01T00:00:00Z' },
];
s.remove('R2');
const listed = (await s.list()).sessions;
check('the CLI\'s sessions, the live one and the active one are all listed, newest first', listed.some((r) => r.sessionId === 'R1' && r.source === 'agent') && listed.some((r) => r.sessionId === mine && r.active), listed.map((r) => r.sessionId).join());
check('a hidden one is not', !listed.some((r) => r.sessionId === 'R2'));
const createdAgent = make({ custom: true, spec: { defaultCwd: 'C:/work/a' } });
const forCreated = (await createdAgent.list()).sessions;
check('a created instance only lists its own directory', !forCreated.some((r) => r.sessionId === 'R1'), forCreated.map((r) => r.sessionId).join());
check('naming one', s.rename('R1', 'Talk').label === 'Talk' && (await s.list()).sessions.find((r) => r.sessionId === 'R1').label === 'Talk');
check('an empty name removes it', s.rename('R1', '').label === null);
check('with no id it names the active one', s.rename(null, 'Mine').sessionId === mine);
try {
  s.remove(mine);
  check('the active one cannot be hidden', false);
} catch (e) {
  check('the active one cannot be hidden', /active session/.test(e.message));
}
try {
  s.remove('');
  check('an id is required', false);
} catch (e) {
  check('an id is required', /sessionId is required/.test(e.message));
}

console.log(process.exitCode ? '\n=> ✗ SESSIONS BROKEN' : '\n=> ✓ SESSIONS OK');
process.exit(process.exitCode ?? 0);
