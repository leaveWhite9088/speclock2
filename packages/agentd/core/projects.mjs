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
 * The configuration lives in agentd's own data/projects.json. The only thing written
 * into the project is a starter AGENTS.md (rules for the dispatcher at the root, for each
 * executor in its directory), and only when that file does not exist yet.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshSessions } from './session-disk.mjs';
import { AGENTS, buildInstance, defaultModelFor, listInstances, pool } from './agent-pool.mjs';

export const SEP = '~';

const CONTEXTS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'contexts');

/**
 * Starter AGENTS.md files. mcode and dsh read only the AGENTS.md of their own start directory
 * (pi also reads parents), so every executor directory gets one of its own. Existing files are
 * never touched: the user may have edited them.
 */
function seedGuides(project) {
  const put = (dir, template) => {
    try {
      const file = join(dir, 'AGENTS.md');
      if (!isDir(dir) || existsSync(file) || existsSync(join(dir, 'CLAUDE.md'))) return;
      copyFileSync(join(CONTEXTS, template), file);
    } catch (err) {
      log('could not write AGENTS.md in', dir, err.message);
    }
  };
  put(project.root, 'project.md');
  for (const inst of project.instances) put(resolve(project.root, inst.dir), 'executor.md');
}

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
    model: inst.model ?? null,
    sessionId: inst.sessionId ?? null,
    // The instance comes back to the session it last used, also after a daemon restart.
    onSession: (sid) => {
      inst.sessionId = sid;
      save();
    },
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
      seedGuides(p);
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
    seedGuides(project);
  } catch (err) {
    // All or nothing: undo a half-built project.
    for (const a of instancesOf(id)) pool.delete(a.name);
    projects = projects.filter((p) => p.id !== id);
    throw err;
  }
  return listProjects().find((p) => p.id === id);
}

export function addInstance(projectId, { id, type, dir = '.', role = null, model = null, sessionId = null }, { persist = true } = {}) {
  const project = find(projectId);
  checkId('instance', id);
  if (!AGENTS[type]) throw new Error(`unknown type "${type}"; available: ${Object.keys(AGENTS).join(', ')}`);
  if (project.instances.some((i) => i.id === id)) throw new Error(`instance "${id}" already exists in project "${projectId}"`);
  const abs = resolveInside(project.root, dir);

  const rel = relative(project.root, abs).replace(/\\/g, '/') || '.';
  const inst = {
    id,
    type,
    dir: rel,
    role: role ? String(role).slice(0, 500) : null,
    model: model ? String(model).slice(0, 200) : null,
    // "new" (or nothing) means: start a fresh session on first use.
    sessionId: sessionId && sessionId !== 'new' ? String(sessionId).slice(0, 200) : null,
  };
  project.instances.push(inst);
  const agent = register(project, inst);
  if (persist) save();
  seedGuides(project);
  return { key: agent.name, id, type, dir: rel, cwd: abs, role: inst.role, model: inst.model, sessionId: inst.sessionId };
}

// -- probes: what can I pick before the instance exists? -----------------------------

const PROBE_DIR = join(DATA_DIR, 'probe');
const modelCache = new Map();

/** Models a CLI type offers. Needs a session, so it runs in a scratch directory, once per type. */
export async function probeModels(type, { refresh = false } = {}) {
  if (!AGENTS[type]) throw new Error(`unknown type "${type}"; available: ${Object.keys(AGENTS).join(', ')}`);
  if (modelCache.has(type) && !refresh) return modelCache.get(type);
  mkdirSync(PROBE_DIR, { recursive: true });
  const tmp = buildInstance({ id: `probe-${type}`, type, cwd: PROBE_DIR });
  try {
    const d = await tmp.describeModels();
    const opt = d.configOptions.find((o) => o.id === 'model');
    const out = {
      type,
      current: opt?.currentValue ?? null,
      default: defaultModelFor(type),
      models: (opt?.options ?? []).map((o) => ({ value: o.value, name: o.name ?? o.value })),
    };
    modelCache.set(type, out);
    return out;
  } finally {
    await tmp.shutdown().catch(() => {});
  }
}

/** Sessions a CLI already has in `dir` of the project, for picking one when creating an instance. */
export async function probeSessions(projectId, type, dir = '.') {
  const project = find(projectId);
  if (!AGENTS[type]) throw new Error(`unknown type "${type}"; available: ${Object.keys(AGENTS).join(', ')}`);
  const abs = resolveInside(project.root, dir);
  const taken0 = new Set(project.instances.map((i) => i.sessionId).filter(Boolean));
  // Reading the CLI's own session folder takes milliseconds; starting the CLI takes seconds.
  const disk = type === 'dsh' ? dshSessions(abs) : null;
  if (disk) return { sessions: disk.sessions.filter((x) => !taken0.has(x.sessionId)), remoteError: null };
  const tmp = buildInstance({ id: `probe-${type}-s`, type, cwd: abs });
  try {
    const r = await tmp.listSessions();
    // Sessions another instance of this project already owns are not offered twice.
    const taken = new Set(project.instances.map((i) => i.sessionId).filter(Boolean));
    return {
      sessions: r.sessions.filter((s) => s.source === 'agent' && !taken.has(s.sessionId)),
      remoteError: r.remoteError,
    };
  } finally {
    await tmp.shutdown().catch(() => {});
  }
}

/**
 * Edit an instance: role, preferred model, and (while idle) name and directory. The CLI type is fixed.
 * A new name or directory restarts the process under the new identity; a new directory forgets the
 * remembered session, because sessions belong to the directory they were made in.
 */
export async function updateInstance(projectId, id, { role, model, name, dir }) {
  const project = find(projectId);
  const inst = project.instances.find((i) => i.id === id);
  if (!inst) throw new Error(`unknown instance "${id}" in project "${projectId}"`);
  let agent = pool.get(keyOf(projectId, id));
  const rename = name !== undefined && name !== id;
  const relDir = dir !== undefined ? relative(project.root, resolveInside(project.root, dir || '.')).replace(/\\/g, '/') || '.' : inst.dir;
  const moved = relDir !== inst.dir;
  if (rename || moved) {
    if (rename) {
      checkId('instance', name);
      if (project.instances.some((i) => i.id === name)) throw new Error(`instance "${name}" already exists in project "${projectId}"`);
    }
    if (agent.busy) throw new Error(`instance "${id}" is running a prompt; cancel it first`);
    await agent.shutdown();
    pool.delete(agent.name);
    if (rename) inst.id = name;
    if (moved) {
      inst.dir = relDir;
      inst.sessionId = null;
    }
    agent = register(project, inst);
    id = inst.id;
  }
  if (role !== undefined) {
    inst.role = role ? String(role).slice(0, 500) : null;
    agent.role = inst.role ?? agent.role;
  }
  if (model !== undefined) {
    inst.model = model ? String(model).slice(0, 200) : null;
    await agent.chooseModel(inst.model);
  }
  save();
  seedGuides(project);
  return { key: agent.name, id, role: inst.role, model: inst.model, dir: inst.dir };
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

/** Stop instances (project and built-in alike, so none holds a slot forever) idle for `ms`. Returns their keys. */
export async function sweepIdle(ms) {
  const now = Date.now();
  const stopped = [];
  for (const a of pool.values()) {
    if (!a.child || a.busy || now - a.lastActive < ms) continue;
    await a.shutdown();
    stopped.push(a.name);
  }
  return stopped;
}
