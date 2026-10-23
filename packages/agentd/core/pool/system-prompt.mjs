/**
 * Handing rules to an agent without writing anything into the user's project.
 *
 * The rules (what an executor may and may not do, how to report) used to be an AGENTS.md / CLAUDE.md dropped into the
 * project. The project has its own, and a file that already exists was never overwritten, so our rules silently did
 * not apply there. Each CLI is now given them through whatever it offers for extra system instructions. The text
 * lives in agentd's own data directory.
 *
 *   mcode      --append-system-prompt-file <file>              (a flag of `mcode acp`)
 *   pi         --append-system-prompt <file>                   (the adapter adds it to pi's command line)
 *   claude     session/new _meta.systemPrompt.append           (appended to Claude Code's own prompt)
 *   codex      session/new _meta.jetbrains.air.customInstructions   (becomes the thread's developer instructions)
 *   opencode   OPENCODE_CONFIG_CONTENT = {"instructions":[file]}
 *   others     no channel: the text goes in front of the first prompt of each session (`prefix`)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, log } from './config.mjs';

const RULES_DIR = join(DATA_DIR, 'rules');
const safe = (s) => String(s).replace(/[^A-Za-z0-9._~-]/g, '_');

/** @returns {{ args: string[], env: Record<string,string>, meta: object | null, prefix: boolean, file: string | null }} */
export function injectionFor(type, text, name) {
  const none = { args: [], env: {}, meta: null, prefix: false, file: null };
  if (!text?.trim()) return none;

  let file = join(RULES_DIR, `${safe(name)}.md`);
  try {
    mkdirSync(RULES_DIR, { recursive: true });
    writeFileSync(file, text, 'utf8');
  } catch (err) {
    log(`[${name}] could not write the rules file:`, err.message);
    file = null;
  }

  switch (type) {
    case 'mcode':
      return file ? { ...none, args: ['--append-system-prompt-file', file], file } : { ...none, prefix: true };
    case 'pi':
      return file ? { ...none, env: { AGENTD_APPEND_SYSTEM_PROMPT_FILE: file }, file } : { ...none, prefix: true };
    case 'claude':
      return { ...none, meta: { systemPrompt: { append: text } }, file };
    case 'codex':
      return { ...none, meta: { jetbrains: { air: { customInstructions: text } } }, file };
    case 'opencode': {
      if (!file) return { ...none, prefix: true };
      // keep a configuration the user already passes this way
      let base = {};
      try {
        base = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
      } catch {
        /* not JSON: replaced */
      }
      const instructions = [...(Array.isArray(base.instructions) ? base.instructions : []), file];
      return { ...none, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...base, instructions }) }, file };
    }
    default:
      return { ...none, prefix: true, file };
  }
}
