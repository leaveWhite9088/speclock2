// Small Markdown renderer that builds DOM nodes (never innerHTML), so agent text cannot inject markup.
// Covers what chat replies use: headings, paragraphs, lists, quotes, fenced code, tables, rules,
// and inline code / bold / italic / strikethrough / links.

const h = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

const SAFE_URL = /^(https?:|mailto:)/i;

function inline(parent, text) {
  // Order matters: code first so its content is left alone.
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|(?<![A-Za-z0-9])_([^_\s][^_]*?)_(?![A-Za-z0-9])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>)]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    if (m[2] != null) {
      const c = h('code');
      c.textContent = m[2].trim();
      parent.append(c);
    } else if (m[3] != null || m[4] != null) {
      const s = h('strong');
      inline(s, m[3] ?? m[4]);
      parent.append(s);
    } else if (m[5] != null) {
      const s = h('del');
      inline(s, m[5]);
      parent.append(s);
    } else if (m[6] != null || m[7] != null) {
      const s = h('em');
      inline(s, m[6] ?? m[7]);
      parent.append(s);
    } else {
      const url = m[9] ?? m[10];
      if (SAFE_URL.test(url)) {
        const a = h('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        if (m[8] != null) inline(a, m[8]);
        else a.textContent = url;
        parent.append(a);
      } else parent.append(m[0]);
    }
    last = re.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
}

const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l ?? '') && (l ?? '').includes('-');
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function renderMarkdown(src) {
  const root = h('div', 'md');
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) buf.push(lines[i++]);
      i++; // closing fence (or end of text while streaming)
      const pre = h('pre');
      const code = h('code');
      if (fence[2]) pre.dataset.lang = fence[2];
      code.textContent = buf.join('\n');
      pre.append(code);
      root.append(pre);
      continue;
    }
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) {
      const e = h(`h${Math.min(hd[1].length + 2, 6)}`);
      inline(e, hd[2].replace(/\s+#+\s*$/, ''));
      root.append(e);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      root.append(h('hr'));
      i++;
      continue;
    }
    if (line.trimStart().startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].trimStart().startsWith('>')) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const q = h('blockquote');
      q.append(renderMarkdown(buf.join('\n')));
      root.append(q);
      continue;
    }
    if (line.includes('|') && isTableSep(lines[i + 1])) {
      const t = h('table');
      const head = h('tr');
      for (const c of cells(line)) {
        const th = h('th');
        inline(th, c);
        head.append(th);
      }
      const thead = h('thead');
      thead.append(head);
      const tbody = h('tbody');
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        const tr = h('tr');
        for (const c of cells(lines[i++])) {
          const td = h('td');
          inline(td, c);
          tr.append(td);
        }
        tbody.append(tr);
      }
      t.append(thead, tbody);
      const wrap = h('div', 'tbl');
      wrap.append(t);
      root.append(wrap);
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      const ordered = /\d/.test(b[2]);
      const list = h(ordered ? 'ol' : 'ul');
      const base = b[1].length;
      while (i < lines.length) {
        const bm = BULLET.exec(lines[i]);
        if (!bm || bm[1].length < base || (bm[1].length === base && /\d/.test(bm[2]) !== ordered)) break;
        if (bm[1].length > base) break;
        const li = h('li');
        const body = [bm[3]];
        i++;
        // Continuation lines and nested items belong to this item.
        while (i < lines.length && lines[i].trim() && (BULLET.exec(lines[i])?.[1].length ?? 0) > base) body.push(lines[i++].slice(Math.min(base + 2, lines[i - 1].search(/\S/))));
        while (i < lines.length && lines[i].trim() && !BULLET.test(lines[i]) && /^\s+\S/.test(lines[i])) body.push(lines[i++].trim());
        const sub = body.slice(1).join('\n');
        inline(li, body[0]);
        if (sub) li.append(renderMarkdown(sub));
        list.append(li);
      }
      root.append(list);
      continue;
    }
    // paragraph: runs until a blank line or the start of another block
    const buf = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~|#{1,6}\s|>|([-*_])(\s*\2){2,}\s*$)/.test(lines[i]) &&
      !BULLET.test(lines[i]) &&
      !(lines[i].includes('|') && isTableSep(lines[i + 1]))
    ) {
      buf.push(lines[i++]);
    }
    const p = h('p');
    buf.forEach((l, k) => {
      if (k) p.append(h('br'));
      inline(p, l.trim());
    });
    root.append(p);
  }
  return root;
}
