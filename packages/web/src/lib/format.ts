import type { Member, ModelCatalog } from './types';

/**
 * Directories are shown and typed relative to the project root: "./server", "./" for the root.
 * An absolute path inside the root becomes its relative form; anything else is left for the backend to refuse.
 */
export function relDir(value: string | null | undefined, root?: string): string {
  const fwd = (x: string) => x.trim().split(String.fromCharCode(92)).join('/');
  const r = fwd(root ?? '').replace(/\/+$/, '');
  let d = fwd(value ?? '');
  if (r && d.toLowerCase() === r.toLowerCase()) d = '.';
  else if (r && d.toLowerCase().startsWith(r.toLowerCase() + '/')) d = d.slice(r.length + 1);
  while (d.startsWith('./')) d = d.slice(2);
  d = d.replace(/\/+$/, '');
  if (d === '' || d === '.') return './';
  return d.startsWith('..') || /^([a-z]:|\/)/i.test(d) ? d : './' + d;
}

export function when(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The time of a message: the clock today ("10:26:59"), the date and the clock for an earlier day ("10/21 10:26"). */
export function clock(ms: number | null | undefined): string {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${hm}:${pad(d.getSeconds())}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** A duration for people: "0.8 秒", "12 秒", "2 分 5 秒". */
export function took(ms: number): string {
  const s = ms / 1000;
  if (s < 1) return `${s.toFixed(1)} 秒`;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} 秒`;
  const m = Math.floor(s / 60);
  return `${m} 分 ${Math.round(s - m * 60)} 秒`;
}

export const oneLine = (t: string, n: number) => {
  const x = t.split(/\s+/).join(' ').trim();
  return x.length > n ? `${x.slice(0, n)}…` : x;
};

/**
 * A model value of the form "provider/id" gets its provider in front: the same model name can come from two
 * platforms. Names that already carry a platform ("Anthropic/Claude Opus") are left alone.
 */
export function modelLabel(value: string, name?: string | null): string {
  const label = name || value;
  const slash = value.indexOf('/');
  if (slash <= 0 || label.includes('/')) return label;
  return `${value.slice(0, slash)} · ${label}`;
}

export function modelName(catalog: ModelCatalog | undefined, value: string | null | undefined): string | null {
  if (!value) return null;
  const found = catalog?.models.find((m) => m.value === value);
  return found ? modelLabel(found.value, found.name) : (value.split(':')[2] ?? value);
}

/** The model an executor will use: its own choice, else the preferred one, else the CLI default. */
export function memberLlm(m: Member, catalog?: ModelCatalog) {
  const value = m.model ?? m.preferModel ?? catalog?.default ?? null;
  return { text: modelName(catalog, value), faint: !m.model };
}
