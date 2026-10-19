/**
 * Transcript store: our own record of every conversation that passes through agentd.
 *
 * The agents keep their own history on disk, but the protocol gives us no way to
 * read it back: `dsh` has no `loadSession`, and `mcode` replays history only
 * through resume. So agentd writes what it sees, one JSONL file per session:
 *
 *   data/transcripts/<instance>/<sessionId>.jsonl
 *
 * Each line is one entry: { seq, ts, role, ... }. `seq` is the 1-based line number,
 * which makes `afterSeq` a stable cursor for incremental reads.
 *
 * Roles: user, assistant, tool, error.
 * Limit: sessions that were used outside agentd have no record before the first
 * run that went through agentd.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIR = process.env.AGENTD_TRANSCRIPTS_DIR || join(ROOT, 'data', 'transcripts');

const safe = (s) => String(s).replace(/[^A-Za-z0-9._-]/g, '_');
const fileFor = (instance, sessionId) => join(DIR, safe(instance), `${safe(sessionId)}.jsonl`);

/** Append one entry. Best-effort: a failed write never breaks a run. */
export function appendEntry(instance, sessionId, entry) {
  if (!instance || !sessionId) return false;
  try {
    const file = fileFor(instance, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Read entries of one session.
 *   afterSeq  return entries with seq greater than this (default 0)
 *   limit     maximum entries returned (default 200, maximum 1000)
 *   tail      return the last `limit` entries instead of the first ones
 */
export function readTranscript(instance, sessionId, { afterSeq = 0, limit = 200, tail = false } = {}) {
  const max = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const file = fileFor(instance, sessionId);
  if (!existsSync(file)) {
    return { agent: instance, sessionId, recorded: false, total: 0, entries: [], hasMore: false };
  }

  const all = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  let seq = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    seq += 1;
    try {
      all.push({ seq, ...JSON.parse(line) });
    } catch {
      /* skip a damaged line but keep the numbering stable */
    }
  }

  const after = Math.max(Number(afterSeq) || 0, 0);
  const pool = all.filter((e) => e.seq > after);
  const entries = tail ? pool.slice(-max) : pool.slice(0, max);
  return {
    agent: instance,
    sessionId,
    recorded: true,
    total: seq,
    entries,
    hasMore: pool.length > max,
  };
}
