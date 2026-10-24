/**
 * Two small parts of an executor's client, on their own: how often its process was killed (health), and how its rules
 * reach its CLI (rules channel). No process.
 *
 * Checks:
 *   1. health: kills inside the window count; old ones fall out; enough of them mark it unstable; recovering clears them
 *   2. rules: the text can be a function (an edited template applies at once), and is written to a rules file
 *   3. rules: each CLI gets them through its own channel (flag, environment, session `_meta`), a CLI with none gets them
 *      in front of the first prompt of each session, once, and again after being told to forget the session
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AGENTD_DATA_DIR = mkdtempSync(join(tmpdir(), 'agentd-small-'));
const { StopHealth } = await import('../core/pool/acp/health.mjs');
const { RulesChannel } = await import('../core/pool/acp/rules-channel.mjs');
const { check } = await import('./lib/scheduler.mjs');

console.log('\n=== executor client: health and rules channel ===\n');

// 1
const h = new StopHealth({ limit: 3, windowMs: 1000 });
check('a fresh one is stable and has no kills', !h.unstable && h.count === 0);
const t0 = Date.now();
h.note(t0);
h.note(t0 + 100);
check('two kills inside the window are not enough', h.count === 2 && !h.unstable);
h.note(t0 + 200);
check('three are: it is unstable', h.count === 3 && h.unstable);
h.recover();
check('recovering clears them', h.count === 0 && !h.unstable);
h.note(t0);
h.note(t0 + 100);
h.note(t0 + 5000); // the first two are older than the window by now
check('kills older than the window no longer count', h.count === 1, String(h.count));
check('the window is told in minutes for messages', new StopHealth({ windowMs: 30 * 60_000 }).windowMinutes === 30);

// 2
let text = 'RULE ONE';
const make = (type, name, systemPrompt = () => text) => new RulesChannel({ type, name, spec: { systemPrompt } });
const pi = make('pi', 'rc-pi');
check('the rules text comes from a function when it is one', pi.text === 'RULE ONE');
const inj1 = pi.injection();
check('and is written to a rules file in the data directory', inj1.file && inj1.file.startsWith(process.env.AGENTD_DATA_DIR) && readFileSync(inj1.file, 'utf8') === 'RULE ONE');
text = 'RULE TWO';
check('an edit applies at once, and the file is written again', pi.text === 'RULE TWO' && readFileSync(pi.injection().file, 'utf8') === 'RULE TWO');
check('with no rules there is no channel and nothing to say', make('pi', 'rc-none', null).text === null && make('pi', 'rc-none2', null).via() === null);

// 3
text = 'THE RULES';
check('pi: an environment variable names the file', Object.keys(make('pi', 'rc-a').injection().env).join() === 'AGENTD_APPEND_SYSTEM_PROMPT_FILE');
check('mcode: a command line flag with the file', make('mcode', 'rc-b').injection().args[0] === '--append-system-prompt-file');
check('opencode: its config in the environment', Object.keys(make('opencode', 'rc-c').injection().env).join() === 'OPENCODE_CONFIG_CONTENT');
const claude = make('claude', 'rc-d');
check('claude: the session request carries them, appended to its own prompt', claude.meta()._meta?.systemPrompt?.append === 'THE RULES');
check('codex: the session request carries them as instructions', make('codex', 'rc-e').meta()._meta?.jetbrains?.air?.customInstructions === 'THE RULES');
check('pi and mcode take nothing in the session request', Object.keys(make('pi', 'rc-f').meta()).length === 0);
check('where they go is said in words', make('pi', 'rc-g').via() === 'AGENTD_APPEND_SYSTEM_PROMPT_FILE' && make('mcode', 'rc-h').via() === '--append-system-prompt-file' && claude.via() === '_meta.systemPrompt');

const dsh = make('dsh', 'rc-dsh');
check('a CLI with no channel is marked as getting them in the first message', dsh.via() === 'first message');
const first = dsh.withRules('do the thing', 'S1');
check('its first prompt of a session has the rules in front', first === 'THE RULES\n\n---\n\ndo the thing');
check('the second one does not', dsh.withRules('and more', 'S1') === 'and more');
check('another session starts with them again', dsh.withRules('hi', 'S2').startsWith('THE RULES'));
dsh.primed.delete('S1');
check('after the session is forgotten (a compaction) they are sent again', dsh.withRules('again', 'S1').startsWith('THE RULES'));
check('with no session yet nothing is added', dsh.withRules('x', null) === 'x');
check('a CLI that has a channel never gets them in front of a prompt', make('pi', 'rc-i').withRules('plain', 'S1') === 'plain');

console.log(process.exitCode ? '\n=> ✗ SMALL PARTS BROKEN' : '\n=> ✓ SMALL PARTS OK');
process.exit(process.exitCode ?? 0);
