/**
 * Editor for pi's `models.json`: the way to add an LLM to the dispatcher pi.
 *
 * pi reads custom providers and models from `<agent-dir>/models.json`
 * (see pi docs, "Configure a compatible endpoint"). This module changes that file
 * on an explicit command only. It never runs on the prompt path.
 *
 * Rules:
 *   - `apiKey` may be a literal value or an environment reference such as `$NAME`.
 *     A value that starts with `!` is rejected, because pi would run it as a shell
 *     command at request time.
 *   - Writes are atomic (temp file, then rename). The previous file is kept as
 *     `models.json.bak`.
 *   - Listing never returns a literal key.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
}

const PROVIDER_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DEFAULT_API = 'openai-completions';

function fileIn(dir) {
  return join(dir, 'models.json');
}

function load(dir) {
  const file = fileIn(dir);
  if (!existsSync(file)) return { providers: {} };
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object') return { providers: {} };
  parsed.providers ??= {};
  return parsed;
}

function save(dir, data) {
  mkdirSync(dir, { recursive: true });
  const file = fileIn(dir);
  if (existsSync(file)) copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

function checkKey(apiKey) {
  if (apiKey == null) return;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('apiKey must be a non-empty string');
  if (apiKey.trimStart().startsWith('!')) {
    throw new Error('apiKey must not start with "!": pi would run it as a shell command');
  }
}

function checkModel(m) {
  if (!m || typeof m.id !== 'string' || !m.id.trim()) throw new Error('each model needs a non-empty "id"');
  const out = { id: m.id.trim() };
  if (m.name != null) out.name = String(m.name);
  if (m.reasoning != null) out.reasoning = Boolean(m.reasoning);
  if (m.contextWindow != null) out.contextWindow = Number(m.contextWindow);
  if (m.maxTokens != null) out.maxTokens = Number(m.maxTokens);
  if (Array.isArray(m.input)) out.input = m.input.map(String);
  for (const k of ['contextWindow', 'maxTokens']) {
    if (k in out && !(Number.isFinite(out[k]) && out[k] > 0)) throw new Error(`${k} must be a positive number`);
  }
  return out;
}

/**
 * Add a provider, or add/replace models on an existing one.
 * Fields that are not supplied keep their current value.
 */
export function addProvider(spec, dir = agentDir()) {
  const provider = String(spec?.provider ?? '');
  if (!PROVIDER_RE.test(provider)) {
    throw new Error('provider must be lower case letters, digits, ".", "_" or "-" (max 64 chars)');
  }

  const data = load(dir);
  const existing = data.providers[provider] ?? null;

  const baseUrl = spec.baseUrl ?? existing?.baseUrl;
  if (!baseUrl) throw new Error('baseUrl is required for a new provider');
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (!/^https?:$/.test(url.protocol)) throw new Error('baseUrl must use http or https');

  checkKey(spec.apiKey);
  if (!existing && spec.apiKey == null) throw new Error('apiKey is required for a new provider');

  const incoming = (spec.models ?? []).map(checkModel);
  if (!existing && incoming.length === 0) throw new Error('a new provider needs at least one model');

  const next = { ...(existing ?? {}) };
  next.baseUrl = baseUrl;
  next.api = spec.api ?? existing?.api ?? DEFAULT_API;
  if (spec.apiKey != null) next.apiKey = spec.apiKey;

  const byId = new Map((existing?.models ?? []).map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m });
  next.models = [...byId.values()];

  data.providers[provider] = next;
  save(dir, data);
  return { provider, created: !existing, models: next.models.map((m) => m.id), file: fileIn(dir) };
}

/** Remove a provider, or only some of its models when `modelIds` is given. */
export function removeProvider(provider, modelIds = null, dir = agentDir()) {
  const data = load(dir);
  const p = data.providers[provider];
  if (!p) throw new Error(`provider "${provider}" is not in models.json`);

  if (Array.isArray(modelIds) && modelIds.length) {
    const drop = new Set(modelIds);
    p.models = (p.models ?? []).filter((m) => !drop.has(m.id));
    if (p.models.length === 0) delete data.providers[provider];
  } else {
    delete data.providers[provider];
  }
  save(dir, data);
  return { provider, remaining: data.providers[provider]?.models?.map((m) => m.id) ?? [] };
}

/** Providers in models.json with secrets masked. */
export function listProviders(dir = agentDir()) {
  const data = load(dir);
  const providers = Object.entries(data.providers).map(([name, p]) => ({
    provider: name,
    baseUrl: p.baseUrl ?? null,
    api: p.api ?? null,
    apiKey: p.apiKey == null ? null : /^\$/.test(p.apiKey) ? p.apiKey : '(literal key set)',
    models: (p.models ?? []).map((m) => ({ id: m.id, name: m.name ?? null, reasoning: m.reasoning ?? null })),
  }));
  return { file: fileIn(dir), providers };
}
