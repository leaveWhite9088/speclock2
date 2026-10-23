/** Keeping a conversation within its window: the figure for how full it is, and compaction past a set size. */

import { log } from './config.mjs';
import { entry, noteSession, saved } from './store.mjs';

/**
 * How to compact a conversation, per CLI type. The CLI does the compacting; we only say when. mcode advertises
 * a "compact" slash command; pi's ACP adapter turns "/compact" into pi's own compact command; claude, codex and opencode accept
 * "/compact" too (opencode does not advertise it, but it works). dsh offers none
 * over ACP, so it has no entry and a compaction threshold does nothing for it.
 */
export const COMPACT_PROMPT = { mcode: '/compact', pi: '/compact', claude: '/compact', codex: '/compact', opencode: '/compact' };
export const canCompact = (type) => Boolean(COMPACT_PROMPT[type]);

/** How full the conversation is: the live figure while running, else the last one saved for the session. */
export function contextOf(a) {
  const live = a.child && a.lastUsage?.percent != null ? a.lastUsage : null;
  const c = live ?? saved(a.name, a.sessionId ?? a.preferSession)?.context ?? null;
  return c && c.percent != null ? { used: c.used, size: c.size, percent: c.percent } : null;
}

/**
 * Past the configured size, ask the CLI to compact: only between runs, never while the executor works, and not
 * again when the last compaction did not bring the conversation down (it would only loop).
 */
export async function maybeCompact(agent) {
  const cmd = COMPACT_PROMPT[agent.type];
  const ctx = contextOf(agent);
  if (!cmd || !agent.compactAt || agent._compacting || agent.busy || !agent.sessionId || ctx?.used == null) return;
  const limit = ctx.size ? Math.min(agent.compactAt, Math.floor(ctx.size * 0.9)) : agent.compactAt;
  if (ctx.used < limit) return;
  const e = entry(agent.name, agent.sessionId);
  if (e.lastCompactUsed != null && ctx.used >= e.lastCompactUsed * 0.9 && e.compactedAt && Date.now() - e.compactedAt < 30 * 60_000) return;
  agent._compacting = true;
  const sessionId = agent.sessionId;
  try {
    await agent.startPrompt(cmd, { timeoutMs: 600_000 }).done;
    agent.primed.delete(sessionId); // the rules may have been compacted away: send them again with the next prompt
    const after = contextOf(agent);
    noteSession(agent.name, sessionId, { compactions: (e.compactions ?? 0) + 1, compactedAt: Date.now(), lastCompactUsed: ctx.used });
    agent.onCompact?.({ agent: agent.name, sessionId, before: ctx, after, threshold: limit, compactions: (e.compactions ?? 0) + 1 });
  } catch (err) {
    log(`[${agent.name}] compaction failed: ${err.message}`);
  } finally {
    agent._compacting = false;
  }
}
