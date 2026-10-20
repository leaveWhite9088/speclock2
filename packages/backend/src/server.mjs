/**
 * Backend: a thin HTTP + SSE gateway in front of agentd.
 *
 * It holds no state and makes no decisions. Every route maps to one agentd
 * operation, so anything the dashboard shows can also be reached with the same
 * client the tests use.
 *
 * Safety: the API can run agents and edit pi's models.json, so it binds to
 * 127.0.0.1 only and refuses requests whose Host or Origin is not local.
 *
 * Env: BACKEND_PORT (default 8787), BACKEND_HOST (default 127.0.0.1)
 */

import http from 'node:http';
import { call, onLive } from './daemon.mjs';

const PORT = Number(process.env.BACKEND_PORT) || 8787;
const HOST = process.env.BACKEND_HOST || '127.0.0.1';
const MAX_BODY = 1_000_000;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  let text;
  try {
    // fatal: bytes that are not UTF-8 (for example a GBK terminal) must not turn into U+FFFD and be stored
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, 'body must be UTF-8 text');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'body must be JSON');
  }
}

/** Reject non-local Host (DNS rebinding) and cross-site writes (CSRF). */
function guard(req) {
  if (!LOCAL_HOST.test(req.headers.host ?? '')) throw new HttpError(403, 'host not allowed');
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
    let o;
    try {
      o = new URL(origin);
    } catch {
      throw new HttpError(403, 'bad origin');
    }
    if (!LOCAL_HOST.test(o.host)) throw new HttpError(403, 'origin not allowed');
  }
}

// -- routes ---------------------------------------------------------------
// Each handler gets ({ params, query, body }) and returns the JSON to send.

const num = (v) => (v == null || v === '' ? undefined : Number(v));

const routes = [
  ['GET', '/api/health', () => call('health')],
  ['GET', '/api/agents', () => call('agents')],
  ['GET', '/api/instances', () => call('instances')],
  ['POST', '/api/instances', ({ body }) => call('instance.create', body)],
  ['DELETE', '/api/instances/:id', ({ params }) => call('instance.remove', { id: params.id })],

  ['GET', '/api/agents/:id/status', ({ params }) => call('status', { agent: params.id })],
  ['GET', '/api/agents/:id/sessions', ({ params }) => call('sessions', { agent: params.id })],
  ['POST', '/api/agents/:id/sessions', ({ params, body }) => call('new', { agent: params.id, cwd: body.cwd })],
  [
    'GET',
    '/api/agents/:id/sessions/:sid/transcript',
    ({ params, query }) =>
      call('transcript', {
        agent: params.id,
        sessionId: params.sid,
        afterSeq: num(query.afterSeq),
        limit: num(query.limit),
        tail: query.tail === '1',
      }),
  ],
  ['POST', '/api/agents/:id/run', ({ params, body }) => startRun(params.id, body)],
  ['POST', '/api/agents/:id/cancel', ({ params }) => call('cancel', { agent: params.id })],

  // Projects. `?project=<id>` on the dispatcher routes picks that project's dispatcher;
  // without it they address the global one.
  ['GET', '/api/projects', () => call('projects')],
  ['POST', '/api/projects', ({ body }) => call('project.create', body)],
  ['DELETE', '/api/projects/:id', ({ params, query }) => call('project.remove', { project: params.id, force: query.force === '1' })],
  ['POST', '/api/projects/:id/stop', ({ params, body }) => call('project.stop', { project: params.id, force: body.force === true })],
  ['GET', '/api/models', ({ query }) => call('project.models', { type: query.type, refresh: query.refresh === '1' })],
  [
    'GET',
    '/api/projects/:id/sessions',
    ({ params, query }) => call('project.sessions', { project: params.id, type: query.type, dir: query.dir || '.' }),
  ],
  ['POST', '/api/projects/:id/instances', ({ params, body }) => call('project.addInstance', { ...body, project: params.id })],
  [
    'PATCH',
    '/api/projects/:id/instances/:iid',
    ({ params, body }) => call('project.updateInstance', { project: params.id, id: params.iid, role: body.role, model: body.model, name: body.name, dir: body.dir }),
  ],
  ['POST', '/api/agents/:id/start', ({ params }) => call('start', { agent: params.id })],
  ['POST', '/api/agents/:id/use', ({ params, body }) => call('use', { agent: params.id, sessionId: body.sessionId })],
  [
    'DELETE',
    '/api/projects/:id/instances/:iid',
    ({ params, query }) => call('project.removeInstance', { project: params.id, id: params.iid, force: query.force === '1' }),
  ],

  ['GET', '/api/dispatcher', ({ query }) => call('dispatcher.state', { project: query.project })],
  ['GET', '/api/dispatcher/models', ({ query }) => call('dispatcher.models', { project: query.project })],
  ['POST', '/api/dispatcher/model', ({ query, body }) => call('dispatcher.setModel', { project: query.project, value: body.value })],
  ['POST', '/api/dispatcher/thinking', ({ query, body }) => call('dispatcher.setThinking', { project: query.project, level: body.level })],
  ['POST', '/api/dispatcher/prompt', ({ query, body }) => call('dispatcher.prompt', { project: query.project, message: body.message })],
  ['POST', '/api/dispatcher/abort', ({ query }) => call('dispatcher.abort', { project: query.project })],
  ['POST', '/api/dispatcher/rename', ({ query, body }) => call('dispatcher.renameSession', { project: query.project, sessionFile: body.sessionFile, label: body.label })],
  ['POST', '/api/agents/:id/rename', ({ params, body }) => call('rename', { agent: params.id, sessionId: body.sessionId, label: body.label })],
  ['POST', '/api/dispatcher/use', ({ query, body }) => call('dispatcher.use', { project: query.project, sessionFile: body.sessionFile })],
  ['POST', '/api/dispatcher/new', ({ query }) => call('dispatcher.new', { project: query.project })],
  ['GET', '/api/dispatcher/messages', ({ query }) => call('dispatcher.messages', { project: query.project })],
  ['GET', '/api/dispatcher/sessions', ({ query }) => call('dispatcher.sessions', { project: query.project })],
  ['GET', '/api/dispatcher/llms', () => call('dispatcher.customModels')],
  ['POST', '/api/dispatcher/llms', ({ body }) => call('dispatcher.addModel', body)],
  [
    'DELETE',
    '/api/dispatcher/llms/:provider',
    ({ params, query }) =>
      call('dispatcher.removeModel', {
        provider: params.provider,
        modelIds: query.models ? String(query.models).split(',') : null,
      }),
  ],
];

