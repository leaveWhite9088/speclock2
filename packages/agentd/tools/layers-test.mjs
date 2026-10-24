/**
 * Which part may import which, checked from the source with nothing started. A part only reaches downward: a rule here
 * is there so that nobody adds an import in the wrong direction without the test saying so.
 *
 *   leaves        core/{data-dir, app-config, transcripts, rules, reply, pi-rpc, pi-models, session-disk, journal, tasks}.mjs
 *                 import only other leaves
 *   pool          core/pool/** imports pool files and the leaves that hold nothing but data and files
 *                 (data-dir, app-config, transcripts)
 *   core          core/** imports nothing from daemon/, client/, extension/, server/
 *   into the pool the rest of core and the daemon reach the pool through core/agent-pool.mjs, and the few helpers the
 *                 dispatcher shares with the executors (compaction, store, system-prompt)
 *   daemon        daemon/ is imported by nothing but daemon/ and the tools
 *   ops           daemon/ops/ files do not import each other
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './lib/scheduler.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const rel = (f) => relative(ROOT, f).replace(/\\/g, '/');

function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'data') continue;
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(mjs|ts)$/.test(name)) out.push(p);
  }
  return out;
}

/** The files a source imports (relative specifiers only), as paths relative to the package. */
function importsOf(file) {
  const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specs = [...text.matchAll(/\b(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)].map((m) => m[1]);
  return specs.map((s) => rel(resolve(dirname(file), s)));
}

console.log('\n=== layers ===\n');

const files = [...sources(join(ROOT, 'core')), ...sources(join(ROOT, 'daemon')), ...sources(join(ROOT, 'client')), ...sources(join(ROOT, 'extension')), ...sources(join(ROOT, 'server'))];
const graph = new Map(files.map((f) => [rel(f), importsOf(f)]));

const LEAVES = ['data-dir', 'app-config', 'transcripts', 'rules', 'reply', 'pi-rpc', 'pi-models', 'session-disk', 'journal', 'tasks'].map((n) => `core/${n}.mjs`);
const POOL_MAY_USE = ['core/data-dir.mjs', 'core/app-config.mjs', 'core/transcripts.mjs'];
const SHARED_FROM_POOL = ['core/pool/compaction.mjs', 'core/pool/store.mjs', 'core/pool/system-prompt.mjs'];
const POOL_GATEWAY = ['core/agent-pool.mjs'];

const violations = (rule, test) => {
  const bad = [];
  for (const [file, imports] of graph) for (const to of imports) if (test(file, to)) bad.push(`${file} -> ${to}`);
  return check(rule, bad.length === 0, bad.join('; '));
};

const inPool = (f) => f.startsWith('core/pool/');
const inCore = (f) => f.startsWith('core/');

// files named by the rules exist, so a rename cannot silently empty a rule
check('the files the rules talk about exist', [...LEAVES, ...POOL_MAY_USE, ...SHARED_FROM_POOL, ...POOL_GATEWAY].every((f) => graph.has(f)), [...LEAVES, ...POOL_MAY_USE, ...SHARED_FROM_POOL, ...POOL_GATEWAY].filter((f) => !graph.has(f)).join(', '));

violations('a leaf imports only other leaves', (from, to) => LEAVES.includes(from) && !LEAVES.includes(to));
violations('the pool imports only pool files and the leaves that hold data and files', (from, to) => inPool(from) && !inPool(to) && !POOL_MAY_USE.includes(to));
violations('core imports nothing from the daemon, the client, the extension or the server', (from, to) => inCore(from) && !inCore(to));
violations('what is outside the pool reaches in through its gateway or the shared helpers only', (from, to) => !inPool(from) && inPool(to) && !SHARED_FROM_POOL.includes(to) && !POOL_GATEWAY.includes(from));
violations('nothing imports the daemon from outside it', (from, to) => !from.startsWith('daemon/') && to.startsWith('daemon/'));
violations('the operation files do not import each other', (from, to) => from.startsWith('daemon/ops/') && to.startsWith('daemon/ops/') && from !== 'daemon/ops/index.mjs');

// the gateway: what it hands out
const gateway = graph.get('core/agent-pool.mjs') ?? [];
check('the gateway only hands out pool files and transcripts', gateway.every((t) => inPool(t) || t === 'core/transcripts.mjs'), gateway.join(', '));

console.log(process.exitCode ? '\n=> ✗ LAYERS BROKEN' : '\n=> ✓ LAYERS OK');
process.exit(process.exitCode ?? 0);
