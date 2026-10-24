/**
 * The dispatcher's extension, the parts that do not need pi: they are plain modules, loaded by Node directly.
 *
 * Checks:
 *   1. failure text: where it came from, the task tag, and that the user decides what happens next
 *   2. metrics text for people, durations, option lists
 *   3. the roster of executors, with a warning for one that is unstable or was cut off, and the prompt around it
 *   4. a project's dispatcher: every call carries its project (the model cannot name another one); the daemon
 *      handle is untouched when there is no project
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ext = (f) => pathToFileURL(join(ROOT, 'extension', 'router', f)).href;
process.env.AGENTD_PROJECT = 'demo';
const { check } = await import('./lib/scheduler.mjs');
const { failureMessage, taskTag } = await import(ext('failure.ts'));
const { attentionLines, flatten, fullMetrics, metricsLine, parseDuration } = await import(ext('format.ts'));
const { rosterLines } = await import(ext('roster.ts'));
const { scoped, PROJECT } = await import(ext('daemon.ts'));
const { rosterPrompt } = await import('../core/rules.mjs');

console.log('\n=== dispatcher extension (pure parts) ===\n');

// 1
const tag = taskTag({ taskId: 't1', attempt: 2, maxAttempts: 3, jobId: 'j9' });
check('the tag names the task, the attempt and the job', tag === '[task t1, attempt 2 of 3, job j9]', tag);
const cli = failureMessage('quota exceeded', 'cli', tag);
check("a failure the CLI reported says so, and passes its message on", /executor's own CLI reported this error/.test(cli) && cli.includes('quota exceeded'));
const own = failureMessage('timed out', 'agentd', tag);
check("a failure agentd reports says it is not the CLI's", /agentd reports this \(it is not an error message from the CLI\)/.test(own));
check('with no source there is no claim about it', !/reported this|reports this/.test(failureMessage('x', undefined, tag)));
check('every failure carries the tag and leaves the decision to the user', [cli, own].every((t) => t.includes(tag) && /Tell the user and wait for their decision\. Do not retry or reassign this on your own\./.test(t)));

// 2
check('a duration of seconds, minutes and hours', parseDuration('30s') === 30_000 && parseDuration('5m') === 300_000 && parseDuration('2h') === 7_200_000, [parseDuration('30s'), parseDuration('5m'), parseDuration('2h')].join());
const m = { modelName: 'glm', durationMs: 12_345, timeToFirstTokenMs: 800, tokens: { output: 50 }, tokensPerSecond: 12, chars: 200, context: { percent: 7 }, cost: { amount: 0.5 } };
check('the one-line summary has model, time, tokens and context', metricsLine(m) === 'glm · 12.3s · ttft 0.8s · out 50 tok · 12 tok/s · 200 chars · ctx 7% · $0.5000', metricsLine(m));
check('and an empty one for nothing', metricsLine(null) === '' && fullMetrics(null) === '' && attentionLines(null) === '');
check('health lines are marked by how bad they are', attentionLines({ attention: [{ severity: 'error', code: 'a', text: 'x' }, { severity: 'warn', code: 'b', text: 'y' }] }) === '  ✗ [a] x\n  ! [b] y');
check('the full text says when the agent does not report tokens', /not exposed by this agent over ACP/.test(fullMetrics({ durationMs: 1, chars: 0, chunks: 0 })));
check('option groups are flattened', flatten([{ value: 'a' }, { options: [{ value: 'b' }, { value: 'c' }] }]).map((o) => o.value).join() === 'a,b,c');

// 3
const rows = rosterLines([
  { id: 'web', type: 'opencode', busy: true, cwd: 'D:/p/web', role: 'frontend' },
  { id: 'api', type: 'dsh', alive: true, cwd: null },
  { id: 'old', type: 'pi', unstable: true },
  { id: 'cut', type: 'pi', interrupted: { startedAt: '10:00', prompt: 'build the thing' } },
]).split('\n');
check('each executor has its state, directory and role', rows[0] === '- web [opencode] busy, dir D:/p/web, role: frontend' && rows[1] === '- api [dsh] running, dir (base)', rows.slice(0, 2).join(' | '));
check('an unstable one is marked, and not to be sent work', rows.some((r) => /UNSTABLE/.test(r) && /Do not send it work/.test(r)));
check('one that was cut off says what it was doing', rows.some((r) => /INTERRUPTED: its last task \(10:00, "build the thing"\)/.test(r)));
const prompt = rosterPrompt(rows.join('\n'));
check('the prompt around the roster comes from contexts/roster.md', prompt.startsWith('## Executors of this project') && prompt.includes('- web [opencode] busy') && /You are the dispatcher/.test(prompt) && !prompt.includes('{{roster}}'));
check('and tells it not to retry on its own', /do not retry or give it to another executor on your own/.test(prompt));

// 4
const calls = [];
const fake = { call: (op, args, opts) => (calls.push({ op, args, opts }), 'ok'), close: () => 'closed', other: 7 };
const c = scoped(fake);
check('the project comes from the environment', PROJECT === 'demo');
c.call('run', { agent: 'x', project: 'other', caller: 'person' }, { timeoutMs: 5 });
check('a call carries the project, short names and the dispatcher as caller — whatever the model passed', calls[0].args.project === 'demo' && calls[0].args.short === true && calls[0].args.caller === 'dispatcher' && calls[0].args.agent === 'x' && calls[0].opts.timeoutMs === 5, JSON.stringify(calls[0].args));
check('other methods and values still work', c.close() === 'closed' && c.other === 7);
const child = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(ext('daemon.ts'))}).then((m)=>{const o={call:()=>1};console.log(m.PROJECT===null && m.scoped(o)===o)})`], { env: { ...process.env, AGENTD_PROJECT: '' }, encoding: 'utf8' });
check('with no project the handle is left as it is', child.stdout.trim() === 'true', (child.stdout + child.stderr).trim().slice(0, 120));

console.log(process.exitCode ? '\n=> ✗ EXTENSION PARTS BROKEN' : '\n=> ✓ EXTENSION PARTS OK');
process.exit(process.exitCode ?? 0);
