/**
 * Projects: the configuration unit above instances.
 *
 * A project is a root directory, one dispatcher (a pi whose working directory is
 * that root) and a list of instances. Each instance is a process of one CLI type
 * pinned to a directory inside the root, with a `role` the dispatcher's LLM reads
 * when it chooses who does the work.
 *
 *   project "shop"  root D:/work/shop
 *     dsh-backend   dsh    ./server          "backend service"
 *     dsh-data      dsh    ./data-platform   "data platform"
 *     mcode-web     mcode  ./web             "front end"
 *
 * Instances belong to one project and are never shared. The pool key is
 * `<project>~<instance>`, so two projects can both have a `dsh-1`. Instances start
 * on first use and are stopped again when idle; their sessions stay on disk.
 *
 * The configuration lives in agentd's own data/projects.json. Nothing is written
 * into the project directory.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, buildInstance, listInstances, pool } from './agent-pool.mjs';

export const SEP = '~';

const DATA_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), 'data');
const FILE = process.env.AGENTD_PROJECTS_FILE || join(DATA_DIR, 'projects.json');
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

const log = (...a) => process.stderr.write(`[projects] ${a.join(' ')}\n`);

/** @type {Array<{id: string, name: string, root: string, createdAt: string, instances: Array<{id: string, type: string, dir: string, role: string|null}>}>} */
let projects = [];

const keyOf = (project, id) => `${project}${SEP}${id}`;

function save() {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify({ projects }, null, 2) + '\n', 'utf8');
  renameSync(tmp, FILE);
}

function checkId(kind, id) {
  if (!ID_RE.test(String(id ?? ''))) {
    throw new Error(`${kind} id must start with a letter and use only a-z, 0-9, "-" or "_" (max 32)`);
  }
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve `dir` against `root` and refuse anything that leaves the root. */
export function resolveInside(root, dir) {
  const target = resolve(root, String(dir ?? '.') || '.');
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`directory "${dir}" is outside the project root`);
  }
  if (!isDir(target)) throw new Error(`directory does not exist: ${target}`);
  // A symlink inside the root must not lead out of it.
  const real = realpathSync(target);
  const realRoot = realpathSync(root);
  const rel2 = relative(realRoot, real);
  if (rel2.startsWith('..') || isAbsolute(rel2)) throw new Error(`directory "${dir}" resolves outside the project root`);
  return target;
}

function find(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) throw new Error(`unknown project "${id}"`);
  return p;
}

function register(project, inst) {
  const key = keyOf(project.id, inst.id);
  if (pool.has(key)) return pool.get(key);
  const agent = buildInstance({
    id: key,
    type: inst.type,
    cwd: resolve(project.root, inst.dir || '.'),
    project: project.id,
    shortId: inst.id,
    role: inst.role ?? null,
  });
  pool.set(key, agent);
  return agent;
}

// -- restore ----------------------------------------------------------------

(function restore() {
  try {
    if (!existsSync(FILE)) return;
    const data = JSON.parse(readFileSync(FILE, 'utf8'));
    for (const p of data?.projects ?? []) {
      if (!p?.id || !p.root) continue;
      p.instances = (p.instances ?? []).filter((i) => i?.id && AGENTS[i.type]);
      projects.push(p);
      for (const inst of p.instances) register(p, inst);
    }
  } catch (err) {
    log('projects file unreadable, ignoring:', err.message);
  }
})();

// -- queries ----------------------------------------------------------------

export function projectRoot(id) {
  return find(id).root;
}

export function hasProject(id) {
  return projects.some((p) => p.id === id);
}

/** Pool instances of one project. */
export function instancesOf(id) {
  return [...pool.values()].filter((a) => a.project === id);
}

