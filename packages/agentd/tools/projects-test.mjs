/**
 * Project-as-configuration-unit regression.
 *
 * Checks:
 *   1. project.create validates id/root and instance dirs (.., outside, symlink)
 *   2. instances start lazily and are keyed <project>~<id>
 *   3. two projects may use the same instance id and stay separate
 *   4. scoped calls ({project, short}) show only that project's instances
 *   5. roles are listed
 *   6. an instance runs in its own directory under the project root
 *   7. project.stop / project.remove refuse while a job runs, and succeed with force
 *   8. projects survive a daemon restart
 *   9. the plain (global) instance list is not polluted by project instances
 *
 * Usage: node tools/projects-test.mjs [type]
 */

import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler, check, stopDaemon } from './lib/scheduler.mjs';

const TYPE = process.argv[2] || 'dsh';
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
console.log(`\n=== projects: ${TYPE} ===\n`);

const tag = Date.now().toString(36);
const A = `pa${tag}`;
const B = `pb${tag}`;
const rootA = mkdtempSync(join(tmpdir(), 'agentd-pa-'));
const rootB = mkdtempSync(join(tmpdir(), 'agentd-pb-'));
const outside = mkdtempSync(join(tmpdir(), 'agentd-out-'));
mkdirSync(join(rootA, 'server'));
mkdirSync(join(rootB, 'server'));

const fails = async (p, re, name) =>
  p.then(
    () => check(name, false, 'did not fail'),
    (e) => check(name, re.test(e.message), e.message),
  );

let s = await Scheduler.open();
const call = (op, args) => s.c.call(op, args);

