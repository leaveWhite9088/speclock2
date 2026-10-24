/**
 * Executor templates (markdown files with a header) and the executors made from them.
 *
 * Part 1, in this process (a temporary templates folder):
 *   1. a template is saved as a markdown file and read back; bad ids and directories are refused
 *   2. the executor rules are the common ones plus the template's prompt, without HTML comments
 *   3. an agent whose rules come from a function gets the new text after an edit, written to its rules file
 * Part 2, against the daemon (a temporary project; the test template is removed afterwards):
 *   4. an executor made from a template takes its role, directory and prompt; what the request says wins
 *   5. the executor remembers the template; the list says who uses it; the dispatcher may not edit templates
 *   6. an unknown template is refused, and a template can be removed
 *
 * Usage: node tools/templates-test.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'agentd-tpl-'));
process.env.AGENTD_TEMPLATES_DIR = join(tmp, 'templates');
const T = await import('../core/templates.mjs');
// The folder is read once, when the module loads. A daemon this test starts must not inherit it, or it would keep using the temporary folder.
delete process.env.AGENTD_TEMPLATES_DIR;
const { executorRules } = await import('../core/rules.mjs');
const { buildInstance } = await import('../core/agent-pool.mjs');
const { Scheduler, check } = await import('./lib/scheduler.mjs');

console.log('\n=== executor templates ===\n');

const fails = (fn, re, name) => {
  try {
    fn();
    check(name, false, 'did not fail');
  } catch (e) {
    check(name, re.test(e.message), e.message);
  }
};

// 1
check('no templates to begin with', T.listTemplates().length === 0);
const saved = T.saveTemplate({ id: 'spec-x', name: 'spec-x', role: 'writes specs\nand contracts', dir: '', type: 'pi', model: '', prompt: '## Rules\n\n1. be exact\n\n<!-- a note for editors -->\n2. keep: colons: fine' });
check('it is saved and read back', saved.id === 'spec-x' && saved.role === 'writes specs and contracts' && saved.type === 'pi' && saved.dir === '.', JSON.stringify(saved).slice(0, 120));
const file = readFileSync(join(tmp, 'templates', 'spec-x.md'), 'utf8');
check('as a markdown file with a header', file.startsWith('---\nname: spec-x\nrole: writes specs and contracts\ndir: .\ntype: pi\nmodel: \n---\n') && file.includes('2. keep: colons: fine'));
check('the prompt keeps its colons and comments when read back for editing', T.getTemplate('spec-x').prompt.includes('<!-- a note for editors -->') && T.getTemplate('spec-x').prompt.includes('keep: colons: fine'));
fails(() => T.saveTemplate({ id: '../evil', prompt: 'x' }), /template id/, 'an id that is not a plain name is refused');
fails(() => T.saveTemplate({ id: 'a b', prompt: 'x' }), /template id/, 'an id with a space is refused');
fails(() => T.saveTemplate({ id: 'ok', dir: '../out', prompt: 'x' }), /inside the project/, 'a directory that leaves the project is refused');
fails(() => T.saveTemplate({ id: 'ok', dir: 'C:/abs', prompt: 'x' }), /inside the project/, 'an absolute directory is refused');
check('a file without a header is all prompt', (() => { T.saveTemplate({ id: 'plain', prompt: 'just text' }); return T.getTemplate('plain').prompt === 'just text' && T.getTemplate('plain').name === 'plain'; })());
check('unknown or malformed ids give nothing', T.getTemplate('nope') === null && T.getTemplate('../x') === null);

// 2
const rules = T.executorRulesFor('spec-x');
check('the rules are the common ones, then the template prompt', rules.startsWith(executorRules()) && rules.includes('1. be exact') && rules.indexOf(executorRules()) < rules.indexOf('1. be exact'));
check('notes for editors do not reach the agent', !rules.includes('a note for editors'));
check('without a template, or with a missing one, only the common rules', T.executorRulesFor(null) === executorRules() && T.executorRulesFor('gone') === executorRules());

// 3
const a = buildInstance({ id: 'tpl-test', type: 'dsh', cwd: tmp, systemPrompt: () => T.executorRulesFor('spec-x') });
const first = a.status().rules;
check('an agent made with a function for its rules has them', a.rules.includes('1. be exact') && first?.file && readFileSync(first.file, 'utf8').includes('1. be exact'));
T.saveTemplate({ ...T.getTemplate('spec-x'), prompt: '## New rules\n\n1. be faster' });
check('after the template is edited it gets the new text', a.rules.includes('1. be faster') && !a.rules.includes('1. be exact'));
a._inj();
check('and the rules file is written again', readFileSync(a.status().rules.file, 'utf8').includes('1. be faster'));
T.removeTemplate('plain');
fails(() => T.removeTemplate('plain'), /unknown template/, 'removing one that is gone is refused');
await a.shutdown();

// part 2
const tag = Date.now().toString(36);
const id = `zz-test-${tag}`;
const proj = `tp${tag}`;
const root = mkdtempSync(join(tmpdir(), 'agentd-tplp-'));
mkdirSync(join(root, 'sub'));
const s = await Scheduler.open();
const call = (op, args) => s.c.call(op, args);
const failsAsync = (p, re, name) => p.then(() => check(name, false, 'did not fail'), (e) => check(name, re.test(e.message), e.message));
try {
  const t = await call('template.save', { id, name: 'Test', role: 'does tests', dir: 'sub', type: 'dsh', model: '', prompt: 'Be a tester.' });
  check('the daemon saves a template', t.id === id && t.usedBy.length === 0);
  check('and lists it', (await call('template.list')).templates.some((x) => x.id === id && x.role === 'does tests'));
  await call('project.create', { id: proj, name: 'tpl', root });
  const made = await call('project.addInstance', { project: proj, id: 'one', template: id });
  check('an executor made from it takes its CLI, directory and role', made.type === 'dsh' && made.dir === 'sub' && made.role === 'does tests' && made.template === id, JSON.stringify(made));
  const over = await call('project.addInstance', { project: proj, id: 'two', template: id, role: 'my own role', dir: '.' });
  check('what the request says wins over the template', over.role === 'my own role' && over.dir === '.' && over.template === id);
  const st = await s.status(`${proj}~one`);
  check('its rules include the template prompt', st.rules?.file && readFileSync(st.rules.file, 'utf8').includes('Be a tester.'), JSON.stringify(st.rules));
  const row = (await call('projects')).projects.find((p) => p.id === proj).instances.find((i) => i.id === 'one');
  check('the project list says which template it came from', row.template === id);
  check('the template list says who uses it', (await call('template.list')).templates.find((x) => x.id === id).usedBy.length === 2);
  await call('template.save', { ...t, prompt: 'Be a careful tester.' });
  check('an edited template applies to the executor without recreating it', readFileSync((await s.status(`${proj}~one`)).rules.file, 'utf8').includes('Be a careful tester.'));
  await failsAsync(call('project.addInstance', { project: proj, id: 'three', template: 'does-not-exist' }), /unknown template/, 'an unknown template is refused');
  const upd = await call('project.updateInstance', { project: proj, id: 'two', template: null });
  check('an executor can be detached from its template', upd.template === null);
  await failsAsync(call('project.updateInstance', { project: proj, id: 'two', template: 'nope' }), /unknown template/, 'and attached only to one that exists');
  const asDispatcher = await call('template.save', { id: `${id}-d`, prompt: 'x', caller: 'dispatcher', project: proj }).then(() => 'allowed', (e) => e.message);
  check('the dispatcher may not edit templates', /the dispatcher cannot do "template.save"/.test(asDispatcher), asDispatcher);
} finally {
  await call('project.remove', { project: proj, force: true }).catch(() => {});
  await call('template.remove', { id }).catch(() => {});
  await call('template.remove', { id: `${id}-d` }).catch(() => {});
  s.close();
}
const s2 = await Scheduler.open();
check('the test template is gone from the daemon, the real ones are still there', (await s2.c.call('template.list')).templates.every((x) => !x.id.startsWith('zz-test-')) && existsSync(join(process.cwd(), 'contexts', 'templates', 'spec-agent.md')));
s2.close();

console.log(process.exitCode ? '\n=> ✗ TEMPLATES BROKEN' : '\n=> ✓ TEMPLATES OK');
process.exit(process.exitCode ?? 0);
