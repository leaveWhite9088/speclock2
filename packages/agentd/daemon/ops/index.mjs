/**
 * The operation table: every name a client can call, put together from the files of this folder. A name that two
 * files both define is an error (it would silently shadow the other), so it is refused when the daemon starts.
 */

import { dispatcherOps } from './dispatcher.mjs';
import { executorOps } from './executors.mjs';
import { projectOps } from './projects.mjs';
import { runOps } from './run.mjs';
import { systemOps } from './system.mjs';

/** @param {{ protocol: number, startedAt: string, idleInstanceMs: number, shutdown: (code: number) => Promise<void> }} ctx */
export function buildOps(ctx) {
  const ops = {};
  for (const part of [executorOps(ctx), runOps(ctx), dispatcherOps(ctx), projectOps(ctx), systemOps(ctx)]) {
    for (const [name, fn] of Object.entries(part)) {
      if (name in ops) throw new Error(`operation "${name}" is defined twice`);
      ops[name] = fn;
    }
  }
  return ops;
}
