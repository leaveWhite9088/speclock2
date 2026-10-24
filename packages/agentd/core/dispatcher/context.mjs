/**
 * How full the dispatcher's conversation is, and compacting it past a set size. The figure comes from pi's own session
 * statistics, is kept on disk (so it is still there when the process is idle-reaped or the daemon restarts), and the
 * compaction follows the same rules as an executor's (core/pool/compaction.mjs). It reaches pi only through the
 * `command` it is given, and the turn state only through `turns`.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactIfNeeded } from '../pool/compaction.mjs';
import { saved } from '../pool/store.mjs';
import { PiRpc } from '../pi-rpc.mjs';

/** The last context figure saved for a dispatcher session directory, or null. */
export function savedContext(sessionDir) {
  try {
    return JSON.parse(readFileSync(join(sessionDir, 'context.json'), 'utf8'));
  } catch {
    return null;
  }
}

export class ContextTracker {
  /**
   * @param {{
   *   sessionDir: string,
   *   name: string,                        // the conversation's record, next to the executors'
   *   command: (type: string, params?: object, timeoutMs?: number) => Promise<any>,
   *   turns: { busy: boolean, hold: (work: () => Promise<any>) => Promise<any> },
   *   running: () => boolean,              // is the pi process up
   *   compactAt: () => number | null,
   *   onCompact: (info: object) => void,
   *   sessionFile: { get: () => string | null, set: (file: string) => void },
   * }} deps
   */
  constructor(deps) {
    this.deps = deps;
    /** `{ used, size, percent }` or null. */
    this.value = null;
    /** Held while a compaction is under way (compactIfNeeded reads it on its owner). */
    this._compacting = false;
  }

  /** How many times the conversation in use was compacted. */
  compactions() {
    return saved(this.deps.name, this.deps.sessionFile.get())?.compactions ?? 0;
  }

  _save() {
    // Kept on disk so the figure is still there when the process is idle-reaped or the daemon restarts.
    if (this.value) writeFileSync(join(this.deps.sessionDir, 'context.json'), JSON.stringify(this.value));
  }

  /** Read the figure again, then see whether it is time to compact. Never throws. */
  refresh() {
    this.deps
      .command('get_session_stats', {}, 30_000)
      .then((stats) => {
        this.value = PiRpc.contextOf(stats);
        this._save();
        void this.maybeCompact();
      })
      .catch(() => {});
  }

  /** Past the set size, between turns: pi compacts the conversation. Messages that arrive meanwhile wait their turn. */
  async maybeCompact() {
    const { turns, running, command, name, sessionDir, sessionFile } = this.deps;
    const compactAt = this.deps.compactAt();
    if (!compactAt || turns.busy || !running()) return;
    let sessionKey = null;
    try {
      const st = await command('get_state');
      sessionKey = st?.sessionFile ?? null;
      if (sessionKey) sessionFile.set(sessionKey); // so the count and the record follow this conversation
    } catch {
      return;
    }
    await compactIfNeeded({
      name,
      owner: this,
      compactAt,
      busy: turns.busy,
      sessionKey,
      context: () => this.value,
      compact: () => turns.hold(() => command('compact', {}, 600_000)),
      contextAfter: async () => {
        try {
          this.value = PiRpc.contextOf(await command('get_session_stats', {}, 30_000));
          this._save();
        } catch {
          /* keep the old figure */
        }
        return this.value;
      },
      onCompact: (info) => this.deps.onCompact(info),
    });
  }
}
