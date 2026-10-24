/**
 * The operation table, checked without starting a daemon: it is put together from the files in daemon/ops/, and what
 * the rest of the system calls by name has to be in it.
 *
 * Checks:
 *   1. the table builds and every operation is a function (a name defined in two files is refused when it is built)
 *   2. every operation the backend, the dispatcher's tools and the client call by name exists
 *   3. every operation the guard talks about (the ones a dispatcher may not call, the ones that name an agent) exists
 *   4. each file of daemon/ops/ contributes, and a name appears in exactly one of them
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const { buildOps } = await import('../daemon/ops/index.mjs');
const { DISPATCHER_DENIED, AGENT_ARG_OPS } = await import('../daemon/guard.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== operation table ===\n');

const ctx = { protocol: 3, startedAt: 'now', idleInstanceMs: 1000 };
const ops = buildOps(ctx);
const names = Object.keys(ops);

// 1
check('the table builds with operations in it', names.length > 50, String(names.length));
check('every operation is a function', names.every((n) => typeof ops[n] === 'function'));
const { executorOps } = await import('../daemon/ops/executors.mjs');
const { systemOps } = await import('../daemon/ops/system.mjs');
const { projectOps } = await import('../daemon/ops/projects.mjs');
const { runOps } = await import('../daemon/ops/run.mjs');
const { dispatcherOps } = await import('../daemon/ops/dispatcher.mjs');
const parts = { executors: executorOps(ctx), system: systemOps(ctx), projects: projectOps(ctx), run: runOps(ctx), dispatcher: dispatcherOps(ctx) };

// 4
const owners = new Map();
for (const [file, part] of Object.entries(parts)) for (const n of Object.keys(part)) owners.set(n, [...(owners.get(n) ?? []), file]);
check('each file of daemon/ops/ contributes operations', Object.values(parts).every((p) => Object.keys(p).length > 0), Object.entries(parts).map(([f, p]) => `${f}:${Object.keys(p).length}`).join(' '));
check('a name appears in exactly one file', [...owners.values()].every((f) => f.length === 1));
check('the table is the sum of the files', names.length === owners.size);

// 2: calls by name
const calledIn = (file) => {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/\bcall\(\s*['"]([A-Za-z]+(?:\.[A-Za-z]+)?)['"]/g)].map((m) => m[1]);
};
const sources = [
  ...readdirSync(join(ROOT, '..', 'backend', 'src')).filter((f) => f.endsWith('.mjs')).map((f) => join(ROOT, '..', 'backend', 'src', f)),
  join(ROOT, 'extension', 'agent-router.ts'),
];
for (const file of sources) {
  const missing = [...new Set(calledIn(file))].filter((n) => !(n in ops));
  check(`${file.split(/[\\/]/).slice(-2).join('/')} only calls operations that exist`, missing.length === 0, missing.join(', '));
}

// 3
const unknownDenied = [...DISPATCHER_DENIED].filter((n) => !(n in ops));
check('every operation the dispatcher is denied exists', unknownDenied.length === 0, unknownDenied.join(', '));
const unknownScoped = [...AGENT_ARG_OPS].filter((n) => !(n in ops));
check('every operation that names an agent exists', unknownScoped.length === 0, unknownScoped.join(', '));

console.log(process.exitCode ? '\n=> ✗ OPERATION TABLE BROKEN' : '\n=> ✓ OPERATION TABLE OK');
process.exit(process.exitCode ?? 0);
