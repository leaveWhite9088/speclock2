/** Constants, the CLI registry and `agentd.config.json`. Nothing here talks to a process. */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../data-dir.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** packages/agentd */
const ROOT = join(HERE, '..', '..');

export { DATA_DIR };

export const NODE_BIN = process.env.MCODE_NODE_BIN || 'D:/Environment/nodejs/node.exe';
const NODE_MODULES = 'D:/Environment/nodejs/node_modules';

/** Base working directory for every agent session. */
export const BASE_CWD = process.env.AGENTD_BASE_CWD || 'D:/Project2/code-261013-speclock2/speclock2';

export const LABELS_FILE = process.env.AGENTD_LABELS_FILE || join(DATA_DIR, 'session-labels.json');

/** One log file per run, so output can be tailed externally while it streams. */
export const RUNS_DIR = process.env.AGENTD_RUNS_DIR || join(DATA_DIR, 'runs');

/** Registry: add an entry to support another ACP-capable CLI. */
/** The `env` block of the user's Claude Code settings, as plain strings. Never logged. */
function claudeSettingsEnv() {
  try {
    const file = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
    const env = JSON.parse(readFileSync(file, 'utf8'))?.env ?? {};
    return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)]));
  } catch {
    return {};
  }
}

export const AGENTS = {
  mcode: {
    label: 'MiniMax Code',
    cmd: NODE_BIN,
    args: [`${NODE_MODULES}/@minimax-ai/code/cli.js`, 'acp'],
    description: 'MiniMax Code agent. Slower to start, strong at multi-step coding.',
    defaultCwd: process.env.AGENTD_CWD_MCODE || null,
  },
  dsh: {
    label: 'DeepSeek Harness',
    cmd: NODE_BIN,
    args: [`${NODE_MODULES}/@deepseek-ai/dsh/lib/bin.js`, '--profile', 'acp'],
    description: 'DeepSeek Harness agent. Fast startup and short answers.',
    defaultCwd: process.env.AGENTD_CWD_DSH || null,
  },
  opencode: {
    label: 'OpenCode',
    cmd: `${NODE_MODULES}/opencode-ai/bin/opencode.exe`,
    args: ['acp'],
    description: 'OpenCode. Speaks ACP natively; many providers.',
    defaultCwd: process.env.AGENTD_CWD_OPENCODE || null,
  },
  claude: {
    label: 'Claude Code',
    cmd: NODE_BIN,
    args: [`${NODE_MODULES}/@agentclientprotocol/claude-agent-acp/dist/index.js`],
    // Use the installed Claude Code, and the `env` block of the user's own ~/.claude/settings.json (endpoint, model, token):
    // the adapter does not read that block itself, so without it the CLI reports "not logged in".
    env: { CLAUDE_CODE_EXECUTABLE: `${NODE_MODULES}/@anthropic-ai/claude-code/bin/claude.exe` },
    // Read again at every process start, so a profile switched with cc-switch applies the next time the executor starts.
    envFn: claudeSettingsEnv,
    description: 'Claude Code through the ACP adapter. Uses the endpoint and login configured in ~/.claude/settings.json.',
    defaultCwd: process.env.AGENTD_CWD_CLAUDE || null,
  },
  codex: {
    label: 'Codex',
    cmd: NODE_BIN,
    args: [`${NODE_MODULES}/@agentclientprotocol/codex-acp/dist/index.js`],
    description: 'OpenAI Codex through the ACP adapter. Uses the ChatGPT login of the Codex app.',
    defaultCwd: process.env.AGENTD_CWD_CODEX || null,
  },
  pi: {
    label: 'independent process',
    cmd: NODE_BIN,
    args: [join(ROOT, 'server', 'pi-acp-adapter.mjs')],
    description:
      'A separate pi instance, exposed through an ACP adapter over pi RPC mode. ' +
      'Runs with --no-mcp so it cannot call back into this server.',
    defaultCwd: process.env.AGENTD_CWD_PI || null,
  },
};

/** A prompt is cancelled when the agent is silent this long (tool calls in progress do not count as silence). */
export const IDLE_RUN_MS = 300_000;
/** Hard ceiling for one prompt, however active the agent is. */
export const MAX_RUN_MS = Number(process.env.AGENTD_MAX_RUN_MS) || 2 * 60 * 60_000;
/** How long a cancelled prompt gets to wrap up before it is abandoned. */
export const CANCEL_GRACE_MS = Number(process.env.AGENTD_CANCEL_GRACE_MS) || 15_000;

export const log = (...a) => process.stderr.write(`[agent-pool] ${a.join(' ')}\n`);

export const DEFAULT_AGENT = process.env.AGENTD_DEFAULT_AGENT || 'mcode';

/**
 * Optional per-agent startup configuration: `agentd.config.json` next to this
 * lab, or AGENTD_CONFIG to point elsewhere.
 *
 *   { "agents": { "mcode": { "cwd": "D:/work/project-a" },
 *                 "dsh":   { "cwd": "D:/work/project-b" } } }
 *
 * Precedence: explicit cwd on the request > AGENTD_CWD_<AGENT> env > this file >
 * the agent's built-in default > BASE_CWD.
 */
const CONFIG_FILE =
  process.env.AGENTD_CONFIG || join(ROOT, 'agentd.config.json');

/** Parsed `agentd.config.json`; the dispatcher reads its own section from it. */
export let CONFIG = {};

(function applyConfig() {
  let cfg = {};
  try {
    if (existsSync(CONFIG_FILE)) cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) ?? {};
  } catch (err) {
    log('agentd.config.json unreadable, ignoring:', err.message);
  }
  CONFIG = cfg;
  for (const [name, spec] of Object.entries(AGENTS)) {
    spec.type = name;
    const fromEnv = process.env[`AGENTD_CWD_${name.toUpperCase()}`];
    const fromFile = cfg?.agents?.[name]?.cwd;
    spec.defaultCwd = fromEnv || fromFile || spec.defaultCwd || null;
    if (spec.defaultCwd) {
      // A configured workspace that does not exist yet would fail session/new.
      try {
        mkdirSync(spec.defaultCwd, { recursive: true });
      } catch (err) {
        log(`could not create cwd for ${name}:`, err.message);
      }
    }
  }
})();

/**
 * An executor whose process had to be killed this many times within the window is marked unstable and gets no
 * more work until a person recovers it. `limits.forcedStopLimit` / `limits.forcedStopWindowMin` in agentd.config.json.
 */
export const FORCED_STOP_LIMIT = Number(CONFIG?.limits?.forcedStopLimit) || 3;
export const FORCED_STOP_WINDOW_MS = (Number(CONFIG?.limits?.forcedStopWindowMin) || 30) * 60_000;

/** Compare directories regardless of slash style, case and trailing slash. */
export function normPath(p) {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function flattenOptions(opts = []) {
  return opts.flatMap((o) =>
    Array.isArray(o.options) ? flattenOptions(o.options) : [{ value: o.value, name: o.name, description: o.description }],
  );
}
