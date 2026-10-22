/** Stopping a child process for good. */

import { spawn } from 'node:child_process';

/**
 * Kill a child and everything it started. `child.kill()` alone ends only the direct child on Windows, and
 * most of the CLIs here are an adapter that starts the real CLI, which starts its tools: a hung build would
 * survive its parent.
 */
export function killTree(child) {
  const pid = child?.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    try {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => child.kill());
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}
