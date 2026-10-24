/**
 * What the new daemon does about the old one's unfinished work. Tasks the last daemon never finished (it was stopped
 * or crashed while they were queued or running) are recorded as interrupted here, before anything else runs; the
 * daemon announces them once its socket is up.
 */

import { interruptedOf, reconcileJournal } from '../core/journal.mjs';
import { endRun } from '../core/tasks.mjs';
import { appendEntry, findJobSession } from '../core/transcripts.mjs';
import { appendReceipt } from './receipts.mjs';

/** @returns {object[]} the interrupted jobs, as the journal knew them */
export function recordInterruptedJobs() {
  const lostJobs = reconcileJournal();
  for (const j of lostJobs) {
    endRun(j.jobId, 'interrupted');
    const error = 'the daemon stopped while this task was queued or running; the executor may have done part of it';
    appendReceipt(
      j.agent,
      { sessionId: null, metrics: { jobId: j.jobId, outcome: 'interrupted', error, health: 'error', attention: [{ code: 'interrupted', severity: 'error', source: 'system', text: error }] } },
      j.prompt,
      null,
      j,
    );
    // The executor's own conversation must say so too: without this the person sees their message and then nothing.
    const sid = findJobSession(j.agent, j.jobId);
    if (sid) {
      appendEntry(j.agent, sid, {
        role: 'error',
        jobId: j.jobId,
        taskId: j.taskId,
        attempt: j.attempt,
        interrupted: true,
        error: '这次任务因服务重启被中断，没有得到回复。执行者可能已经做了一部分，请先检查文件，再决定要不要重发。',
      });
    }
  }
  return lostJobs;
}

/**
 * Executor rows with what the last shutdown cut off: `interrupted: { jobId, startedAt, prompt }` while it has had no
 * new work since, else null. `keyOf(row)` is the executor's key in the pool.
 */
export const withInterrupted = (rows, keyOf = (r) => r.id) => rows.map((r) => ({ ...r, interrupted: interruptedOf(keyOf(r)) }));
