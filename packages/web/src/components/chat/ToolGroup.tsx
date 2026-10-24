import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { oneLine, took } from '@/lib/format';
import type { Item } from '@/lib/types';
import { cn } from '@/lib/utils';

type Tool = Extract<Item, { kind: 'tool' }>;

/**
 * A run of consecutive tool calls, collapsed to one line ("3 次工具调用  bash  read").
 * Open it for the list; open a line for its full text.
 */
export function ToolGroup({ tools }: { tools: Tool[] }) {
  const calls = tools.filter((t) => !t.result);
  const names = [...new Set(calls.map((t) => t.name))];
  const running = calls.filter((t) => t.state === 'run').length;
  const failed = calls.filter((t) => t.state === 'fail').length;
  const since = Math.min(...calls.filter((t) => t.state === 'run' && t.startedAt != null).map((t) => t.startedAt as number));
  const now = useNow(Number.isFinite(since));
  return (
    <details className="group -my-1 min-w-0 text-[12.5px] text-muted">
      <summary className="flex w-full min-w-0 cursor-pointer list-none items-center gap-1.5 py-0.5 whitespace-nowrap hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        <span className="shrink-0">{calls.length || 1} 次工具调用</span>
        {running ? <span className="shrink-0 text-accent">{running} 进行中{Number.isFinite(since) ? ` · 已 ${took(Math.max(0, now - since))}` : ''}</span> : null}
        {failed ? <span className="shrink-0 text-danger">{failed} 失败</span> : null}
        <span className="min-w-0 truncate font-mono text-[11.5px] opacity-80">{names.slice(0, 4).join('  ') + (names.length > 4 ? ' …' : '')}</span>
      </summary>
      <ul className="m-0 mt-0.5 ml-1 min-w-0 list-none border-l border-line-2 p-0 pl-2.5">
        {tools.map((t) => (
          <ToolLine key={t.id} tool={t} />
        ))}
      </ul>
    </details>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function ToolLine({ tool }: { tool: Tool }) {
  const running = tool.state === 'run' && tool.startedAt != null;
  const now = useNow(running);
  // Facts only: how long it has been open, or how long it took.
  const clock =
    running ? `已运行 ${took(Math.max(0, now - (tool.startedAt as number)))}` : tool.startedAt != null && tool.endedAt != null ? took(Math.max(0, tool.endedAt - tool.startedAt)) : '';
  const arg = tool.state === 'run' ? clock || '进行中…' : tool.state === 'fail' ? `失败${clock ? ` · ${clock}` : ''}` : tool.state === 'done' ? clock : oneLine(tool.result ? tool.detail : tool.detail.replace(/[{}"]/g, ''), 100);
  // The name can be a whole command: it gives way, the time stays visible at the right.
  const head = (
    <>
      <b className={cn('min-w-0 truncate font-mono text-xs font-semibold text-ink-2', tool.result && 'font-medium text-muted', tool.state === 'fail' && 'text-danger')}>
        {tool.result ? `↳ ${tool.name}` : tool.name}
      </b>
      <span className={cn('truncate font-mono text-[11.5px]', tool.state === 'run' ? 'shrink-0 text-accent' : tool.state ? 'shrink-0' : 'min-w-0', tool.state === 'fail' && 'text-danger')}>{arg}</span>
    </>
  );
  // A line that came from a transcript has no text of its own (only a status), so there is nothing to open.
  if (!tool.detail) return <li className={cn('flex min-w-0 items-baseline gap-2 py-px pl-3.5', tool.result && 'pl-7')}>{head}</li>;
  return (
    <li className={cn('min-w-0 py-px', tool.result && 'pl-3.5')}>
      <details className="group/line min-w-0">
        <summary className="flex min-w-0 cursor-pointer list-none items-baseline gap-2 py-px hover:text-ink [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-2.5 shrink-0 translate-y-px group-open/line:rotate-90" />
          {head}
        </summary>
        <pre className="mt-0.5 mr-0 mb-1.5 ml-4 max-h-64 overflow-auto rounded-md bg-code px-3 py-2 font-mono text-xs leading-[1.55] wrap-anywhere whitespace-pre-wrap text-ink-2">{tool.detail}</pre>
      </details>
    </li>
  );
}
