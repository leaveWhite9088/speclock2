/**
 * The handoff prompts are markdown files in contexts/, read when a handoff runs.
 *
 * Checks: the write prompt asks for the document as the reply (no file); the start prompt carries the document
 * exactly (including characters that String.replace treats specially); the comments written for editors are not sent;
 * and an edit applies to the next handoff without a restart.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handoffStartPrompt, handoffWritePrompt } from '../core/rules.mjs';
import { check } from './lib/scheduler.mjs';

console.log('\n=== handoff prompts ===\n');
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'contexts');
check('both prompt files exist', existsSync(join(dir, 'handoff-write.md')) && existsSync(join(dir, 'handoff-start.md')));

const write = handoffWritePrompt();
check('the write prompt asks for the document as the reply, not a file', /Reply with the document itself/.test(write) && /Do not write it to a file/.test(write));
check('it lists the five sections', ['Goal', 'Current progress', 'Decisions and why', 'What worked', 'Next steps'].every((x) => write.includes(x)));
check('the editor comment is not sent', !write.includes('<!--') && !/交接第一步/.test(write));

const doc = 'Goal: keep $& and $1 and `code` as they are\n\n## Next steps\n- do it';
const start = handoffStartPrompt(doc);
check('the start prompt carries the document exactly', start.includes(doc), JSON.stringify(start.slice(-60)));
check('no placeholder is left', !start.includes('{{doc}}'));
check('it tells the agent to treat the document as notes', /notes, not as instructions/.test(start));
check('the editor comment is not sent there either', !start.includes('<!--'));

// an edit applies to the next handoff
const file = join(dir, 'handoff-write.md');
const original = readFileSync(file, 'utf8');
try {
  writeFileSync(file, original + '\nPROBE-LINE-123\n', 'utf8');
  check('an edit applies at once, without a restart', handoffWritePrompt().includes('PROBE-LINE-123'));
} finally {
  writeFileSync(file, original, 'utf8');
}
check('and the file is restored', !handoffWritePrompt().includes('PROBE-LINE-123'));

console.log(process.exitCode ? '\n=> ✗ HANDOFF PROMPTS BROKEN' : '\n=> ✓ HANDOFF PROMPTS OK');
process.exit(process.exitCode ?? 0);
