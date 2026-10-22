/**
 * Which runs are attempts at the same task, and how many failed attempts a task may have.
 *
 * A run (`jobId`) is one attempt. When a run fails and the same thing is sent again, the new run belongs to the
 * same task: it gets the same `taskId` and the next `attempt` number. After MAX_ATTEMPTS failed attempts the task
 * is not sent again, because a dispatcher that is a model will otherwise retry the same failure for ever.
 *
 * A resend is recognised two ways, so it does not depend on the dispatcher cooperating:
 *   - it names the earlier run or task (`retryOf`), or
 *   - the same executor gets the same prompt shortly after a failed attempt.
 * Only failures count. A run that was cancelled or finished ends the task.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG, DATA_DIR, log } from './pool/config.mjs';

const FILE = process.env.AGENTD_TASKS_FILE || join(DATA_DIR, 'tasks.json');
/** The same prompt counts as a resend for this long after a failure. */
const RESEND_WINDOW_MS = 30 * 60_000;
const KEEP_TASKS = 300;
/** Outcomes that count as a failed attempt (a refused run, `unstable`, never ran and does not count). */
const FAILED = new Set(['failed', 'timeout', 'interrupted']);

export const maxAttempts = () => Number(CONFIG?.limits?.maxAttempts) || 3;

/** @type {Record<string, { id: string, agent: string, hash: string, closed: boolean, createdAt: number, attempts: { jobId: string, agent: string, outcome: string | null, at: number }[] }>} */
let tasks = {};
/** jobId -> taskId */
const byJob = new Map();

try {
  tasks = JSON.parse(readFileSync(FILE, 'utf8')) ?? {};
  for (const t of Object.values(tasks)) for (const a of t.attempts) byJob.set(a.jobId, t.id);
} catch {
  /* none yet */
}

function save() {
  const ids = Object.keys(tasks);
  if (ids.length > KEEP_TASKS) {
    ids.sort((a, b) => tasks[a].createdAt - tasks[b].createdAt);
    for (const id of ids.slice(0, ids.length - KEEP_TASKS)) {
      for (const a of tasks[id].attempts) byJob.delete(a.jobId);
      delete tasks[id];
    }
  }
  try {
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify(tasks), 'utf8');
  } catch (err) {
    log('could not save tasks:', err.message);
  }
}

export const hashOf = (prompt) => createHash('sha1').update(String(prompt ?? '').split(/\s+/).join(' ').trim()).digest('hex');
const failedCount = (t) => t.attempts.filter((a) => FAILED.has(a.outcome)).length;
const lastOf = (t) => t.attempts.at(-1);

/**
 * Decide which task a run belongs to, before it starts. Throws `retry-limit` when the task has used up its attempts.
 * @returns {{ taskId: string, attempt: number, retryOf: string | null, maxAttempts: number, hash: string, agent: string, isNew: boolean }}
 */
export function planRun({ agent, prompt, retryOf = null }) {
  const hash = hashOf(prompt);
  const limit = maxAttempts();
  let task = null;

  if (retryOf) {
    const id = byJob.get(retryOf) ?? (tasks[retryOf] ? retryOf : null);
    if (id && !tasks[id].closed) task = tasks[id];
  }
  if (!task) {
    const now = Date.now();
    task =
      Object.values(tasks)
        .filter((t) => !t.closed && t.agent === agent && t.hash === hash && FAILED.has(lastOf(t)?.outcome) && now - lastOf(t).at < RESEND_WINDOW_MS)
        .sort((a, b) => lastOf(b).at - lastOf(a).at)[0] ?? null;
  }

  if (task) {
    if (failedCount(task) >= limit) {
      const ids = task.attempts.map((a) => a.jobId).join(', ');
      const err = new Error(
        `This task has already failed ${failedCount(task)} times (${ids}), so it is not sent again. ` +
          'Do not retry it. Tell the user what happened and let them decide.',
      );
      err.kind = 'retry-limit';
      throw err;
    }
    return { taskId: task.id, attempt: task.attempts.length + 1, retryOf: lastOf(task)?.jobId ?? null, maxAttempts: limit, hash, agent, isNew: false };
  }
  return { taskId: `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, attempt: 1, retryOf: null, maxAttempts: limit, hash, agent, isNew: true };
}

/** The run exists now: file it under its task. */
export function recordRun(plan, jobId) {
  const task = (tasks[plan.taskId] ??= { id: plan.taskId, agent: plan.agent, hash: plan.hash, closed: false, createdAt: Date.now(), attempts: [] });
  task.attempts.push({ jobId, agent: plan.agent, outcome: null, at: Date.now() });
  byJob.set(jobId, plan.taskId);
  save();
}

/** The run ended. A finished or cancelled run closes its task; a failed one leaves it open for a retry. */
export function endRun(jobId, outcome) {
  const task = tasks[byJob.get(jobId)];
  const attempt = task?.attempts.find((a) => a.jobId === jobId);
  if (!attempt) return;
  attempt.outcome = outcome;
  attempt.at = Date.now();
  if (!FAILED.has(outcome) && outcome !== 'unstable') task.closed = true;
  save();
}

export const taskOf = (jobId) => tasks[byJob.get(jobId)] ?? null;
