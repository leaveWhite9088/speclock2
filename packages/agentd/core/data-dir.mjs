/**
 * Where agentd keeps its data (projects, receipts, transcripts, journal, rules files…). `AGENTD_DATA_DIR` moves all of it
 * somewhere else, which is how a second, private daemon (for tests) runs next to the one a person is using without
 * touching its files. It has no dependencies, so every part can import it.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/agentd */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DATA_DIR = process.env.AGENTD_DATA_DIR ? resolve(process.env.AGENTD_DATA_DIR) : join(ROOT, 'data');
