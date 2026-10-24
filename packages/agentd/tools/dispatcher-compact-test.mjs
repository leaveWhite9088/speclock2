/**
 * The dispatcher compacts like an executor, and can be handed over to a fresh conversation. A faked pi (no real
 * process, no model).
 *
 * Checks:
 *   1. with no threshold nothing is compacted; past a set one pi is asked to compact, between turns
 *   2. messages that arrive during the compaction wait, and go out afterwards
 *   3. the compaction is announced and counted (once, not twice)
 *   4. a conversation that did not shrink is not compacted again at once
 *   5. a handoff of the dispatcher: the document is its reply, a new conversation is opened and named, it is handed
 *      the document, and the old conversation is kept
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agentd-dcompact-'));
process.env.AGENTD_LABELS_FILE = join(dir, 'labels.json');
const { Dispatcher } = await import('../core/dispatcher.mjs');
const { createHandoffs } = await import('../core/handoff.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== dispatcher compaction and handoff ===\n');

const events = [];
const d = new Dispatcher({ cwd: dir, project: 'proj', sessionDir: dir, onEvent: (e) => events.push(e) });
const compacted = [];
d.onCompact = (i) => compacted.push(i);

// -- a faked pi: answers commands, and "runs" a turn when asked to
let used = 5_000;
let session = join(dir, 'one.jsonl');
const calls = [];
let compactShrinks = true;
const settleSoon = (ms = 30) => setTimeout(() => d.pi.handle({ type: 'agent_settled' }), ms);
Object.defineProperty(d, 'child', { get: () => ({}) });
d.pi.child = {}; // PiRpc.running
d.ensureStarted = async () => {};
const reply = { text: 'THE HANDOFF DOCUMENT' };
d.command = async (type, params) => {
  calls.push(type === 'prompt' ? `prompt:${params.message.slice(0, 18)}` : type);
  switch (type) {
    case 'prompt':
      settleSoon();
      return { disposition: 'started' };
    case 'get_session_stats':
      return { contextUsage: { tokens: used, contextWindow: 1_000_000, percent: used / 10_000 } };
    case 'get_state':
      return { sessionFile: session };
    case 'compact':
      await new Promise((r) => setTimeout(r, 80));
      if (compactShrinks) used = 3_000;
      return {};
    case 'new_session':
      session = join(dir, 'two.jsonl');
      return {};
    case 'get_messages':
      return { messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: [{ type: 'text', text: reply.text }] }] };
    default:
      return {};
  }
};
const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms));

// 1: no threshold
d.compactAt = null;
used = 150_000;
await d.prompt('turn 1');
await tick(120);
check('with no threshold nothing is compacted', !calls.includes('compact'), calls.join());

// 1, 2, 3: past a threshold
d.compactAt = 100_000;
calls.length = 0;
used = 150_000;
await d.prompt('turn 2');
await tick(60); // the turn settled, the compaction has begun
const during = await d.prompt('sent during the compaction');
check('past the threshold pi is asked to compact, between turns', calls.includes('compact'), calls.join());
check('a message that arrives meanwhile waits', during.disposition === 'queued', JSON.stringify(during));
await tick(400);
check('and goes out afterwards', calls.some((c) => c.startsWith('prompt:sent during')), calls.join());
check('the compaction was announced, once, counted once', compacted.length === 1 && compacted[0].compactions === 1 && compacted[0].project === 'proj', JSON.stringify(compacted.map((c) => c.compactions)));
check('with the sizes before and after', compacted[0]?.before?.used === 150_000 && compacted[0]?.after?.used === 3_000, JSON.stringify([compacted[0]?.before?.used, compacted[0]?.after?.used]));
check('the count is available to show', d.compactions() === 1, String(d.compactions()));

// 4: did not shrink: not again at once (a conversation of its own, so the earlier compaction does not count)
session = join(dir, 'three.jsonl');
compactShrinks = false;
calls.length = 0;
used = 150_000;
await d.prompt('turn 3');
await tick(300);
const first = calls.filter((c) => c === 'compact').length;
used = 148_000;
await d.prompt('turn 4');
await tick(300);
check('a conversation that stays big is compacted, but not again straight away', first === 1 && calls.filter((c) => c === 'compact').length === 1, String(calls.filter((c) => c === 'compact').length));

// 5: handoff of the dispatcher
d.compactAt = null;
await tick(100);
const prompts = [];
const target = d.asHandoffTarget();
const wrapped = { ...target, startPrompt: (text, opts) => (prompts.push(text), d._promptAndWait(text, opts)) };
Object.defineProperties(wrapped, { busy: { get: () => d.busy }, cwd: { get: () => d.cwd }, sessionId: { get: () => d.resumeFile }, preferSession: { get: () => d.resumeFile } });
const states = [];
const handoffs = createHandoffs({ getAgent: () => wrapped, keyOf: (p, i) => `${p}~${i}`, onChange: (p) => states.push(p.status) });
writeFileSync(join(dir, 'one.jsonl'), '');
await d.state(); // learns the current conversation
const oldSession = d.resumeFile;
const prop = handoffs.propose({ project: 'proj', agent: '@dispatcher', reason: 'compacted three times', evidence: 'e' });
check('the dispatcher can be proposed for a handoff', prop.agent === '@dispatcher' && prop.status === 'pending');
handoffs.generate({ id: prop.id });
for (let i = 0; i < 40 && !states.includes('review'); i++) await tick(50);
const rev = handoffs.list({ project: 'proj' }).handoffs.find((h) => h.id === prop.id);
check('the document is what the dispatcher replied', rev?.status === 'review' && rev.doc === 'THE HANDOFF DOCUMENT', JSON.stringify([rev?.status, rev?.doc]));
check('it was asked for the document', /handoff document/i.test(prompts[0] ?? ''));

reply.text = 'Picking up: the intro page. Unsure: nothing.';
handoffs.apply({ id: prop.id, text: 'THE HANDOFF DOCUMENT (edited)' });
for (let i = 0; i < 60 && !states.includes('done'); i++) await tick(50);
const after = handoffs.list({ project: 'proj' }).handoffs.find((h) => h.id === prop.id);
check('after confirming, a new conversation is opened and handed the document', states.includes('done') && d.resumeFile === join(dir, 'two.jsonl') && /THE HANDOFF DOCUMENT \(edited\)/.test(prompts[1] ?? ''), JSON.stringify([states, after?.error]));
check('the new conversation is named after the old one, readably', /^交接自 \S+$/.test(d._labels()['two.jsonl'] ?? '') && !/[\\/:]/.test(d._labels()['two.jsonl'] ?? ''), JSON.stringify(d._labels()['two.jsonl']));
check('the old conversation is still there, under its own name', oldSession === join(dir, 'three.jsonl') && oldSession !== d.resumeFile, oldSession);

console.log(process.exitCode ? '\n=> ✗ DISPATCHER COMPACTION / HANDOFF BROKEN' : '\n=> ✓ DISPATCHER COMPACTION / HANDOFF OK');
process.exit(process.exitCode ?? 0);
