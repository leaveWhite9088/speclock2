/**
 * Which tasks were in flight, kept on disk.
 *
 * A receipt is written when a task ends, so a daemon that dies mid-task would leave no trace of it. Every task
 * is therefore noted here when it is handed over and again when it ends. At startup, a task with a start and no
 * end is one the last daemon never finished: it is reported as interrupted and remembered per executor until
 * that executor gets new work. We only record it. Whether to run it again is for the dispatcher or a person to
 * decide, because the executor may have written half of its files.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR, log } from './pool/config.mjs';

const FILE = process.env.AGENTD_JOURNAL_FILE || join(DATA_DIR, 'journal.jsonl');
const INTERRUPTED_FILE = `${FILE}.interrupted.json`;

function append(rec) {
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    appendFileSync(FILE, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n', 'utf8');
  } catch (err) {
    log('could not write the journal:', err.message);
  }
}

export const journalStart = ({ jobId, agent, project, prompt, taskId = null, attempt = null, retryOf = null }) =>
  append({ kind: 'start', jobId, agent, project: project ?? null, prompt: typeof prompt === 'string' ? prompt.slice(0, 160) : null, taskId, attempt, retryOf });

export const journalEnd = (jobId) => append({ kind: 'end', jobId });

/** Executor name -> its last interrupted task, until it gets new work. */
let interrupted = {};
try {
  interrupted = JSON.parse(readFileSync(INTERRUPTED_FILE, 'utf8')) ?? {};
} catch {
  /* none yet */
}

function saveInterrupted() {
  try {
    mkdirSync(dirname(INTERRUPTED_FILE), { recursive: true });
    writeFileSync(INTERRUPTED_FILE, JSON.stringify(interrupted, null, 2), 'utf8');
  } catch (err) {
    log('could not save interrupted tasks:', err.message);
  }
}

export const interruptedOf = (agent) => interrupted[agent] ?? null;

/** The executor got new work, so the old notice no longer applies. */
export function clearInterrupted(agent) {
  if (!interrupted[agent]) return;
  delete interrupted[agent];
  saveInterrupted();
}

/**
 * Startup pass: tasks that started and never ended are interrupted. Returns them, then empties the journal, so
 * each one is reported once.
 */
export function reconcileJournal() {
  const open = new Map();
  try {
    for (const line of readFileSync(FILE, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r;
      try {
        r = JSON.parse(line);
      } catch {
        continue; // a half-written last line
      }
      if (r.kind === 'start') open.set(r.jobId, r);
      else if (r.kind === 'end') open.delete(r.jobId);
    }
  } catch {
    return [];
  }
  const lost = [...open.values()].map((r) => ({ jobId: r.jobId, agent: r.agent, project: r.project, prompt: r.prompt, startedAt: r.ts, taskId: r.taskId ?? null, attempt: r.attempt ?? null, retryOf: r.retryOf ?? null }));
  try {
    writeFileSync(FILE, '', 'utf8');
  } catch (err) {
    log('could not reset the journal:', err.message);
  }
  if (lost.length) {
    for (const j of lost) interrupted[j.agent] = j; // the newest one per executor
    saveInterrupted();
  }
  return lost;
}
