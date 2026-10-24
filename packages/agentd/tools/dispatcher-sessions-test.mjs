/**
 * The dispatcher's conversation files, on their own: a temporary directory, no pi.
 *
 * Checks:
 *   1. the list: newest first, with title, name, id, size, and which one is in use; subfolders are searched
 *   2. naming: a name is kept next to the files, an empty one removes it, a file that is not there or is outside the
 *      folder is refused (unless it simply has not been written yet)
 *   3. deleting: the one in use is refused, a stranger is refused, the name goes with the file
 *   4. paths: inside/outside is decided the way Windows paths work (slashes, case)
 *   5. turn times: from a user message to the last record before the next; the running turn is left out
 */

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../core/dispatcher/sessions.mjs';
import { check } from './lib/scheduler.mjs';

console.log('\n=== dispatcher conversation files ===\n');

const dir = mkdtempSync(join(tmpdir(), 'agentd-dsess-'));
const store = new SessionStore(dir);
const line = (o) => JSON.stringify(o);
const write = (name, recs, mtime) => {
  const p = join(dir, name);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, recs.map(line).join('\n') + '\n');
  utimesSync(p, mtime, mtime);
  return p;
};
const user = (text, ts) => ({ type: 'message', timestamp: new Date(ts).toISOString(), message: { role: 'user', content: text, timestamp: ts } });
const reply = (ts) => ({ type: 'message', timestamp: new Date(ts).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: ts } });

const t0 = Date.parse('2026-01-01T10:00:00Z');
const older = write('2026-a.jsonl', [{ type: 'session', id: 'A', cwd: 'x' }, user('first   question\nabout things', t0), reply(t0 + 5000)], new Date(t0 + 1000));
const newer = write('sub/2026-b.jsonl', [{ type: 'session', id: 'B', cwd: 'y' }, user('second', t0), reply(t0 + 1000)], new Date(t0 + 60_000));
writeFileSync(join(dir, 'broken.jsonl'), 'not json\n');
utimesSync(join(dir, 'broken.jsonl'), new Date(t0 - 5000), new Date(t0 - 5000));

// 1
const rows = store.list(newer).sessions;
check('files in subfolders are found, newest first', rows.length === 3 && rows[0].file === newer && rows[1].file === older, rows.map((r) => r.file.split(/[\\/]/).pop()).join());
check('with the title from the first user message', rows[1].title === 'first question about things', String(rows[1].title));
check('and the id from the header', rows[0].sessionId === 'B' && rows[1].sessionId === 'A');
check('the one in use is marked, and only that one', rows.filter((r) => r.active).length === 1 && rows[0].active);
check('a file with no readable header is still listed', rows[2].file.endsWith('broken.jsonl') && rows[2].sessionId === null);

// 2
check('a name is saved and shows in the list', store.rename(older, '  My talk ').label === 'My talk' && store.list().sessions.find((r) => r.file === older).label === 'My talk');
check('an empty name removes it', store.rename(older, '').label === null && store.list().sessions.find((r) => r.file === older).label === null);
const fails = (fn, name) => {
  try {
    fn();
    check(name, false, 'did not fail');
  } catch (e) {
    check(name, /unknown session/.test(e.message), e.message);
  }
};
fails(() => store.rename(join(dir, 'nope.jsonl'), 'x'), 'naming a file that is not there is refused');
fails(() => store.rename(join(tmpdir(), 'elsewhere.jsonl'), 'x', { mustExist: false }), 'naming a file outside the folder is refused');
fails(() => store.rename(join(dir, 'x.txt'), 'x', { mustExist: false }), 'naming something that is not a conversation is refused');
check('a conversation not yet written can be named', store.rename(join(dir, 'later.jsonl'), 'Soon', { mustExist: false }).label === 'Soon');

// 3
store.rename(newer, 'Named');
try {
  store.remove(newer, newer);
  check('the one in use cannot be deleted', false, 'did not fail');
} catch (e) {
  check('the one in use cannot be deleted', /active session/.test(e.message), e.message);
}
fails(() => store.remove(join(tmpdir(), 'other.jsonl')), 'deleting a file that is not ours is refused');
const gone = store.remove(newer, older);
check('another can be deleted, and its name goes with it', gone.deleted && !existsSync(newer) && !('2026-b.jsonl' in store.labels()), JSON.stringify(store.labels()));

// 4
check('inside the folder, with either kind of slash and any case', store.contains(join(dir, 'a.jsonl')) && store.contains(join(dir, 'a.jsonl').replace(/\\/g, '/').toUpperCase()));
check('outside the folder, or not a path, is not inside', !store.contains(join(tmpdir(), 'a.jsonl')) && !store.contains(null) && !store.contains(dir));

// 5
const turnsFile = write('turns.jsonl', [
  { type: 'session', id: 'T' },
  user('one', t0), reply(t0 + 2000), reply(t0 + 9000),
  user('two', t0 + 20_000), reply(t0 + 21_500),
  user('three', t0 + 40_000),
], new Date());
const turns = store.turns(turnsFile);
check('a turn lasts from its question to its last record', turns[0].tookMs === 9000 && turns[1].tookMs === 1500, JSON.stringify(turns));
check('a turn with no answer yet has no duration, so it is left out', turns.length === 2);
const twoDone = write('two-done.jsonl', [{ type: 'session', id: 'U' }, user('one', t0), reply(t0 + 2000), user('two', t0 + 20_000), reply(t0 + 21_500)], new Date());
check('the turn that is still running is left out, finished ones stay', store.turns(twoDone).length === 2 && store.turns(twoDone, { running: true }).length === 1);
check('a turn is found by its own message time', turns[0].at === t0 && turns[1].at === t0 + 20_000);
check('no file, or an unreadable one, gives nothing', store.turns(null).length === 0 && store.turns(join(dir, 'missing.jsonl')).length === 0);

console.log(process.exitCode ? '\n=> ✗ CONVERSATION FILES BROKEN' : '\n=> ✓ CONVERSATION FILES OK');
process.exit(process.exitCode ?? 0);
