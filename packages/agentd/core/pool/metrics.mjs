/** What a finished run looks like in numbers, and the health signals the scheduler infers from it. */

import { flattenOptions } from './config.mjs';
import { noteSession } from './store.mjs';

/** Numeric view of a run. Token counts are only present when the agent reports them. */
export function runMetrics(agent, run) {
  const ended = run.endedAt ?? Date.now();
  const durationMs = ended - run.startedAt;
  const seconds = durationMs / 1000;
  const ttftMs = run.firstChunkAt ? run.firstChunkAt - run.startedAt : null;

  const tokens = run.tokens ?? null;
  const outputTokens = tokens?.output ?? null;
  const tps = outputTokens != null && seconds > 0 ? +(outputTokens / seconds).toFixed(1) : null;
  const charsPerSecond = run.text.length && seconds > 0 ? +(run.text.length / seconds).toFixed(1) : null;

  const metrics = {
    jobId: run.jobId,
    durationMs,
    timeToFirstTokenMs: ttftMs,
    chars: run.text.length,
    chunks: run.chunks,
    thinkingChars: run.thoughtChars,
    stopReason: run.stopReason,
    model: run.model,
    modelName: modelName(agent, run.model),
    tokens,
    tokensSource: tokens ? 'agent' : 'unavailable',
    tokensPerSecond: tps,
    charsPerSecond,
    context: run.context,
    cost: run.cost,
    logFile: run.logFile,
    error: run.error,
    // How the run ended: done, failed, timeout, cancelled. `forced`: the process had to be killed to end it.
    outcome: outcomeOf(run),
    forced: Boolean(run.forced),
  };

  // Kept per session, so an idle executor still shows how full its conversation is.
  if (run.context && run.sessionId) noteSession(agent.name, run.sessionId, { context: run.context });

  const attention = deriveAttention(agent, run, metrics);
  metrics.attention = attention;
  metrics.health = attention.some((a) => a.severity === 'error')
    ? 'error'
    : attention.some((a) => a.severity === 'warn')
      ? 'warn'
      : 'ok';

  return metrics;
}

function outcomeOf(run) {
  if (run.error) return run.errorKind ?? (/timed out|did not finish within/i.test(run.error) ? 'timeout' : 'failed');
  return run.stopReason === 'cancelled' ? 'cancelled' : 'done';
}

/**
 * Health signals the scheduler can infer on its own.
 *
 * These deliberately need no cooperation from the agent: they come from the
 * protocol result, our own timers and the context usage the agent reports.
 * `source: 'system'` marks them as inferred, so a future agent-reported signal
 * can be told apart from these.
 */
function deriveAttention(agent, run, m) {
  const out = [];
  const add = (code, severity, text) => out.push({ code, severity, source: 'system', text });

  if (run.error) {
    if (/timed out|did not finish within/i.test(run.error)) {
      add('timeout', 'error', `run did not finish in time: ${run.error}`);
    } else {
      add('run_failed', 'error', run.error);
    }
  }

  if (run.forced) add('forced_stop', 'error', 'the agent ignored the cancel; its process was stopped and restarts with the next task');
  if (m.stopReason === 'refusal') add('refused', 'error', 'agent refused the task');
  if (m.stopReason === 'cancelled') add('cancelled', 'warn', 'run was cancelled before finishing');

  if (!run.error && run.stopReason !== 'cancelled' && !run.text.trim()) {
    add(
      'empty_output',
      'warn',
      run.thoughtChars > 0
        ? `agent produced no answer text (${run.thoughtChars} chars of reasoning only)`
        : 'agent produced no output at all',
    );
  }

  if (m.context?.percent != null && m.context.percent >= 80) {
    add(
      'context_pressure',
      m.context.percent >= 95 ? 'error' : 'warn',
      `context window ${m.context.percent}% full (${m.context.used}/${m.context.size}); compaction is near`,
    );
  }

  if (run.spawnsAtStart != null && agent.spawnCount > run.spawnsAtStart) {
    add('agent_restarted', 'error', 'the agent process restarted during this run');
  }

  if (m.durationMs > 30_000 && agent.durationHistory.length >= 5) {
    const sorted = [...agent.durationHistory].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    if (p95 > 0 && m.durationMs > p95 * 2) {
      add('slow_run', 'info', `took ${(m.durationMs / 1000).toFixed(1)}s, more than twice the p95 (${(p95 / 1000).toFixed(1)}s)`);
    }
  }

  return out;
}

export function modelName(agent, value) {
  if (!value) return null;
  const opt = agent.configOptions?.find((o) => o.id === 'model');
  return flattenOptions(opt?.options).find((o) => o.value === value)?.name ?? null;
}

export function formatMetrics(m, agent) {
  if (!m) return '';
  const lines = ['---'];
  lines.push(`agent: ${agent.name} (${agent.spec.label})   session: ${agent.sessionId}`);
  lines.push(`model: ${m.modelName ?? m.model ?? '(unknown)'}`);
  lines.push(
    `duration: ${m.durationMs}ms` +
      (m.timeToFirstTokenMs != null ? `   first token: ${m.timeToFirstTokenMs}ms` : ''),
  );
  if (m.tokens) {
    const t = m.tokens;
    lines.push(
      `tokens: in ${t.input ?? '?'} / out ${t.output ?? '?'}` +
        (t.cacheRead != null ? ` / cache-read ${t.cacheRead}` : '') +
        (t.total != null ? ` / total ${t.total}` : ''),
    );
    if (m.tokensPerSecond != null) lines.push(`tps: ${m.tokensPerSecond} tok/s (output)`);
  } else {
    lines.push('tokens: not exposed by this agent over ACP');
  }
  if (m.charsPerSecond != null) {
    lines.push(`throughput: ${m.charsPerSecond} chars/s, ${m.chars} chars in ${m.chunks} chunks`);
  }
  if (m.thinkingChars) lines.push(`thinking: ${m.thinkingChars} chars of reasoning`);
  if (m.context) {
    lines.push(
      `context: ${m.context.used ?? '?'} / ${m.context.size ?? '?'}` +
        (m.context.percent != null ? ` (${m.context.percent}%)` : ''),
    );
  }
  if (m.cost) lines.push(`cost: ${m.cost.amount ?? '?'} ${m.cost.currency ?? ''}`.trim());
  if (m.logFile) lines.push(`log: ${m.logFile}`);
  lines.push(`spawns: ${agent.spawnCount}`);
  return lines.join('\n');
}
