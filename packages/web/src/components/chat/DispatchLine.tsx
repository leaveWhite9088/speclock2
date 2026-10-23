import { ChevronRight } from 'lucide-react';
import { useProject } from '@/hooks/queries';
import { runLabel, useActivity } from '@/hooks/useActivity';
import { useUi } from '@/store';
import { oneLine, took } from '@/lib/format';
import type { Item } from '@/lib/types';
import { cn } from '@/lib/utils';

type Dispatch = Extract<Item, { kind: 'dispatch' }>;

/**
 * One line for a task the dispatcher handed to an executor: who got it, what it was, how it went.
 * Open it for the full task and the executor's reply (or the reason it failed).
 */
export function DispatchLine({ item }: { item: Dispatch }) {
  const retry = (item.attempt ?? 1) > 1;
  const project = useUi((s) => s.project);
  const dispatcher = useProject()?.dispatcher;
  // A dispatch waits for its result only while the dispatcher is in a turn. If the dispatcher is idle and there is
  // still no result, the daemon stopped meanwhile and the result will never come.
  const lost = item.state === 'run' && dispatcher != null && !dispatcher.busy;
  const live = useActivity(item.state === 'run' && !lost ? `${project}~${item.agent}` : undefined);
  const status = live ? runLabel(live) : '进行中…';
  return (
    <details className="group -my-1 text-[12.5px] text-muted">
      <summary className="flex w-full min-w-0 cursor-pointer list-none items-center gap-1.5 py-0.5 hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        <span className="shrink-0">派发给</span>
        <b className="shrink-0 font-mono text-xs font-semibold text-ink-2">{item.agent}</b>
        <span className="min-w-0 max-w-[40%] shrink truncate">{oneLine(item.prompt, 40)}</span>
        {retry ? (
          <span className={cn('shrink-0 rounded-sm border px-1.5 text-[11px] leading-[18px]', item.attempt === item.maxAttempts ? 'border-danger text-danger' : 'border-warn text-warn')}>
            第 {item.attempt} 次尝试{item.maxAttempts ? `（共 ${item.maxAttempts} 次）` : ''}
          </span>
        ) : null}
        {lost ? (
          <span className="shrink-0 text-danger">已中断：没有收到结果</span>
        ) : item.state === 'run' ? (
          <span className="shrink-0 text-accent">{status}</span>
        ) : item.state === 'fail' ? (
          <span className="shrink-0 text-danger">失败{item.tookMs != null ? ` · 用时 ${took(item.tookMs)}` : ''}</span>
        ) : item.tookMs != null ? (
          <span className="shrink-0">用时 {took(item.tookMs)}</span>
        ) : null}
      </summary>
      <div className="mt-0.5 ml-4 grid gap-1.5 border-l border-line-2 pl-2.5">
        <div>
          <div className="text-[11.5px]">任务</div>
          <pre className="m-0 max-h-40 overflow-auto rounded-md bg-code px-3 py-2 font-mono text-xs leading-[1.55] wrap-anywhere whitespace-pre-wrap text-ink-2">{item.prompt}</pre>
        </div>
        {lost ? (
          <div className="text-danger">服务中途停止了，这个任务没有返回结果。执行者可能已经做了一部分，请先检查文件，再决定要不要重发。</div>
        ) : null}
        {item.reply ? (
          <div>
            <div className="text-[11.5px]">{item.state === 'fail' ? '失败原因' : '回复'}</div>
            <pre className={cn('m-0 max-h-64 overflow-auto rounded-md bg-code px-3 py-2 font-mono text-xs leading-[1.55] wrap-anywhere whitespace-pre-wrap text-ink-2', item.state === 'fail' && 'text-danger')}>{item.reply}</pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}
