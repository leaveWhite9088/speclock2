/**
 * The dispatcher's conversations as files. pi writes one `.jsonl` per conversation into a directory; agentd adds a
 * `labels.json` next to them (pi has no rename of its own). This is everything about those files: list them, name
 * them, delete them, read how long each turn took. It does not start or talk to pi, so it works on a directory alone.
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** First user message of a pi session file, as a title. Reads only the head of the file. */
export function firstUserText(file) {
  try {
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const m = o?.message;
      if (m?.role !== 'user') continue;
      const t = typeof m.content === 'string' ? m.content : (m.content ?? []).map((c) => c.text ?? '').join(' ');
      if (t.trim()) return t.trim().replace(/\s+/g, ' ').slice(0, 60);
    }
  } catch {
    /* no title */
  }
  return null;
}

export class SessionStore {
  constructor(dir) {
    this.dir = dir;
  }

  /** Is `file` inside the directory? (case-insensitive and slash-insensitive, as paths are on Windows) */
  contains(file) {
    const norm = (p) => String(p).replace(/\\/g, '/').toLowerCase();
    return typeof file === 'string' && norm(file).startsWith(norm(this.dir).replace(/\/+$/, '') + '/');
  }

  labels() {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'labels.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  _saveLabels(labels) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, 'labels.json'), JSON.stringify(labels, null, 2));
  }

  /** The conversation files, newest first. `activeFile` is the one in use now. */
  list(activeFile = null) {
    const labels = this.labels();
    const rows = [];
    const walk = (dir) => {
      let entries = [];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl')) {
          let header = null;
          try {
            header = JSON.parse(readFileSync(p, 'utf8').split('\n', 1)[0]);
          } catch {
            /* a file without a readable header is still listed */
          }
          rows.push({
            file: p,
            title: firstUserText(p),
            label: labels[basename(p)] ?? null,
            sessionId: header?.id ?? null,
            cwd: header?.cwd ?? null,
            updatedAt: statSync(p).mtime.toISOString(),
            size: statSync(p).size,
            active: Boolean(activeFile) && resolve(p) === resolve(activeFile),
          });
        }
      }
    };
    walk(this.dir);
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { sessions: rows };
  }

  /**
   * Name a conversation; an empty label removes the name. `mustExist: false` for a conversation pi has not written to
   * disk yet (it does so with the first message).
   */
  rename(file, label, { mustExist = true } = {}) {
    const p = resolve(String(file ?? ''));
    if ((mustExist && !existsSync(p)) || !p.endsWith('.jsonl') || !p.startsWith(resolve(this.dir))) throw new Error('unknown session');
    const labels = this.labels();
    const text = String(label ?? '').trim().slice(0, 120);
    if (text) labels[basename(p)] = text;
    else delete labels[basename(p)];
    this._saveLabels(labels);
    return { file: p, label: text || null };
  }

  /** Delete a conversation and its name. The one in use (`activeFile`) cannot be deleted. */
  remove(file, activeFile = null) {
    const p = resolve(String(file ?? ''));
    if (!existsSync(p) || !p.endsWith('.jsonl') || !p.startsWith(resolve(this.dir))) throw new Error('unknown session');
    if (activeFile && resolve(activeFile) === p) throw new Error('cannot delete the active session; switch to another first');
    unlinkSync(p);
    const labels = this.labels();
    if (basename(p) in labels) {
      delete labels[basename(p)];
      this._saveLabels(labels);
    }
    return { file: p, deleted: true };
  }

  /**
   * How long each turn of a conversation took, read from its file: pi's own message times are when a message started,
   * the file's record times are when it was finished. A turn runs from a user message to the last record before the
   * next. `running`: the last turn is still going and has no end yet.
   * @returns {{ at: number, tookMs: number }[]} `at` is the user message's own timestamp, which is how a view finds its turn
   */
  turns(file, { running = false } = {}) {
    try {
      if (!file) return [];
      const turns = [];
      let cur = null;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type !== 'message' || !rec.message) continue;
        const end = Date.parse(rec.timestamp);
        if (rec.message.role === 'user') {
          cur = { at: rec.message.timestamp, tookMs: 0, start: end };
          turns.push(cur);
        } else if (cur && Number.isFinite(end)) cur.tookMs = end - cur.start;
      }
      if (running) turns.pop();
      return turns.filter((t) => t.tookMs > 0).map(({ at, tookMs }) => ({ at, tookMs }));
    } catch {
      return [];
    }
  }
}
