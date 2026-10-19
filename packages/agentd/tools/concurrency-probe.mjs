/**
 * Probe (not a regression test): can one agent process run prompts of two
 * different sessions at the same time, and how long does a cold start take?
 *
 * It talks to the pool's AcpClient directly and bypasses agentd's own queue, so
 * what we see is the behaviour of the agent's ACP server.
 *
 * Usage: node tools/concurrency-probe.mjs <agent>
 */

import { pool } from '../core/agent-pool.mjs';

const name = process.argv[2] || 'dsh';
const agent = pool.get(name);
if (!agent) throw new Error(`unknown agent ${name}`);
const cwd = agent.spec.defaultCwd || process.cwd();

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
console.log(`\n=== ${name}: concurrent prompts in two sessions ===\n`);

// cold start
await agent._init();
const tInit = Date.now() - t0;
const a = await agent._request('session/new', { cwd, mcpServers: [] });
const b = await agent._request('session/new', { cwd, mcpServers: [] });
console.log(`cold start: init ${tInit}ms, two sessions ready at ${since()}`);

const prompt = (sessionId, text) =>
  agent._request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }, { timeoutMs: 180_000 });

const events = [];
const note = (label, p) =>
  p.then(
    (r) => events.push(`${since()}  ${label} finished (${r?.stopReason ?? 'ok'})`),
    (e) => events.push(`${since()}  ${label} FAILED: ${e.message.slice(0, 160)}`),
  );

const tStart = Date.now();
const longA = note('A (long)', prompt(a.sessionId, 'Write a 700 word essay about the history of rivers. Do not stop early.'));
await new Promise((r) => setTimeout(r, 400)); // A is running now
events.push(`${since()}  sending B while A runs`);
const shortB = note('B (short)', prompt(b.sessionId, 'Reply with exactly: B'));
await Promise.all([longA, shortB]);

for (const e of events) console.log('  ' + e);
console.log(`\ntotal ${((Date.now() - tStart) / 1000).toFixed(1)}s`);

await agent.shutdown?.();
process.exit(0);
