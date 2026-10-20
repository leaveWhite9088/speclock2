/** The pool of agent instances, plus the limits and locks that apply across them. */

import { CONFIG, DEFAULT_AGENT, normPath } from './config.mjs';

export const pool = new Map();

/** Upper bound on live agent processes, so many projects cannot exhaust memory. */
export const MAX_PROCESSES = Number(process.env.AGENTD_MAX_PROCESSES) || CONFIG?.limits?.maxProcesses || 12;

/** Model a type uses when an instance names none (agentd.config.json defaultModels). */
export function defaultModelFor(type) {
  return CONFIG?.defaultModels?.[type] ?? null;
}

export const START_ATTEMPTS = 3;
const startChains = new Map();

/** Run `fn` after the previous start of the same CLI type has finished. */
export function withStartLock(key, fn) {
  const prev = startChains.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  startChains.set(key, next.catch(() => {}));
  return next;
}

export function aliveCount(filter = () => true) {
  let n = 0;
  for (const a of pool.values()) if (a.child && filter(a)) n += 1;
  return n;
}

/** True when `cwd` is the directory of a created instance of the same CLI type. */
export function ownedByInstance(agent, cwd) {
  for (const other of pool.values()) {
    if (other === agent || !other.custom || other.type !== agent.type) continue;
    if (normPath(other.spec.defaultCwd) === normPath(cwd)) return true;
  }
  return false;
}

export function getAgent(name) {
  const key = name || DEFAULT_AGENT;
  const agent = pool.get(key);
  if (!agent) throw new Error(`unknown agent "${key}"; available: ${[...pool.keys()].join(', ')}`);
  return agent;
}
