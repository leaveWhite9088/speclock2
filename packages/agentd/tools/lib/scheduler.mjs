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

/** What the running daemon is working on right now (executors and dispatchers); empty when none runs. */
async function busyWork() {
  try {
    const c = await connect({ spawnOnDemand: false });
    try {
      const { agents } = await c.call('agents');
      const { projects } = await c.call('projects');
      return [...agents.filter((a) => a.busy).map((a) => a.name), ...projects.filter((p) => p.dispatcher?.busy).map((p) => `${p.id} dispatcher`)];
    } finally {
      c.close();
    }
  } catch {
    return [];
  }
}

/**
 * Stop every running agentd. The next `Scheduler.open()` starts a fresh one.
 *
 * The daemon is shared with whoever uses the dashboard, so killing it while a task runs destroys that person's work.
 * Unless `force` is set (a test that kills it on purpose, or AGENTD_FORCE_STOP=1), this waits for it to go idle and
 * gives up with an error instead of killing it.
 */
export async function stopDaemon({ force = process.env.AGENTD_FORCE_STOP === '1' } = {}) {
  if (!force) {
    const until = Date.now() + (Number(process.env.AGENTD_STOP_WAIT_MS) || 180_000);
    let busy = await busyWork();
    if (busy.length) console.log(`  waiting for agentd to go idle (working on ${busy.join(', ')})…`);
    while (busy.length && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 5000));
      busy = await busyWork();
    }
    if (busy.length) throw new Error(`not stopping agentd: it is still working on ${busy.join(', ')}. Stop it yourself, or set AGENTD_FORCE_STOP=1.`);
  }
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
