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
 * Past the configured size, compact: only between runs, never while the thing works, and not again when the last
 * compaction did not bring the conversation down (it would only loop).
 *
 * It works on anything that can say how full its conversation is and compact it, so an executor and a project's
 * dispatcher follow the same rules:
 *
 * @param {{
 *   name: string,                       // for the log and the session's record
 *   owner: { _compacting?: boolean },    // holds the "compaction under way" flag
 *   compactAt: number | null,            // tokens; null: never
 *   busy: boolean,
 *   sessionKey: string | null,           // the conversation being compacted
 *   context: () => { used: number | null, size: number | null, percent: number | null } | null,
 *   compact: () => Promise<unknown>,
 *   contextAfter?: () => Promise<any> | any,
 *   onCompact?: (info: object) => void,
 * }} t
 */
export async function compactIfNeeded(t) {
  const ctx = t.context();
  if (!t.compactAt || t.owner._compacting || t.busy || !t.sessionKey || ctx?.used == null) return;
  const limit = ctx.size ? Math.min(t.compactAt, Math.floor(ctx.size * 0.9)) : t.compactAt;
  if (ctx.used < limit) return;
  const e = entry(t.name, t.sessionKey);
  if (e.lastCompactUsed != null && ctx.used >= e.lastCompactUsed * 0.9 && e.compactedAt && Date.now() - e.compactedAt < 30 * 60_000) return;
  t.owner._compacting = true;
  const sessionKey = t.sessionKey;
  try {
    await t.compact();
    const after = (await t.contextAfter?.()) ?? t.context();
    // Counted once, before it is saved: saving changes the record `e` points to, so asking it again would say one too many.
    const compactions = (e.compactions ?? 0) + 1;
    noteSession(t.name, sessionKey, { compactions, compactedAt: Date.now(), lastCompactUsed: ctx.used });
    t.onCompact?.({ agent: t.name, sessionId: sessionKey, before: ctx, after, threshold: limit, compactions });
  } catch (err) {
    log(`[${t.name}] compaction failed: ${err.message}`);
  } finally {
    t.owner._compacting = false;
  }
}

/** An executor: the CLI does the compacting, we ask it with its own command. */
export function maybeCompact(agent) {
  const cmd = COMPACT_PROMPT[agent.type];
  if (!cmd) return Promise.resolve();
  const sessionId = agent.sessionId;
  return compactIfNeeded({
    name: agent.name,
    owner: agent,
    compactAt: agent.compactAt,
    busy: agent.busy,
    sessionKey: sessionId,
    context: () => contextOf(agent),
    compact: async () => {
      await agent.startPrompt(cmd, { timeoutMs: 600_000 }).done;
      agent.primed.delete(sessionId); // the rules may have been compacted away: send them again with the next prompt
    },
    onCompact: (info) => agent.onCompact?.(info),
  });
}
