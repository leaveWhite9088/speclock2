import { clock, took } from '@/lib/format';
import type { Item } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';

type Say = Extract<Item, { kind: 'user' | 'assistant' | 'error' }>;

export function Message({ item }: { item: Say }) {
  const user = item.kind === 'user';
  const error = item.kind === 'error';
  return (
    <div className={cn('grid gap-[3px]', user && 'justify-items-end')}>
      {!user && (item.who || item.at) ? (
        <div className="flex items-baseline gap-2 text-[11.5px] text-muted">
          {item.who ? <span className={cn(error && 'text-danger')}>{item.who}</span> : null}
          {item.at ? <span title="开始的时刻">{clock(item.at)}</span> : null}
        </div>
      ) : null}
      <div
        className={cn(
          'text-sm leading-[1.6] wrap-anywhere text-ink',
          user && 'max-w-[85%] rounded-lg rounded-br-sm bg-bubble px-3 py-[7px] whitespace-pre-wrap',
          error && 'whitespace-pre-wrap text-danger',
        )}
      >
        {item.kind === 'assistant' ? <Markdown text={item.text} /> : item.text}
      </div>
      {item.kind === 'user' && (item.at || item.ack || item.note) ? (
        <div className="flex items-baseline gap-2 text-[11.5px] text-muted">
          {item.note ? <span className="text-warn">{item.note}</span> : null}
          {item.ack ? <span>已收到</span> : null}
          {item.at ? <span title="发送的时刻">{clock(item.at)}</span> : null}
        </div>
      ) : null}
      {item.kind !== 'user' && item.tookMs != null ? <div className="text-[11.5px] text-muted">{item.tookLabel ?? '用时'} {took(item.tookMs)}</div> : null}
    </div>
  );
}
