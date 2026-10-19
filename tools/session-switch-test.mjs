/**
 * Session switching regression: two sessions in one agent, switch back and forth,
 * verify each keeps its own conversation.
 *
 * Usage: node tools/session-switch-test.mjs [agent]
 */

import { Scheduler, check } from './lib/scheduler.mjs';

const AG = process.argv[2] || 'dsh';
console.log(`\n=== session switching: ${AG} ===\n`);

const s = await Scheduler.open();

const A = (await s.create(AG)).sessionId;
await s.run(AG, 'Remember the codeword KIWI. Reply OK.');
await s.rename(AG, 'kiwi会话', A);

const B = (await s.create(AG)).sessionId;
await s.run(AG, 'Remember the codeword MANGO. Reply OK.');
await s.rename(AG, 'mango会话', B);

console.log(`  A=${A}\n  B=${B}`);

await s.use(AG, A);
const ra = await s.run(AG, 'What codeword did I ask you to remember? Reply with just that word.');
check('A recalls KIWI', /KIWI/i.test(ra.text), ra.text.trim().slice(0, 40));

await s.use(AG, B);
const rb = await s.run(AG, 'What codeword did I ask you to remember? Reply with just that word.');
check('B recalls MANGO', /MANGO/i.test(rb.text), rb.text.trim().slice(0, 40));

const { sessions } = await s.sessions(AG);
const labelled = sessions.filter((x) => x.sessionId === A || x.sessionId === B);
check('labels persisted', labelled.length === 2 && labelled.every((x) => x.label));
check('active session marked', sessions.some((x) => x.active && x.sessionId === B));

s.close();
console.log(process.exitCode ? '\n=> ✗ SWITCHING BROKEN' : '\n=> ✓ SESSION SWITCHING WORKS');
