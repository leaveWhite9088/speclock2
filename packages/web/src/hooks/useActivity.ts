import { useEffect, useState } from 'react';
import { useProjectsQuery } from '@/hooks/queries';
import { useUi } from '@/store';

const secs = (n: number) => (n < 60 ? `${n} 秒` : `${Math.floor(n / 60)} 分 ${n % 60} 秒`);

/** What a running executor is doing, ticking once a second so the elapsed time and the quiet time move. */
export function useActivity(key: string | undefined) {
  const stored = useUi((s) => (key ? s.activity[key] : undefined));
  // A page opened while the task runs has seen no progress event yet: the executor's row says what it is doing.
  const { data } = useProjectsQuery();
  const row = key ? data?.projects.flatMap((p) => p.instances).find((i) => i.key === key)?.activity : null;
  const a = stored ?? (row ? { startedAt: row.startedAt, lastAt: Date.now(), tool: row.tool, toolCalls: row.toolCalls, openTools: row.openTools, thinking: row.thinking ?? 0 } : undefined);
  const [, tick] = useState(0);
  const on = Boolean(a);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
  if (!a) return null;
  const now = Date.now();
  return { elapsed: Math.round((now - a.startedAt) / 1000), quiet: Math.round((now - a.lastAt) / 1000), tool: a.tool, toolCalls: a.toolCalls, openTools: a.openTools, thinking: a.thinking };
}

/**
 * One line: how long, what it is doing. A running tool explains a silent stretch (a build prints nothing for
 * minutes), so only silent thinking gets a warning.
 */
export function runLabel(l: NonNullable<ReturnType<typeof useActivity>>): { text: string; detail: string; quiet: boolean } {
  const toolOn = l.openTools > 0 && Boolean(l.tool);
  const doing = toolOn
    ? `正在 ${l.tool}${l.quiet >= 5 ? `（已 ${secs(l.quiet)}）` : ''}`
    : l.toolCalls > 0
      ? `已调用 ${l.toolCalls} 次工具，思考中`
      : l.thinking > 0
        ? `思考中（已写 ${l.thinking} 字推理）`
        : '思考中';
  const quiet = !toolOn && l.quiet >= 30;
  const detail = `${secs(l.elapsed)} · ${doing}${quiet ? ` · ${secs(l.quiet)}没有新动静，仍在运行` : ''}`;
  return { text: `进行中 · ${detail}`, detail, quiet };
}
