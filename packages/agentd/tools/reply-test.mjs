/**
 * A long executor reply does not fill the dispatcher's conversation.
 *
 * Checks:
 *   1. a reply within the limit is returned unchanged, with no file
 *   2. a longer one keeps its start and its end, says how much was left out, and is saved whole
 *   3. what the dispatcher gets is bounded, however long the reply is
 *   4. the folder of saved replies does not grow without limit
 *   5. an unwritable folder still trims (the context matters more than the copy)
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'agentd-reply-'));
process.env.AGENTD_RESULTS_DIR = join(dir, 'results');
const { fitReply } = await import('../core/reply.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== reply size ===\n');

const short = 'x'.repeat(5000);
const a = fitReply('job-a', short, 6000);
check('a short reply passes through', a.text === short && a.file === null && a.omitted === 0);

const long = `START-${'m'.repeat(40_000)}-END`;
const b = fitReply('job-b', long, 6000);
check('a long reply keeps its start', b.text.startsWith('START-'));
check('and its end', b.text.endsWith('-END'));
check('it says how much was left out', b.text.includes(`${b.omitted} characters omitted`) && b.omitted > 30_000, String(b.omitted));
check('the full text is saved', b.file && readFileSync(b.file, 'utf8') === long);
check('and the path is in the message', b.text.includes(b.file));

const huge = fitReply('job-c', 'z'.repeat(5_000_000), 6000);
check('the result is bounded however long the reply is', huge.text.length < 6000 + 500, `${huge.text.length} chars from 5,000,000`);

for (let i = 0; i < 205; i++) fitReply(`many-${i}`, 'q'.repeat(7000), 6000);
check('saved replies are pruned', readdirSync(process.env.AGENTD_RESULTS_DIR).length <= 200, `${readdirSync(process.env.AGENTD_RESULTS_DIR).length} files`);
check('the newest ones are kept', existsSync(join(process.env.AGENTD_RESULTS_DIR, 'many-204.md')));

// a file where the folder should be: writing fails, the reply is still cut
const blocked = join(dir, 'blocked');
writeFileSync(blocked, 'not a folder');
process.env.AGENTD_RESULTS_DIR = join(blocked, 'results');
const { fitReply: fresh } = await import('../core/reply.mjs?second');
const d = fresh('job-d', long, 6000);
check('an unwritable folder still trims', d.file === null && d.text.length < 7000 && d.text.endsWith('-END'));

console.log(process.exitCode ? '\n=> ✗ REPLY SIZE BROKEN' : '\n=> ✓ REPLY SIZE OK');
process.exit(process.exitCode ?? 0);
