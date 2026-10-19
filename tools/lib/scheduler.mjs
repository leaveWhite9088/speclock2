/**
 * Thin convenience wrapper over the daemon client, used by the test scripts.
 *
 * It is also the reference for "how a front end consumes agentd": the pi
 * extension does the same thing with rendering attached.
 */

import { connect } from '../../client/agentd-client.mjs';

export class Scheduler {
  constructor(client) {
    this.c = client;
  }

  static async open({ spawnOnDemand = true } = {}) {
    return new Scheduler(await connect({ spawnOnDemand }));
  }

  close() {
    this.c.close();
  }

  hello() {
    return this.c.call('hello');
  }

  agents() {
    return this.c.call('agents');
  }

  status(agent) {
    return this.c.call('status', { agent });
  }

  health() {
    return this.c.call('health');
  }

  receipts(limit = 20) {
    return this.c.call('receipts', { limit });
  }

  sessions(agent) {
    return this.c.call('sessions', { agent });
  }

  use(agent, sessionId) {
    return this.c.call('use', { agent, sessionId });
  }

  create(agent) {
    return this.c.call('new', { agent });
  }

  rename(agent, label, sessionId) {
    return this.c.call('rename', { agent, label, sessionId });
  }

  models(agent, sessionId) {
    return this.c.call('models', { agent, sessionId });
  }

  setModel(agent, value, configId = 'model', sessionId) {
    return this.c.call('setModel', { agent, value, configId, sessionId });
  }

  tail(agent, jobId) {
    return this.c.call('tail', { agent, jobId });
  }

  cancel(agent) {
    return this.c.call('cancel', { agent });
  }

  /**
   * Start a run and stream progress to `onProgress`.
   * Resolves with the finished run payload `{ text, metrics, sessionId, ... }`.
   */
  async run(agent, prompt, { onProgress, timeoutMs = 300_000 } = {}) {
    // `subscribe: true` makes the daemon register this socket before the run can
    // finish, and waitFor() also looks at already-delivered events.
    const started = await this.c.call('run', {
      agent,
      prompt,
      timeoutMs,
      async: true,
      subscribe: true,
    });

    const offProgress = this.c.on('progress', (ev) => {
      if (ev.jobId === started.jobId) onProgress?.(ev);
    });

    try {
      const ev = await this.c.waitFor('job.done', (e) => e.jobId === started.jobId, timeoutMs + 60_000);
      if (ev.error) throw new Error(ev.error);
      return { ...ev.result, jobId: started.jobId };
    } finally {
      offProgress();
      await this.c.call('unsubscribe', { jobId: started.jobId }).catch(() => {});
    }
  }
}

/** Stop every running agentd. The next `Scheduler.open()` starts a fresh one. */
export async function stopDaemon() {
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*agentd.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
      ],
      { stdio: 'ignore', timeout: 20_000 },
    );
  } catch {
    /* nothing running */
  }
  await new Promise((r) => setTimeout(r, 800));
}

/** Shared assertion helpers so failures are readable. */
export function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) process.exitCode = 1;
  return ok;
}
