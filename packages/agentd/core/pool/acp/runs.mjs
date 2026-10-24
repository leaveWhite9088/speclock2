/**
 * The record of an executor's runs: the one going on, the last thirty, and how long finished runs took (so an
 * abnormally slow one can be told from the usual). It does not run anything; the client starts a run here, the run
 * tracker fills it while it goes on, and the client ends it here.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RUNS_DIR } from '../config.mjs';

const KEEP_RUNS = 30;
const KEEP_DURATIONS = 20;

/**
 * An error for a run that was refused before it reached the CLI, with the metrics its receipt will carry.
 * `kind`: 'cancelled' (a person stopped it while it waited) or 'unstable' (the process was killed too often).
 */
export function refusedRun(jobId, kind, message, { health, text }) {
  const err = new Error(message);
  err.kind = kind;
  err.metrics = {
    jobId,
    error: message,
    outcome: kind,
    forced: false,
    failureSource: 'agentd',
    health,
    attention: [{ code: kind, severity: health === 'error' ? 'error' : 'warn', source: 'system', text }],
  };
  return err;
}

export class RunLog {
  constructor({ name }) {
    this.name = name;
    /** The run going on now: { jobId, startedAt, text, thought, tools, … } or null. */
    this.run = null;
    /** Finished runs, newest last. Bounded. */
    this.jobs = new Map();
    /** Rolling run durations, used to flag abnormally slow runs. */
    this.durationHistory = [];
  }

  /** A run starts. Its output is also written to a log file of its own, so it can be tailed from outside. */
  begin(jobId, { sessionId, model }) {
    const run = {
      jobId,
      agent: this.name,
      startedAt: Date.now(),
      firstChunkAt: null,
      endedAt: null,
      text: '',
      chunks: 0,
      thoughtChars: 0,
      thought: '',
      tools: new Map(),
      // How much of the text and reasoning already went into the transcript as pieces, and when the current piece began.
      flushed: 0,
      flushedThought: 0,
      segAt: null,
      thoughtAt: null,
      sessionId,
      model,
      context: null,
      cost: null,
      tokens: null,
      stopReason: null,
      error: null,
      spawnsAtStart: null, // set after the agent is ready
      logFile: join(RUNS_DIR, `${jobId}.log`),
    };
    try {
      mkdirSync(RUNS_DIR, { recursive: true });
      writeFileSync(run.logFile, '', 'utf8');
    } catch {
      run.logFile = null;
    }
    this.run = run;
    this.jobs.set(jobId, run);
    while (this.jobs.size > KEEP_RUNS) this.jobs.delete(this.jobs.keys().next().value);
    return run;
  }

  /** The run ends. `metricsOf(run)` works out its figures; a run that did not fail also feeds the rolling window. */
  finish(run, metricsOf) {
    run.endedAt = Date.now();
    this.run = null;
    const metrics = metricsOf(run);
    // Fed only once per finished run, so a run is never its own baseline and repeated metric reads do not skew it.
    if (!run.error) {
      this.durationHistory.push(metrics.durationMs);
      while (this.durationHistory.length > KEEP_DURATIONS) this.durationHistory.shift();
    }
    return metrics;
  }

  /** Snapshot of a run, going on or finished (the newest one without a `jobId`), or null. */
  tail(jobId, metricsOf) {
    const run = jobId ? this.jobs.get(jobId) : this.run ?? [...this.jobs.values()].pop();
    if (!run) return null;
    return {
      jobId: run.jobId,
      agent: run.agent,
      running: !run.endedAt,
      elapsedMs: (run.endedAt ?? Date.now()) - run.startedAt,
      chars: run.text.length,
      chunks: run.chunks,
      thinkingChars: run.thoughtChars,
      text: run.text,
      // What is not in the transcript yet: the page shows it as the live end of the conversation.
      pendingText: run.text.slice(run.flushed),
      pendingThought: run.thought.slice(run.flushedThought).slice(-3000),
      sessionId: run.sessionId,
      logFile: run.logFile,
      metrics: metricsOf(run),
    };
  }
}