/** Start a run and return at once; progress and the result arrive on /api/events. */
async function startRun(agent, body) {
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new HttpError(400, 'prompt is required');
  return call('run', { agent, prompt: body.prompt, sessionId: body.sessionId, async: true, subscribe: true });
}

const compiled = routes.map(([method, pattern, handler]) => {
  const names = [];
  const re = new RegExp(
    '^' +
      pattern.replace(/:([a-z]+)/g, (_, n) => {
        names.push(n);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, re, names, handler };
});

function match(method, path) {
  for (const r of compiled) {
    if (r.method !== method) continue;
    const m = r.re.exec(path);
    if (m) return { r, params: Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

// -- live events (SSE) ----------------------------------------------------

const sseClients = new Set();

onLive((name, payload) => {
  if (!sseClients.size) return;
  const frame = `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) res.write(frame);
});

async function events(req, res) {
  await call('hello'); // makes sure agentd is up and the live subscription exists
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });
  res.write('retry: 2000\n\n');
  sseClients.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

// -- server ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    guard(req);
    const url = new URL(req.url, 'http://local');
    if (req.method === 'GET' && url.pathname === '/api/events') return await events(req, res);

    const hit = match(req.method, url.pathname);
    if (!hit) throw new HttpError(404, `no route for ${req.method} ${url.pathname}`);
    const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' ? await readBody(req) : {};
    const result = await hit.r.handler({ params: hit.params, query: Object.fromEntries(url.searchParams), body });
    json(res, 200, result ?? {});
  } catch (err) {
    if (res.headersSent) return res.end();
    const status = err.status ?? (/agentd|connect/.test(err.message) ? 502 : 400);
    json(res, status, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  process.stderr.write(`[backend] http://${HOST}:${PORT}  (agentd is started on first request)\n`);
});