try {
  // 1. validation
  await fails(call('project.create', { id: 'Bad Id', root: rootA }), /id/i, 'invalid project id is rejected');
  await fails(call('project.create', { id: A, root: 'relative/path' }), /absolute/, 'relative root is rejected');
  await fails(call('project.create', { id: A, root: join(rootA, 'nope') }), /does not exist/, 'missing root is rejected');

  const made = await call('project.create', { id: A, name: 'Project A', root: rootA });
  check('project.create succeeds', made.id === A || made.project?.id === A);
  await fails(call('project.create', { id: A, root: rootA }), /already exists/, 'duplicate project id is rejected');

  await fails(call('project.addInstance', { project: A, id: 'x', type: TYPE, dir: '..' }), /outside|escape/i, 'dir ".." is rejected');
  await fails(call('project.addInstance', { project: A, id: 'x', type: TYPE, dir: outside }), /outside|escape/i, 'absolute dir outside the root is rejected');
  await fails(call('project.addInstance', { project: A, id: 'x', type: TYPE, dir: './missing' }), /exist|directory/i, 'missing dir is rejected');
  try {
    symlinkSync(outside, join(rootA, 'link'), 'junction');
    await fails(call('project.addInstance', { project: A, id: 'x', type: TYPE, dir: './link' }), /outside|escape/i, 'link leaving the root is rejected');
  } catch (e) {
    console.log(`  (skip link check: ${e.message})`);
  }
  await fails(call('project.addInstance', { project: A, id: 'a~b', type: TYPE, dir: '.' }), /id/i, 'id containing ~ is rejected');
  await fails(call('project.addInstance', { project: A, id: 'x', type: 'nope', dir: '.' }), /unknown type/, 'unknown type is rejected');

  // 2. lazy start
  await call('project.addInstance', { project: A, id: 'srv', type: TYPE, dir: './server', role: 'backend service' });
  let list = (await call('projects')).projects.find((p) => p.id === A);
  const row = list.instances.find((i) => i.id === 'srv');
  check('instance key is <project>~<id>', row?.key === `${A}~srv`, row?.key);
  check('instance is not started yet', row && row.alive === false);
  check('role is listed', row?.role === 'backend service', row?.role);
  await fails(call('project.addInstance', { project: A, id: 'srv', type: TYPE, dir: '.' }), /already exists/, 'duplicate instance id is rejected');

  // 3. same id in another project
  await call('project.create', { id: B, root: rootB, instances: [{ id: 'srv', type: TYPE, dir: './server' }] });
  const all = (await call('projects')).projects;
  const keys = all.flatMap((p) => p.instances.map((i) => i.key));
  check('same instance id in two projects gives two keys', keys.includes(`${A}~srv`) && keys.includes(`${B}~srv`));

  // 4. scoped view
  const scoped = await call('instances', { project: A, short: true });
  const names = (scoped.instances ?? scoped.agents ?? []).map((i) => i.id ?? i.name);
  check('scoped list shows only its own project', names.includes('srv') && !names.some((n) => String(n).includes('~')), names.join(','));
  await fails(call('status', { project: A, short: true, agent: `${B}~srv` }), /~|unknown|not found/i, 'scoped call cannot name another project');

  // 9. global list
  const glob = await call('instances');
  const gp = (glob.instances ?? []).filter((i) => String(i.id).includes('~'));
  check('global list tags project instances with their project', gp.length >= 2 && gp.every((i) => i.project), `${gp.length} tagged`);

  // 6. runs in its own directory
  const r = await s.c.call('run', { agent: `${A}~srv`, prompt: 'Reply with exactly: PROJ' });
  check('project instance answers', /PROJ/i.test(r.text ?? ''), JSON.stringify(String(r.text ?? '').slice(0, 30)));
  const st = await s.status(`${A}~srv`);
  check('instance runs under the project root', norm(st.cwd) === norm(join(rootA, 'server')), st.cwd);
  list = (await call('projects')).projects.find((p) => p.id === A);
  check('instance is alive after first use', list.instances.find((i) => i.id === 'srv').alive === true);
  const other = (await call('projects')).projects.find((p) => p.id === B);
  check('other project instance stayed stopped', other.instances.every((i) => i.alive === false));

  // model and session choice at creation
  const cat = await call('project.models', { type: TYPE });
  check('project.models lists the models of a type', cat.models.length > 0, `${cat.models.length} models`);
  const pick = cat.models.find((m) => m.value !== cat.current) ?? cat.models[0];
  await call('project.addInstance', { project: A, id: 'mdl', type: TYPE, dir: '.', model: pick.value });
  const r2 = await s.c.call('run', { agent: `${A}~mdl`, prompt: 'Reply with exactly: MODEL' });
  const st2 = await s.status(`${A}~mdl`);
  check('instance uses the model chosen at creation', st2.model === pick.value, `${st2.model} (wanted ${pick.value})`);
  // A running CLI writes its session out late, so stop it first: what is on disk is what can be picked.
  await call('project.stop', { project: A });
  const owned = await call('project.sessions', { project: A, type: TYPE, dir: './server' });
  check('a session another instance owns is not offered', !owned.sessions.some((x) => x.sessionId === r.sessionId));
  await call('project.addInstance', { project: A, id: 'old', type: TYPE, dir: './server', sessionId: r.sessionId });
  const r3 = await s.c.call('run', { agent: `${A}~old`, prompt: 'Reply with exactly: AGAIN' });
  check('instance created on an existing session resumes it', r3.sessionId === r.sessionId, r3.sessionId);
  await call('project.removeInstance', { project: A, id: 'old' });
  await call('project.removeInstance', { project: A, id: 'mdl' });
  const free = await call('project.sessions', { project: A, type: TYPE, dir: '.' });
  check('project.sessions offers existing sessions of that directory', free.sessions.some((x) => x.sessionId === r2.sessionId), `${free.sessions.length}`);

  // 7. busy refusal
  const started = await call('run', { agent: `${A}~srv`, prompt: 'Count slowly from 1 to 200, one number per line.', async: true });
  await new Promise((res) => setTimeout(res, 1500));
  await fails(call('project.stop', { project: A }), /running/, 'project.stop refuses while a job runs');
  await fails(call('project.remove', { project: A }), /running/, 'project.remove refuses while a job runs');
  await fails(call('project.removeInstance', { project: A, id: 'srv' }), /running/, 'removeInstance refuses while a job runs');
  const stopped = await call('project.stop', { project: A, force: true });
  check('project.stop with force succeeds', Boolean(stopped));
  list = (await call('projects')).projects.find((p) => p.id === A);
  check('instances are stopped, config kept', list.instances.length === 1 && list.alive === 0);
  void started;

  // 8. restart persistence
  s.close();
  console.log('\n  restarting the daemon…');
  await stopDaemon();
  s = await Scheduler.open();
  const back = (await s.c.call('projects')).projects;
  check('projects are restored after restart', back.some((p) => p.id === A) && back.some((p) => p.id === B));
  const r4 = await s.c.call('run', { agent: `${A}~srv`, prompt: 'Reply with exactly: BACK' });
  check('instance returns to its last session after restart', r4.sessionId === r.sessionId, r4.sessionId);
  check(
    'instance dir survives restart',
    back.find((p) => p.id === A).instances.find((i) => i.id === 'srv')?.dir?.replace(/\\/g, '/').endsWith('server'),
  );
} finally {
  for (const id of [A, B]) await s.c.call('project.remove', { project: id, force: true }).catch(() => {});
}

const left = (await s.c.call('projects')).projects;
check('projects can be deleted', !left.some((p) => p.id === A || p.id === B));

s.close();
console.log(process.exitCode ? '\n=> ✗ PROJECTS BROKEN' : '\n=> ✓ PROJECTS OK');