export function listProjects() {
  return projects.map((p) => {
    const rows = listInstances().filter((r) => r.project === p.id);
    return {
      id: p.id,
      name: p.name,
      root: p.root,
      createdAt: p.createdAt,
      instances: rows.map((r) => ({
        ...r,
        id: r.shortId,
        key: r.id,
        dir: p.instances.find((i) => i.id === r.shortId)?.dir ?? '.',
      })),
      alive: rows.filter((r) => r.alive).length,
      busy: rows.filter((r) => r.busy).length,
    };
  });
}

// -- changes ----------------------------------------------------------------

export function createProject({ id, name, root, instances = [] }) {
  checkId('project', id);
  if (projects.some((p) => p.id === id)) throw new Error(`project "${id}" already exists`);
  if (!root || typeof root !== 'string' || !isAbsolute(root)) throw new Error('root must be an absolute path');
  if (!isDir(root)) throw new Error(`root does not exist: ${root}`);

  const project = {
    id,
    name: String(name || id),
    root: resolve(root),
    createdAt: new Date().toISOString(),
    instances: [],
  };
  projects.push(project);
  try {
    for (const inst of instances) addInstance(id, inst, { persist: false });
    save();
  } catch (err) {
    // All or nothing: undo a half-built project.
    for (const a of instancesOf(id)) pool.delete(a.name);
    projects = projects.filter((p) => p.id !== id);
    throw err;
  }
  return listProjects().find((p) => p.id === id);
}

export function addInstance(projectId, { id, type, dir = '.', role = null }, { persist = true } = {}) {
  const project = find(projectId);
  checkId('instance', id);
  if (!AGENTS[type]) throw new Error(`unknown type "${type}"; available: ${Object.keys(AGENTS).join(', ')}`);
  if (project.instances.some((i) => i.id === id)) throw new Error(`instance "${id}" already exists in project "${projectId}"`);
  const abs = resolveInside(project.root, dir);

  const rel = relative(project.root, abs).replace(/\\/g, '/') || '.';
  const inst = { id, type, dir: rel, role: role ? String(role).slice(0, 500) : null };
  project.instances.push(inst);
  const agent = register(project, inst);
  if (persist) save();
  return { key: agent.name, id, type, dir: rel, cwd: abs, role: inst.role };
}

function busyOf(agents) {
  return agents.filter((a) => a.busy).map((a) => a.shortId);
}

/** Stop the processes of every instance of a project. Configuration stays. */
export async function stopInstances(projectId, { force = false } = {}) {
  find(projectId);
  const agents = instancesOf(projectId);
  const busy = busyOf(agents);
  if (busy.length && !force) throw new Error(`running: ${busy.join(', ')}`);
  for (const a of agents) {
    if (a.busy) await Promise.resolve(a.cancel()).catch(() => {});
    await a.shutdown();
  }
  return { project: projectId, stopped: agents.filter((a) => !a.child).length, busy };
}

export async function removeInstance(projectId, id, { force = false } = {}) {
  const project = find(projectId);
  const agent = pool.get(keyOf(projectId, id));
  if (!agent || !project.instances.some((i) => i.id === id)) throw new Error(`unknown instance "${id}" in project "${projectId}"`);
  if (agent.busy && !force) throw new Error(`instance "${id}" is running a prompt; cancel it first`);
  if (agent.busy) await Promise.resolve(agent.cancel()).catch(() => {});
  await agent.shutdown();
  pool.delete(agent.name);
  project.instances = project.instances.filter((i) => i.id !== id);
  save();
  return { project: projectId, id, removed: true };
}

export async function removeProject(projectId, { force = false } = {}) {
  find(projectId);
  await stopInstances(projectId, { force });
  for (const a of instancesOf(projectId)) pool.delete(a.name);
  projects = projects.filter((p) => p.id !== projectId);
  save();
  return { id: projectId, removed: true };
}

/** Stop project instances that have been idle for `ms`. Returns their keys. */
export async function sweepIdle(ms) {
  const now = Date.now();
  const stopped = [];
  for (const a of pool.values()) {
    if (!a.project || !a.child || a.busy || now - a.lastActive < ms) continue;
    await a.shutdown();
    stopped.push(a.name);
  }
  return stopped;
}
