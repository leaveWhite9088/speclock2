/** Per-session sidecar data (labels, cwd, model choice, context, compaction counts). Agents have no rename API. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { LABELS_FILE, log } from './config.mjs';

/** @type {Record<string, Record<string, {label?: string, cwd?: string, updatedAt?: string, note?: string}>>} */
let store = {};

function loadStore() {
  try {
    if (existsSync(LABELS_FILE)) store = JSON.parse(readFileSync(LABELS_FILE, 'utf8')) ?? {};
  } catch (err) {
    log('labels file unreadable, starting empty:', err.message);
    store = {};
  }
}

export function saveStore() {
  try {
    mkdirSync(dirname(LABELS_FILE), { recursive: true });
    writeFileSync(LABELS_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    log('failed to save labels:', err.message);
  }
}

export function entry(agent, sessionId) {
  store[agent] ??= {};
  store[agent][sessionId] ??= {};
  return store[agent][sessionId];
}

export function noteSession(agent, sessionId, patch) {
  if (!sessionId) return;
  Object.assign(entry(agent, sessionId), patch);
  saveStore();
}

loadStore();

/** Fill in sessions that finished a run before context figures were kept, from their receipts. */
export function seedContexts(receipts) {
  let changed = false;
  for (const r of [...receipts].reverse()) {
    const c = r?.context;
    if (!r?.agent || !r?.sessionId || c?.percent == null) continue;
    const e = entry(r.agent, r.sessionId);
    if (!e.context) {
      e.context = { used: c.used ?? null, size: c.size ?? null, percent: c.percent };
      changed = true;
    }
  }
  if (changed) saveStore();
}

/** Read-only views, so callers never hold the mutable map. */
export const saved = (agent, sessionId) => store[agent]?.[sessionId];
export const savedAll = (agent) => store[agent] ?? {};
