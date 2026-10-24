/**
 * How the daemon lives and ends. Project instances and dispatchers that were not used for a while are stopped (their
 * sessions stay on disk and come back on the next use); the daemon itself exits when nobody is connected and nothing
 * runs; a signal shuts everything down cleanly.
 */

import { rmSync } from 'node:fs';

/**
 * @param {{
 *   endpointFile: string, pool: Map<string, any>, dispatchers: Map<string, any>,
 *   sweepIdle: (ms: number) => Promise<string[]>,       // stops idle project instances, says which
 *   stats: { connections: number, lastActivity: number },
 *   idleMs: number, idleInstanceMs: number,
 *   log: (...a: any[]) => void,
 * }} o
 * @returns {{ shutdown: (code: number) => Promise<void> }}
 */
export function startLifecycle({ endpointFile, pool, dispatchers, sweepIdle, stats, idleMs, idleInstanceMs, log }) {
  const anyDispatcherBusy = () => [...dispatchers.values()].some((d) => d.busy);

  async function shutdown(code) {
    try {
      rmSync(endpointFile, { force: true });
    } catch {
      /* ignore */
    }
    await Promise.all([...[...pool.values()].map((a) => a.shutdown()), ...[...dispatchers.values()].map((d) => d.shutdown())]);
    process.exit(code);
  }

  // Idle recycling.
  setInterval(async () => {
    try {
      const stopped = await sweepIdle(idleInstanceMs);
      for (const [key, d] of dispatchers) {
        if (d.child && !d.busy && Date.now() - d.lastActive > idleInstanceMs) {
          await d.shutdown();
          stopped.push(`dispatcher:${key || 'global'}`);
        }
      }
      if (stopped.length) log(`idle, stopped: ${stopped.join(', ')}`);
    } catch (err) {
      log('idle sweep failed:', err.message);
    }
  }, 60_000).unref();

  // Idle shutdown: no clients, nothing running.
  setInterval(() => {
    const busy = [...pool.values()].some((a) => a.busy) || anyDispatcherBusy();
    if (stats.connections === 0 && !busy && Date.now() - stats.lastActivity > idleMs) {
      log('idle; shutting down');
      shutdown(0);
    }
  }, 30_000).unref();

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));
  process.on('uncaughtException', (e) => {
    log('uncaught:', e?.stack ?? String(e));
  });

  return { shutdown };
}
