/**
 * The daemon's agents seen from the outside: what each executor tells the front ends (progress, compaction, forced stop,
 * exit), one dispatcher per project (started on first use), and the handoffs they propose. The shared state of the
 * operations that touch more than one of these lives here, so the operations do not need to know about each other.
 */

import { join } from 'node:path';
import { BASE_CWD, CONFIG, getAgent, pool } from '../core/agent-pool.mjs';
import { DATA_DIR } from '../core/data-dir.mjs';
import { Dispatcher } from '../core/dispatcher.mjs';
import { createHandoffs } from '../core/handoff.mjs';
import * as projects from '../core/projects.mjs';
import { allocEvent, publish, publishEphemeral, publishLive } from './events.mjs';

const log = (...a) => process.stderr.write(`[agentd] ${a.join(' ')}\n`);

// ---------------------------------------------------------------------------
// Progress sink: every agent forwards its stream updates to subscribers.
// ---------------------------------------------------------------------------

export function wireAgent(agent) {
  agent.setProgressSink((jobId, p) => publishEphemeral(jobId, p));
  // A prompt that waited behind another really starts now.
  agent.onRunStart = ({ jobId }) => publish(allocEvent('job.running', { jobId, agent: agent.name }));
  agent.onCompact = (info) => {
    publish(allocEvent('agent.compacted', info));
    suggestHandoff(agent, `这个会话已经压缩了 ${info.compactions} 次`, `压缩 ${info.compactions} 次；最近一次压缩前约 ${info.before?.used} token${info.after?.used != null ? `，压缩后约 ${info.after.used}` : ''}`, info.compactions >= COMPACTIONS_BEFORE_HANDOFF);
  };
  // Killed for ignoring a cancel: the person should know, and may need to recover it.
  agent.onForcedStop = (info) => publish(allocEvent('agent.forced-stop', { ...info }));
  // An unexpected exit is a health event even when no run is in flight.
  agent.onExit = (info) => {
    publish(allocEvent('agent.exit', { ...info }));
  };
}
for (const agent of pool.values()) wireAgent(agent);

// ---------------------------------------------------------------------------
// Dispatcher: the pi that picks the agent. Started on first use.
// ---------------------------------------------------------------------------

/** One dispatcher per project, plus the global one under the key ''. */
export const dispatchers = new Map();

export function getDispatcher(project = null) {
  const key = project || '';
  let d = dispatchers.get(key);
  if (d) return d;
  if (project) {
    d = new Dispatcher({
      cwd: projects.projectRoot(project),
      project,
      sessionDir: join(DATA_DIR, 'dispatcher-sessions', project),
      onEvent: (ev) => publishLive('dispatcher.event', { project, data: ev }),
      compactAt: projects.dispatcherCompactAt(project),
    });
    // Like an executor's: a compaction is announced, and a conversation compacted again and again is proposed for a handoff.
    d.onCompact = (info) => {
      publish(allocEvent('agent.compacted', { ...info, agent: DISPATCHER_ID }));
      if (info.compactions >= COMPACTIONS_BEFORE_HANDOFF) {
        try {
          handoffs.propose({
            project,
            agent: DISPATCHER_ID,
            reason: `这个会话已经压缩了 ${info.compactions} 次`,
            // right after a compaction pi may not know the new size yet: then only the size before is said
            evidence: `压缩 ${info.compactions} 次；最近一次压缩前约 ${info.before?.used} token${info.after?.used != null ? `，压缩后约 ${info.after.used}` : ''}`,
          });
        } catch (err) {
          log('handoff proposal skipped:', err.message);
        }
      }
    };
  } else {
    d = new Dispatcher({
      cwd: process.env.AGENTD_CWD_DISPATCHER || CONFIG?.dispatcher?.cwd || BASE_CWD,
      onEvent: (ev) => publishLive('dispatcher.event', { project: null, data: ev }),
    });
  }
  dispatchers.set(key, d);
  return d;
}

export const anyDispatcherBusy = () => [...dispatchers.values()].some((d) => d.busy);

/** Dispatchers that are running now get a restart after models.json changed. */
export async function restartRunningDispatchers() {
  const out = [];
  for (const [key, d] of dispatchers) {
    if (!d.child) continue;
    out.push({ project: key || null, ...(await d.restart()) });
  }
  return out;
}

/** In a handoff, the project's dispatcher is addressed as `<project>~@dispatcher`, next to its executors. */
export const DISPATCHER_ID = '@dispatcher';

export const handoffs = createHandoffs({
  getAgent: (key) => {
    const tail = `${projects.SEP}${DISPATCHER_ID}`;
    if (key.endsWith(tail)) return getDispatcher(key.slice(0, -tail.length)).asHandoffTarget();
    return getAgent(key);
  },
  keyOf: (project, id) => `${project}${projects.SEP}${id}`,
  onChange: (p) => publishLive('handoff.changed', { project: p.project, data: p }),
});

/**
 * Objective drift signals. Crossing one only raises a proposal; a person still has to confirm it. Context size alone
 * is never a signal: compaction deals with that.
 */
const COMPACTIONS_BEFORE_HANDOFF = 3;
const FAILURES_BEFORE_HANDOFF = 3;
const failStreak = new Map();
export function suggestHandoff(agent, reason, evidence, when = true) {
  if (!when || !agent.project) return;
  try {
    handoffs.propose({ project: agent.project, agent: agent.shortId, reason, evidence });
  } catch (err) {
    log('handoff proposal skipped:', err.message);
  }
}

/**
 * A run ended. A string of failures in a row (cancelled runs do not count) proposes a handoff: the conversation may be
 * what is wrong. The proposal only raises a flag; a person still has to confirm it.
 */
export function noteRunOutcome(agent, failed, message) {
  const streak = failed ? (failStreak.get(agent.name) ?? 0) + 1 : 0;
  failStreak.set(agent.name, streak);
  suggestHandoff(agent, `连续 ${streak} 次任务失败`, `最近 ${streak} 次运行都失败了：${message ?? ''}`, streak >= FAILURES_BEFORE_HANDOFF);
}
