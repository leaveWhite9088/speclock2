/**
 * The record of an executor's runs, on its own: no process.
 *
 * Checks:
 *   1. a refused run (cancelled while waiting, or the process is unstable) has the error and the metrics its receipt needs
 *   2. a run starts with its own log file, is found by its job id, and is the current one until it ends
 *   3. it ends with its figures; a run that did not fail feeds the duration window (bounded), a failed one does not
 *   4. the last thirty runs are kept, oldest forgotten first
 *   5. a snapshot says whether it still runs, how long it took, and what is not in the transcript yet
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTD_RUNS_DIR = mkdtempSync(join(tmpdir(), 'agentd-runs-'));
const { RunLog, refusedRun } = await import('../core/pool/acp/runs.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== executor client: runs ===\n');

// 1
const c = refusedRun('j1', 'cancelled', 'cancelled before it started', { health: 'warn', text: 'the run was cancelled before it started' });
check('a cancelled run: kind, outcome, source and health', c.kind === 'cancelled' && c.metrics.outcome === 'cancelled' && c.metrics.failureSource === 'agentd' && c.metrics.health === 'warn' && c.metrics.forced === false && c.metrics.jobId === 'j1');
check('and a warning saying why', c.metrics.attention[0].code === 'cancelled' && c.metrics.attention[0].severity === 'warn' && c.metrics.attention[0].source === 'system');
const u = refusedRun('j2', 'unstable', 'killed too often', { health: 'error', text: 'killed too often' });
check('an unstable one is an error', u.kind === 'unstable' && u.metrics.outcome === 'unstable' && u.metrics.health === 'error' && u.metrics.attention[0].severity === 'error' && u.message === 'killed too often');

// 2
const log = new RunLog({ name: 'runs-test' });
const run = log.begin('job-a', { sessionId: 'S1', model: 'm1' });
check('a run starts as the current one, with its session and model', log.run === run && run.sessionId === 'S1' && run.model === 'm1' && run.agent === 'runs-test' && run.endedAt === null);
check('it has a log file of its own', run.logFile && existsSync(run.logFile) && run.logFile.includes('job-a'));
check('and is found by its job id', log.jobs.get('job-a') === run);

// 5 (while it runs)
run.text = 'abc def';
run.flushed = 3;
run.chunks = 2;
run.thought = 'hmm';
const live = log.tail('job-a', () => ({ m: 1 }));
check('a snapshot of a running one says so', live.running === true && live.chars === 7 && live.pendingText === ' def' && live.pendingThought === 'hmm' && live.metrics.m === 1);
check('with no job id it is the one going on', log.tail(undefined, () => ({})).jobId === 'job-a');
check('an unknown one is nothing', log.tail('nope', () => ({})) === null);

// 3
const m = log.finish(run, () => ({ durationMs: 40 }));
check('it ends with its figures, and is no longer the current one', m.durationMs === 40 && log.run === null && run.endedAt > 0);
check('a snapshot of a finished one says so', log.tail('job-a', () => ({})).running === false);
check('with no job id and nothing running, the newest finished one', log.tail(undefined, () => ({})).jobId === 'job-a');
check('a run that went well feeds the window', log.durationHistory.join() === '40');
const bad = log.begin('job-b', { sessionId: 'S1', model: 'm1' });
bad.error = 'boom';
log.finish(bad, () => ({ durationMs: 999 }));
check('a failed one does not', log.durationHistory.join() === '40');
for (let i = 0; i < 25; i++) {
  const r = log.begin(`w${i}`, { sessionId: 'S', model: 'm' });
  log.finish(r, () => ({ durationMs: i }));
}
check('the window is bounded (the last twenty)', log.durationHistory.length === 20 && log.durationHistory.at(-1) === 24 && log.durationHistory[0] === 5, String(log.durationHistory.length));

// 4
for (let i = 0; i < 40; i++) log.begin(`x${i}`, { sessionId: 'S', model: 'm' });
check('the last thirty runs are kept, the oldest forgotten', log.jobs.size === 30 && !log.jobs.has('x0') && log.jobs.has('x39') && !log.jobs.has('job-a'), String(log.jobs.size));

console.log(process.exitCode ? '\n=> ✗ RUNS BROKEN' : '\n=> ✓ RUNS OK');
process.exit(process.exitCode ?? 0);
