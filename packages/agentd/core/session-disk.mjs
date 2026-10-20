/**
 * Read a CLI's saved sessions straight from disk, so a picker does not have to start the CLI.
 *
 * ACP has no "list sessions" call that works without a running agent, and starting one takes
 * 5-13 s. dsh keeps one folder per working directory under ~/.dsh/sessions, so it can be read
 * directly. This relies on a private format: every function returns null when anything looks
 * unfamiliar, and the caller falls back to asking the CLI.
 *
 *   ~/.dsh/sessions/<encoded cwd>/<session id>/session.v3.jsonl.zstd
 *
 * The file is many zstd frames; the first one holds the header line
 * {"type":"session","id","createdAt","cwd"}, the first user message is in one of the next few.
 * mcode keeps its sessions in a database plus dated folders without a reliable cwd, so it is not read here.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const BS = String.fromCharCode(92);
const norm = (p) => resolve(String(p ?? '')).split(BS).join('/').replace(/[/]+$/, '').toLowerCase();

/** "D:\a\研究" -> "--D-a-~7814~7A76--" (path separators and ":" become "-", non-ASCII becomes ~UTF16HEX). */
export function dshFolderName(cwd) {
  const flat = resolve(cwd).split(BS).join('/').replace(/[/:]+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  let out = '';
  for (const ch of flat) {
    if (ch.charCodeAt(0) < 128) out += ch;
    else for (let i = 0; i < ch.length; i++) out += `~${ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return `--${out}--`;
}

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function frames(buf, limit) {
  const at = [];
  for (let i = 0; i <= Math.min(buf.length, limit) - 4; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) at.push(i);
  }
  return at;
}

function readDsh(file) {
  const buf = readFileSync(file);
  const starts = frames(buf, 256 * 1024);
  if (!starts.length) return null;
  let header = null;
  let title = null;
  for (let k = 0; k < Math.min(starts.length, 12) && (!header || !title); k++) {
    let text;
    try {
      text = zstdDecompressSync(buf.subarray(starts[k], starts[k + 1] ?? buf.length)).toString('utf8');
    } catch {
      continue;
    }
    for (const line of text.split(String.fromCharCode(10))) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'session' && !header) header = ev;
      if (!title && ev.type === 'agent/inbox/spliced') {
        const m = ev.data?.inserted?.find((x) => x.role === 'user');
        const t = m?.content?.find((c) => c.type === 'text')?.text;
        if (t) title = t.split(/[ \t\r\n]+/).join(' ').trim().slice(0, 60);
      }
    }
  }
  return header?.id ? { header, title } : null;
}

/** Sessions dsh saved for exactly this directory, newest first. null = cannot tell, ask the CLI. */
export function dshSessions(cwd, { home = process.env.DSH_HOME || join(homedir(), '.dsh') } = {}) {
  try {
    const root = join(home, 'sessions');
    if (!existsSync(root)) return null;
    const dir = join(root, dshFolderName(cwd));
    if (!existsSync(dir)) return { sessions: [] };
    const out = [];
    for (const id of readdirSync(dir)) {
      const file = join(dir, id, 'session.v3.jsonl.zstd');
      if (!existsSync(file)) continue;
      const got = readDsh(file);
      if (!got) return null;
      // The folder name is lossy; the header says which directory the session really belongs to.
      if (got.header.cwd && norm(got.header.cwd) !== norm(cwd)) continue;
      out.push({
        sessionId: got.header.id,
        cwd: got.header.cwd ?? cwd,
        title: got.title,
        updatedAt: new Date(statSync(file).mtimeMs).toISOString(),
        source: 'agent',
      });
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions: out };
  } catch {
    return null;
  }
}
