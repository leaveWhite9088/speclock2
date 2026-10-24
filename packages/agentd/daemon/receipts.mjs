/** Append-only log of finished runs, so receipts survive restarts and idle gaps. */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RECEIPTS_FILE = process.env.AGENTD_RECEIPTS_FILE || join(dirname(dirname(fileURLToPath(import.meta.url))), 'data', 'receipts.jsonl');
const log = (...a) => process.stderr.write(`[agentd] ${a.join(' ')}\n`);

export function appendReceipt(agent, result, prompt, eventId = null, task = {}) {
  const m = result?.metrics ?? {};
  const receipt = {
    ts: new Date().toISOString(),
    eventId,
    jobId: m.jobId ?? null,
    taskId: task.taskId ?? null,
    attempt: task.attempt ?? null,
    retryOf: task.retryOf ?? null,
    agent,
    sessionId: result?.sessionId ?? null,
    status: m.outcome ?? (m.error ? 'failed' : m.stopReason === 'cancelled' ? 'cancelled' : 'done'),
    forced: Boolean(m.forced),
    failureSource: m.failureSource ?? null,
    stopReason: m.stopReason ?? null,
    durationMs: m.durationMs ?? null,
    health: m.health ?? 'ok',
    attention: m.attention ?? [],
    model: m.modelName ?? m.model ?? null,
    tokens: m.tokens ?? null,
    context: m.context ?? null,
    chars: m.chars ?? 0,
    prompt: typeof prompt === 'string' ? prompt.slice(0, 160) : null,
  };
  try {
    mkdirSync(dirname(RECEIPTS_FILE), { recursive: true });
    appendFileSync(RECEIPTS_FILE, JSON.stringify(receipt) + '\n', 'utf8');
  } catch (err) {
    log('could not write receipt:', err.message);
  }
  return receipt;
}

export function readReceipts(limit = 50) {
  try {
    const lines = readFileSync(RECEIPTS_FILE, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}
