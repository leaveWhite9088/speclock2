#!/usr/bin/env node
/**
 * agentd — the scheduler daemon.
 *
 * Holds the single AgentPool (one resident ACP process per agent) so that agent
 * lifetime stops being tied to a pi session. Any number of front ends (the pi
 * extension, ad-hoc scripts) connect over one local endpoint and
 * share the same connections, session registry and job registry.
 *
 * Transport: Windows named pipe (default `\\.\pipe\pi-agentd`), or TCP
 * `127.0.0.1:AGENTD_PORT` when AGENTD_PORT is set. Both are local-only.
 *
 * Protocol: newline-delimited JSON.
 *   client -> daemon  {"id":"1","op":"run","args":{...}}
 *   daemon -> client  {"id":"1","ok":true,"result":{...}}
 *                     {"id":"1","ok":false,"error":"..."}
 *   daemon -> client  {"event":"progress","jobId":"...","chars":12,...}
 *                     {"event":"done","jobId":"...","result":{...}}
 *
 * Lifecycle: started on demand by the client; exits after AGENTD_IDLE_MIN
 * minutes with no connections and no running jobs.
 *
 * This file only puts the parts together:
 *   startup.mjs      what to do about the old daemon's unfinished tasks
 *   dispatchers.mjs  executors' events, one dispatcher per project, handoff proposals
 *   ops/             the operations a client can call, by area
 *   server.mjs       the socket
 *   lifecycle.mjs    idle recycling, idle exit, shutdown
 */

import { join } from 'node:path';
import { BASE_CWD, CONFIG, pool, seedContexts } from '../core/agent-pool.mjs';
import { DATA_DIR } from '../core/data-dir.mjs';
import * as projects from '../core/projects.mjs';
import { dispatchers } from './dispatchers.mjs';
import { allocEvent, publish } from './events.mjs';
import { scopeArgs } from './guard.mjs';
import { startLifecycle } from './lifecycle.mjs';
import { buildOps } from './ops/index.mjs';
import { readReceipts } from './receipts.mjs';
import { startServer } from './server.mjs';
import { recordInterruptedJobs } from './startup.mjs';

const PIPE_NAME = process.env.AGENTD_PIPE || '\\\\.\\pipe\\pi-agentd';
const PORT = process.env.AGENTD_PORT ? Number(process.env.AGENTD_PORT) : null;
const ENDPOINT_FILE = join(DATA_DIR, 'agentd.endpoint.json');
const IDLE_MS = Number(process.env.AGENTD_IDLE_MIN || 30) * 60_000;
const PROTOCOL = 3;
/** Project instances and dispatchers idle for this long are stopped. */
const IDLE_INSTANCE_MS = Number(process.env.AGENTD_INSTANCE_IDLE_MIN || CONFIG?.limits?.idleMinutes || 15) * 60_000;

const log = (...a) => process.stderr.write(`[agentd] ${a.join(' ')}\n`);
const startedAt = new Date().toISOString();

// Tasks the last daemon never finished: record them now, announce them once the socket is up.
const lostJobs = recordInterruptedJobs();

const OPS = buildOps({ protocol: PROTOCOL, startedAt, idleInstanceMs: IDLE_INSTANCE_MS });

const { stats } = startServer({
  ops: OPS,
  scopeArgs,
  pipe: PIPE_NAME,
  port: PORT,
  endpointFile: ENDPOINT_FILE,
  info: { protocol: PROTOCOL, startedAt, baseCwd: BASE_CWD },
  onListening: (endpoint) => {
    seedContexts(readReceipts(500)); // the newest figure of a session wins
    for (const j of lostJobs) publish(allocEvent('job.interrupted', { ...j }));
    if (lostJobs.length) log(`interrupted by the last shutdown: ${lostJobs.map((j) => `${j.agent}/${j.jobId}`).join(', ')}`);
    log(`listening on ${endpoint} (pid ${process.pid})`);
    log(`base cwd: ${BASE_CWD}; instances: ${[...pool.keys()].join(', ')}`);
  },
  log,
});

startLifecycle({ endpointFile: ENDPOINT_FILE, pool, dispatchers, sweepIdle: projects.sweepIdle, stats, idleMs: IDLE_MS, idleInstanceMs: IDLE_INSTANCE_MS, log });
