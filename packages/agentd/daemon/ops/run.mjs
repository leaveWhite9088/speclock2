/**
 * The `run` operation: give an executor a prompt. It makes the task plan (which attempt this is), starts the prompt,
 * writes the journal, announces the start and the end, and files the receipt.
 */

import { getAgent } from '../../core/agent-pool.mjs';
import { clearInterrupted, journalEnd, journalStart } from '../../core/journal.mjs';
import { endRun, planRun, recordRun } from '../../core/tasks.mjs';
import { noteRunOutcome } from '../dispatchers.mjs';
import { allocEvent, publish, subscribe } from '../events.mjs';
import { appendReceipt } from '../receipts.mjs';

/** @param {{ protocol: number, startedAt: string, idleInstanceMs: number }} ctx */
export function runOps(ctx) {
  return {
    run: async (
      { agent, prompt, cwd, timeoutMs, reset, sessionId, model, async: isAsync, subscribe: wantSub, retryOf, caller },
      sock,
    ) => {
      const a = getAgent(agent);
      // Which task is this an attempt at? Refused here when the task has used up its attempts.
      const plan = planRun({ agent: a.name, prompt, retryOf, counted: caller === 'dispatcher' });
      const task = { taskId: plan.taskId, attempt: plan.attempt, retryOf: plan.retryOf, maxAttempts: plan.maxAttempts };
      if (model) await a.setConfigOption('model', model, sessionId);
      const started = a.startPrompt(prompt, { timeoutMs, cwd, reset, sessionId, meta: { taskId: task.taskId, attempt: task.attempt, retryOf: task.retryOf } });
      recordRun(plan, started.jobId);

      // Subscribe before the run can finish. A fast agent could otherwise complete
      // between the caller receiving the jobId and its separate subscribe call,
      // and the `done` event would be broadcast to nobody.
      if (wantSub && sock) subscribe(sock, started.jobId);

      task.queued = started.ahead > 0;
      task.ahead = started.ahead;
      journalStart({ jobId: started.jobId, agent: a.name, project: a.project, prompt, ...task });
      clearInterrupted(a.name);
      publish(
        allocEvent('job.started', {
          jobId: started.jobId,
          ...task,
          agent: a.name,
          sessionId: a.sessionId,
          prompt: typeof prompt === 'string' ? prompt.slice(0, 160) : null,
        }),
      );

      const finish = (result, error) => {
        journalEnd(started.jobId);
        endRun(started.jobId, error ? (error.metrics?.outcome ?? 'failed') : (result?.metrics?.outcome ?? 'done'));
        const ev = allocEvent('job.done', {
          jobId: started.jobId,
          ...task,
          agent: a.name,
          ...(error
            ? { error: error.message, metrics: error.metrics ?? { error: error.message, attention: [], health: 'error' } }
            : { result }),
        });
        // The receipt embeds the event id, so history and stream can be joined.
        ev.receipt = appendReceipt(
          a.name,
          error ? { metrics: ev.metrics, sessionId: error.sessionId ?? null } : result,
          prompt,
          ev.id,
          task,
        );
        publish(ev);
        const failed = (!!error || !!result?.metrics?.error) && error?.metrics?.outcome !== 'cancelled';
        noteRunOutcome(a, failed, error?.message ?? result?.metrics?.error ?? '');
        return ev;
      };

      if (isAsync) {
        started.done.then((r) => finish(r)).catch((e) => finish(null, e));
        return { jobId: started.jobId, async: true, ...task };
      }

      try {
        const r = await started.done;
        const ev = finish(r);
        return { ...r, jobId: started.jobId, ...task, receipt: ev.receipt };
      } catch (e) {
        finish(null, e);
        throw e;
      }
    },
  };
}
