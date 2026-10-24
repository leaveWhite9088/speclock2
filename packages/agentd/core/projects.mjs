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
 * The configuration lives in agentd's own data/projects.json. Nothing is written into the project: the rules for
 * the dispatcher and the executors are handed to each CLI as extra system instructions (rules.mjs), so the
 * project's own AGENTS.md / CLAUDE.md stay as they are.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executorRulesFor, getTemplate } from './templates.mjs';
import { dshSessions } from './session-disk.mjs';
import { AGENTS, buildInstance, defaultModelFor, listInstances, pool } from './agent-pool.mjs';

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

/** Like resolveInside, but a missing directory (still inside the root) is created. */
export function ensureInside(root, dir) {
  const target = resolve(root, String(dir ?? '.') || '.');
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`directory "${dir}" is outside the project root`);
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  return resolveInside(root, dir);
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', '__pycache__']);

/** Existing sub-directories of the project root (two levels), as "./x/y", for the directory picker. */
export function listDirs(projectId) {
  const project = find(projectId);
  const out = [];
  const walk = (abs, rel, depth) => {
    let names = [];
    try {
      names = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const r = `${rel}/${e.name}`;
      out.push(r);
      if (depth > 1) walk(join(abs, e.name), r, depth - 1);
    }
  };
  walk(project.root, '.', 2);
  return { root: project.root, dirs: out.sort() };
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
    compactAt: inst.compactAt ?? null,
    // A function: the rules are read again whenever the agent starts, so an edited template applies at once.
    systemPrompt: () => executorRulesFor(inst.template) || null,
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
        template: p.instances.find((i) => i.id === r.shortId)?.template ?? null,
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

/** A token count (or null for "never"). */
function cleanCompactAt(v) {
  if (v == null || v === '' || v === 0) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 10_000) throw new Error('compactAt must be a token count of at least 10000, or empty for never');
  return Math.round(n);
}

export function addInstance(projectId, spec, { persist = true } = {}) {
  const project = find(projectId);
  // A template gives what the request leaves out.
  const tpl = spec.template ? getTemplate(spec.template) : null;
  if (spec.template && !tpl) throw new Error(`unknown template "${spec.template}"`);
  const id = spec.id;
  const type = spec.type || tpl?.type;
  const dir = spec.dir || tpl?.dir || '.';
  const role = spec.role || tpl?.role || null;
  const model = spec.model || tpl?.model || null;
  const { sessionId = null, compactAt = null } = spec;
  checkId('instance', id);
  if (!AGENTS[type]) throw new Error(`unknown type "${type}"; available: ${Object.keys(AGENTS).join(', ')}`);
  if (project.instances.some((i) => i.id === id)) throw new Error(`instance "${id}" already exists in project "${projectId}"`);
  const abs = ensureInside(project.root, dir);

  const rel = relative(project.root, abs).replace(/\\/g, '/') || '.';
  const inst = {
    id,
    type,
    dir: rel,
    role: role ? String(role).slice(0, 500) : null,
    model: model ? String(model).slice(0, 200) : null,
    // "new" (or nothing) means: start a fresh session on first use.
    sessionId: sessionId && sessionId !== 'new' ? String(sessionId).slice(0, 200) : null,
    compactAt: cleanCompactAt(compactAt),
    template: tpl?.id ?? null,
  };
  project.instances.push(inst);
  const agent = register(project, inst);
  if (persist) save();
  return { key: agent.name, id, type, dir: rel, cwd: abs, role: inst.role, model: inst.model, sessionId: inst.sessionId, compactAt: inst.compactAt, template: inst.template };
}

/** Executors (in any project) made from a template: [{ project, id }]. */
export function templateUsers(templateId) {
  return projects.flatMap((p) => p.instances.filter((i) => i.template === templateId).map((i) => ({ project: p.id, id: i.id })));
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
 * Edit an instance: role, preferred model, and (while idle) name. The CLI type and the directory are fixed.
 * A new name restarts the process under the new identity.
 */
/** The size (tokens) at which the project's dispatcher compacts its conversation; null: never. */
export function dispatcherCompactAt(projectId) {
  return find(projectId).dispatcherCompactAt ?? null;
}

export function setDispatcherCompactAt(projectId, value) {
  const project = find(projectId);
  project.dispatcherCompactAt = cleanCompactAt(value);
  save();
  return project.dispatcherCompactAt;
}

export async function updateInstance(projectId, id, { role, model, name, dir, compactAt, template }) {
  const project = find(projectId);
  const inst = project.instances.find((i) => i.id === id);
  if (!inst) throw new Error(`unknown instance "${id}" in project "${projectId}"`);
  let agent = pool.get(keyOf(projectId, id));
  const rename = name !== undefined && name !== id;
  if (dir !== undefined) {
    const next = relative(project.root, ensureInside(project.root, dir || '.')).split(sep).join('/') || '.';
    if (next !== inst.dir) throw new Error("an executor's directory cannot be changed after it is created; create a new executor in that directory instead");
  }
  if (rename) {
    checkId('instance', name);
    if (project.instances.some((i) => i.id === name)) throw new Error(`instance "${name}" already exists in project "${projectId}"`);
    if (agent.busy) throw new Error(`instance "${id}" is running a prompt; cancel it first`);
    await agent.shutdown();
    pool.delete(agent.name);
    inst.id = name;
    agent = register(project, inst);
    id = inst.id;
  }
  if (role !== undefined) {
    inst.role = role ? String(role).slice(0, 500) : null;
    agent.role = inst.role ?? agent.role;
  }
  if (template !== undefined) {
    // Takes effect the next time the process starts (or a new session begins).
    if (template && !getTemplate(template)) throw new Error(`unknown template "${template}"`);
    inst.template = template || null;
  }
  if (compactAt !== undefined) {
    inst.compactAt = cleanCompactAt(compactAt);
    agent.compactAt = inst.compactAt;
  }
  if (model !== undefined) {
    inst.model = model ? String(model).slice(0, 200) : null;
    await agent.chooseModel(inst.model);
  }
  save();
  return { key: agent.name, id, role: inst.role, model: inst.model, dir: inst.dir, compactAt: inst.compactAt, template: inst.template ?? null };
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
