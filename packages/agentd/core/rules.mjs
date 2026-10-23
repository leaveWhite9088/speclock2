/**
 * The rules agentd gives to its agents: one text for the dispatcher of a project, one for each executor.
 *
 * They are handed over through each CLI's own system-prompt channel (see pool/system-prompt.mjs), never written
 * into the user's project. The sources are `contexts/project.md` (dispatcher) and `contexts/executor.md`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTEXTS = join(dirname(dirname(fileURLToPath(import.meta.url))), 'contexts');
const cache = new Map();

/** A template without its HTML comments (notes for whoever edits it, not for the agent). */
function load(name) {
  if (!cache.has(name)) {
    let text = '';
    try {
      text = readFileSync(join(CONTEXTS, name), 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
    } catch {
      /* no template: no rules */
    }
    cache.set(name, text);
  }
  return cache.get(name);
}

export const dispatcherRules = () => load('project.md');
export const executorRules = () => load('executor.md');
