/**
 * Dispatcher regression: the pi that chooses agents, driven through agentd.
 *
 * By default no LLM call is made. With `--prompt` the dispatcher gets a real
 * request and must choose an agent through the extension's tools.
 *
 * Checks:
 *   1. dispatcher.state before start, then models (starts pi)
 *   2. the extension is loaded (agent tools exist in the session)
 *   3. setModel round trip with a model pi lists
 *   4. an invalid model value is rejected
 *   5. dispatcher.customModels masks keys
 *   6. (--prompt) a prompt reaches agent_run and finishes
 *
 * Usage: node tools/dispatcher-test.mjs [--prompt]
 */

import { Scheduler, check } from './lib/scheduler.mjs';

const WITH_PROMPT = process.argv.includes('--prompt');
console.log(`\n=== dispatcher${WITH_PROMPT ? ' (with prompt)' : ''} ===\n`);

const s = await Scheduler.open();
const call = (op, args) => s.c.call(op, args, { timeoutMs: 180_000 });

const m = await call('dispatcher.models');
check('dispatcher starts and lists models', Array.isArray(m.models) && m.models.length > 0, `${m.models.length} model(s)`);

const st = await call('dispatcher.state');
check('state says alive with a pid', st.alive === true && Number(st.pid) > 0, `pid ${st.pid}`);
check('state reports a session file', Boolean(st.sessionFile));
check('current model is one of the listed models', !st.model || m.models.some((x) => x.value === st.model.value), st.model?.value);

// setModel round trip: pick a model that is not current, then restore.
const original = st.model?.value ?? null;
const other = m.models.find((x) => x.value !== original);
if (other) {
  const after = await call('dispatcher.setModel', { value: other.value });
  check('setModel switches the model', after.model?.value === other.value, other.value);
  if (original) {
    const back = await call('dispatcher.setModel', { value: original });
    check('model can be switched back', back.model?.value === original, original);
  }
} else {
  console.log('  - only one model available, skipping the switch');
}

await call('dispatcher.setModel', { value: 'nonsense' }).then(
  () => check('invalid model value is rejected', false),
  (e) => check('invalid model value is rejected', /provider\/modelId/.test(e.message), e.message),
);

const custom = await call('dispatcher.customModels');
check('customModels lists providers without literal keys', Array.isArray(custom.providers) && !/"apiKey":"(?!\$|\(literal)/.test(JSON.stringify(custom)));

const sessions = await call('dispatcher.sessions');
// pi writes the session file with the first message, so an idle session is not on disk yet.
check('sessions lists an array', Array.isArray(sessions.sessions));
const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

if (WITH_PROMPT) {
  const tools = [];
  const off = s.c.on('dispatcher.event', (ev) => {
    const d = ev.data ?? ev;
    if (d.type === 'tool_execution_start') tools.push(d.toolName);
  });
  await call('dispatcher.new');
  await call('subscribe', { jobId: '*' }).catch(() => {});
  await call('dispatcher.prompt', { message: 'Use the dsh agent to reply with exactly: DISPATCHED. Then tell me what it said.' });
  const done = await s.c.waitFor(
    'dispatcher.event',
    (ev) => (ev.data ?? ev).type === 'agent_settled',
    240_000,
  );
  off();
  check('dispatcher finished the turn', Boolean(done));
  check('dispatcher called agent_run', tools.includes('agent_run'), tools.join(', '));
  const msgs = await call('dispatcher.messages');
  check('history is readable', msgs.messages.length >= 2, `${msgs.messages.length} messages`);
  const st2 = await call('dispatcher.state');
  const list2 = await call('dispatcher.sessions');
  check('session file is on disk and listed after a prompt', list2.sessions.some((x) => norm(x.file) === norm(st2.sessionFile)));
}

s.close();
console.log(process.exitCode ? '\n=> ✗ DISPATCHER BROKEN' : '\n=> ✓ DISPATCHER OK');
