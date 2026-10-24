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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from './data-dir.mjs';

const DIR = process.env.AGENTD_TRANSCRIPTS_DIR || join(DATA_DIR, 'transcripts');

const safe = (s) => String(s).replace(/[^A-Za-z0-9._~-]/g, '_');
const fileFor = (instance, sessionId) => join(DIR, safe(instance), `${safe(sessionId)}.jsonl`);

/**
 * The session a run was recorded in, found by its job id (the run's prompt is written to the transcript once the
 * session is known). Looks at the instance's most recently written sessions only. Null when nothing was recorded.
 */
export function findJobSession(instance, jobId) {
  try {
    const dir = join(DIR, safe(instance));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, 8);
    for (const { f } of files) {
      if (readFileSync(join(dir, f), 'utf8').includes(`"jobId":"${jobId}"`)) return f.slice(0, -'.jsonl'.length);
    }
  } catch {
    /* no transcripts for this instance */
  }
  return null;
}

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
