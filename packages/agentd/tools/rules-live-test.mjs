/**
 * Live check: rules and handoff without writing anything into the project. Uses real models.
 *
 *   1. an executor knows its rules (it can quote the git push rule), though no AGENTS.md exists
 *   2. the project's dispatcher knows its rules (it says hands-on work goes to the executors)
 *   3. a handoff works end to end: the executor writes the document as its reply, the person applies it, the new
 *      session knows what the document said, and no .agentd folder or skill file appears in the project
 *
 * Usage: node tools/rules-live-test.mjs
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scheduler, check } from './lib/scheduler.mjs';

console.log('\n=== rules and handoff, live ===\n');
const P = `rl${Date.now().toString(36)}`;
const root = mkdtempSync(join(tmpdir(), 'agentd-rules-'));
mkdirSync(join(root, 'w'));
const s = await Scheduler.open();
const call = (op, args) => s.c.call(op, args, { timeoutMs: 240_000 });
const key = `${P}~w`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listing = () => readdirSync(join(root, 'w')).concat(readdirSync(root));

try {
  await call('project.create', { id: P, name: 'rules', root });
  await call('project.addInstance', { project: P, id: 'w', type: 'dsh', dir: './w', role: 'notes' });
  check('nothing was written into the project', listing().filter((f) => f !== 'w').length === 0, listing().join(', ') || '(empty)');

  // 1. the executor
  const r1 = await s.run(key, 'Answer in one sentence: according to the rules you were given for this project, may you run git push? Say which rule.', { timeoutMs: 240_000 });
  check('the executor knows the git push rule', /git push/i.test(r1.text) && /(不|not|no|never|禁止)/i.test(r1.text), JSON.stringify(r1.text.trim().slice(0, 100)));

  // 2. the dispatcher
  const events = [];
  s.c.on('dispatcher.event', (ev) => events.push(ev.data ?? ev));
  await call('subscribe', { jobId: '*' }).catch(() => {});
  await call('dispatcher.prompt', { project: P, message: 'Do not call any tool. According to your rules for this project, may you write code or create files yourself? Answer in one sentence and say who does it instead.' });
  await s.c.waitFor('dispatcher.event', (ev) => (ev.data ?? ev).type === 'agent_settled', 200_000);
  const msgs = (await call('dispatcher.messages', { project: P })).messages;
  const said = msgs.filter((m) => m.role === 'assistant').flatMap((m) => m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(' ');
  check('the dispatcher knows it hands hands-on work to the executors', /(执行者|executor|delegat|dispatch|assign)/i.test(said), JSON.stringify(said.trim().slice(0, 120)));

  // 3. handoff
  await s.run(key, 'Remember this for later: the codename of this project is MANGO-77 and the next step is to write the intro page.', { timeoutMs: 240_000 });
  const prop = await call('handoff.propose', { project: P, agent: 'w', reason: 'live test', evidence: 'e', caller: 'dispatcher' });
  await call('handoff.generate', { id: prop.id });
  let h = null;
  for (let i = 0; i < 60; i++) {
    h = (await call('handoff.list', { project: P })).handoffs.find((x) => x.id === prop.id);
    if (h && (h.status === 'review' || h.error)) break;
    await sleep(3000);
  }
  check('the executor returned a handoff document', h?.status === 'review' && h.doc?.trim().length > 50, h?.error ?? `${h?.doc?.length ?? 0} chars`);
  check('the document is the reply itself, not a path or a code fence', !/^```/.test(h?.doc ?? '') && !/HANDOFF\.md/.test(h?.doc ?? ''), JSON.stringify((h?.doc ?? '').slice(0, 60)));
  check('the document carries what was worth keeping', /MANGO-77/.test(h?.doc ?? ''));
  check('no .agentd folder or skill file in the project', !existsSync(join(root, 'w', '.agentd')) && !existsSync(join(root, '.agentd')) && !existsSync(join(root, 'w', '.agents')));

  await call('handoff.apply', { id: prop.id, text: h.doc });
  for (let i = 0; i < 60; i++) {
    h = (await call('handoff.list', { project: P })).handoffs.find((x) => x.id === prop.id);
    if (!h) break; // done: it leaves the open list
    if (h.error) break;
    await sleep(3000);
  }
  check('the handoff was applied', !h || h.status === 'done', h?.error ?? h?.status);
  const r3 = await s.run(key, 'What is the codename of this project, and what is the next step? One sentence.', { timeoutMs: 240_000 });
  check('the new session knows what the document said', /MANGO-77/.test(r3.text), JSON.stringify(r3.text.trim().slice(0, 100)));
  check('and it is a different session', r3.sessionId !== r1.sessionId);
  check('still nothing written into the project', !existsSync(join(root, 'w', '.agentd')) && !existsSync(join(root, '.agentd')));
} finally {
  await call('project.remove', { project: P, force: true }).catch(() => {});
}
s.close();
console.log(process.exitCode ? '\n=> ✗ RULES / HANDOFF BROKEN' : '\n=> ✓ RULES / HANDOFF OK');
process.exit(process.exitCode ?? 0);
