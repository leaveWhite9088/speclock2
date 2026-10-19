/**
 * Multi-instance regression.
 *
 * One CLI type can run as several instances, each pinned to its own directory.
 *
 * Checks:
 *   1. instance.create adds an instance and rejects bad or duplicate ids
 *   2. the new instance starts in its own directory
 *   3. its session list does not mix with the built-in instance of the same type
 *   4. built-in instances cannot be removed
 *   5. the instance comes back after a daemon restart
 *   6. instance.remove deletes it for good
 *
 * Usage: node tools/instances-test.mjs [type]
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler, check, stopDaemon } from './lib/scheduler.mjs';

const TYPE = process.argv[2] || 'dsh';
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
console.log(`\n=== multiple instances: ${TYPE} ===\n`);

const id = `t${Date.now().toString(36)}`;
const cwd = mkdtempSync(join(tmpdir(), 'agentd-inst-'));

let s = await Scheduler.open();

// 1. create
const made = await s.c.call('instance.create', { id, type: TYPE, cwd });
check('instance.create returns the new instance', made.id === id && made.type === TYPE);

const list = await s.agents();
const row = list.agents.find((a) => a.name === id);
check('agents lists the new instance', Boolean(row), row?.label);
check('the instance is marked as created', row?.custom === true);
check('built-in instance is still there', list.agents.some((a) => a.name === TYPE && !a.custom));

await s.c.call('instance.create', { id, type: TYPE, cwd }).then(
  () => check('duplicate id is rejected', false),
  (e) => check('duplicate id is rejected', /already exists/.test(e.message), e.message),
);
await s.c.call('instance.create', { id: 'Bad Id', type: TYPE, cwd }).then(
  () => check('invalid id is rejected', false),
  (e) => check('invalid id is rejected', /instance id/.test(e.message), e.message),
);
await s.c.call('instance.create', { id: 'x1', type: 'nope', cwd }).then(
  () => check('unknown type is rejected', false),
  (e) => check('unknown type is rejected', /unknown type/.test(e.message), e.message),
);

// 2. own directory
const r = await s.run(id, 'Reply with exactly: INSTANCE');
check('instance answers', /INSTANCE/i.test(r.text), JSON.stringify(r.text.trim().slice(0, 30)));
const st = await s.status(id);
check('instance runs in its own directory', norm(st.cwd) === norm(cwd), st.cwd);
check('status reports type and custom flag', st.type === TYPE && st.custom === true);

// 3. sessions do not mix
const mine = await s.sessions(id);
const builtin = await s.sessions(TYPE);
check('instance has its session', mine.sessions.some((x) => x.sessionId === r.sessionId));
check('built-in instance does not list it', !builtin.sessions.some((x) => x.sessionId === r.sessionId));
check(
  'every session of the instance is in its directory',
  mine.sessions.every((x) => !x.cwd || norm(x.cwd) === norm(cwd)),
  `${mine.sessions.length} session(s)`,
);

// 4. built-ins are protected
await s.c.call('instance.remove', { id: TYPE }).then(
  () => check('built-in instance cannot be removed', false),
  (e) => check('built-in instance cannot be removed', /built-in/.test(e.message), e.message),
);

// 5. survives a daemon restart
s.close();
console.log('\n  restarting the daemon…');
await stopDaemon();
s = await Scheduler.open();
const after = await s.agents();
check('instance is restored after restart', after.agents.some((a) => a.name === id && a.custom));
const st2 = await s.status(id);
check('restored instance keeps its directory', norm(st2.defaultCwd) === norm(cwd), st2.defaultCwd);

// 6. remove
const gone = await s.c.call('instance.remove', { id });
check('instance.remove succeeds', gone.removed === true);
const last = await s.agents();
check('removed instance is gone', !last.agents.some((a) => a.name === id));

s.close();
console.log(process.exitCode ? '\n=> ✗ INSTANCES BROKEN' : '\n=> ✓ INSTANCES OK');
