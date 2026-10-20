/**
 * Agent pool: the scheduler core.
 *
 * Holds one resident ACP process per agent (mcode / dsh / pi / opencode / claude / codex), owns the session registry (labels, model choice,
 * live set) and the run/job bookkeeping used for streaming and metrics. The parts live in ./pool/:
 *
 *   config      constants, the CLI registry, agentd.config.json
 *   store       per-session sidecar data
 *   registry    the pool Map, process limit, start locks
 *   acp-client  one resident process: sessions, runs, JSON-RPC
 *   metrics     run numbers and inferred health
 *   compaction  context figures and automatic compaction
 *   instances   built-in and created instances
 *
 * This file only re-exports them, so every front end (daemon, extension, tests) keeps one import path.
 */

import { readTranscript } from './transcripts.mjs';

export { AGENTS, BASE_CWD, CONFIG, DEFAULT_AGENT, IDLE_RUN_MS, flattenOptions } from './pool/config.mjs';
export { seedContexts } from './pool/store.mjs';
export { MAX_PROCESSES, aliveCount, defaultModelFor, getAgent, pool } from './pool/registry.mjs';
export { canCompact } from './pool/compaction.mjs';
export { formatMetrics } from './pool/metrics.mjs';
export { buildInstance, createInstance, listInstances, removeInstance } from './pool/instances.mjs';
export { readTranscript };
