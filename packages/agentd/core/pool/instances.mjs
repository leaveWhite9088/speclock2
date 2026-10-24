/**
 * Instances. One is a resident process of a CLI type, pinned to one directory. mcode, dsh and pi exist from the
 * start (id equals type); more are created at run time and saved in data/instances.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AcpClient } from './acp-client.mjs';
import { canCompact, contextOf } from './compaction.mjs';
import { AGENTS, DATA_DIR, log } from './config.mjs';
import { pool } from './registry.mjs';
import { saved } from './store.mjs';

for (const [name, spec] of Object.entries(AGENTS)) pool.set(name, new AcpClient(name, spec));

const INSTANCES_FILE = process.env.AGENTD_INSTANCES_FILE || join(DATA_DIR, 'instances.json');
const INSTANCE_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/** @type {Array<{id: string, type: string, cwd: string, createdAt: string}>} */
let savedInstances = [];

function saveInstances() {
  try {
    mkdirSync(dirname(INSTANCES_FILE), { recursive: true });
    writeFileSync(INSTANCES_FILE, JSON.stringify({ instances: savedInstances }, null, 2));
  } catch (err) {
    log('failed to save instances:', err.message);
  }
}

export function buildInstance({ id, type, cwd, project = null, shortId = id, role = null, model = null, sessionId = null, onSession = null, compactAt = null, systemPrompt = null }) {
  const base = AGENTS[type];
  const spec = {
    ...base,
    type,
    model,
    sessionId,
    onSession,
    compactAt,
    systemPrompt,
    custom: true,
    project,
    shortId,
    role,
    label: `${base.label} (${shortId})`,
    defaultCwd: cwd,
    env: { ...base.env, ...(type === 'pi' ? { PI_SESSION_DIR: join(DATA_DIR, 'pi-sessions', id) } : {}) },
  };
  return new AcpClient(id, spec);
}

(function restoreInstances() {
  try {
    if (!existsSync(INSTANCES_FILE)) return;
    const data = JSON.parse(readFileSync(INSTANCES_FILE, 'utf8'));
    for (const rec of data?.instances ?? []) {
      if (!rec?.id || pool.has(rec.id) || !AGENTS[rec.type] || !rec.cwd) continue;
      savedInstances.push(rec);
      pool.set(rec.id, buildInstance(rec));
    }
  } catch (err) {
    log('instances file unreadable, ignoring:', err.message);
  }
})();

/** Create another instance of `type` in `cwd`. Returns the new AcpClient. */
export function createInstance({ id, type, cwd }) {
  if (!INSTANCE_ID_RE.test(String(id ?? ''))) {
    throw new Error('instance id must start with a letter and use only a-z, 0-9, "-" or "_" (max 32)');
  }
  if (!AGENTS[type]) throw new Error(`unknown type "${type}"; available: ${Object.keys(AGENTS).join(', ')}`);
  if (pool.has(id)) throw new Error(`instance "${id}" already exists`);
  if (!cwd || typeof cwd !== 'string') throw new Error('cwd is required');

  mkdirSync(cwd, { recursive: true });
  const rec = { id, type, cwd, createdAt: new Date().toISOString() };
  const agent = buildInstance(rec);
  pool.set(id, agent);
  savedInstances.push(rec);
  saveInstances();
  return agent;
}

/** Stop and forget a created instance. The built-in ones cannot be removed. */
export async function removeInstance(id) {
  const agent = pool.get(id);
  if (!agent) throw new Error(`unknown instance "${id}"`);
  if (!agent.custom) throw new Error(`"${id}" is a built-in instance and cannot be removed`);
  if (agent.busy) throw new Error(`instance "${id}" is running a prompt; cancel it first`);

  await agent.shutdown();
  pool.delete(id);
  savedInstances = savedInstances.filter((r) => r.id !== id);
  saveInstances();
  return { id, removed: true };
}

/** One row per instance, for dashboards and the `instances` op. */
export function listInstances() {
  return [...pool.values()].map((a) => ({
    id: a.name,
    project: a.project,
    shortId: a.shortId,
    role: a.role,
    preferModel: a.preferModel,
    preferSession: a.preferSession,
    lastActive: a.lastActive,
    type: a.type,
    custom: a.custom,
    label: a.spec.label,
    cwd: a.spec.defaultCwd ?? null,
    alive: Boolean(a.child),
    busy: a.busy,
    /** What the running task is doing now, so a page opened mid-run can show it at once. */
    activity: a.run ? { startedAt: a.run.startedAt, tool: a.run.lastTool ?? null, toolCalls: a.run.toolCalls ?? 0, openTools: a.openTools.size, thinking: a.run.thoughtChars } : null,
    /** Prompts waiting behind the one that runs, so a page opened mid-run can tell which task is queued. */
    waiting: a.waitingJobs().length,
    /** The same prompts one by one, so each can be cancelled: [{ jobId, text, at }]. */
    waitingJobs: a.waitingJobs(),
    unstable: a.unstable,
    lastError: a.child ? null : (a.lastError ?? null),
    context: contextOf(a),
    compactAt: a.compactAt,
    canCompact: canCompact(a.type),
    compactions: saved(a.name, a.sessionId ?? a.preferSession)?.compactions ?? 0,
    sessionId: a.sessionId,
    model: a.currentModel(),
  }));
}
