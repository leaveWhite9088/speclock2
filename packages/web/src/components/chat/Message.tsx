import type { Item } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Markdown } from './Markdown';

type Say = Extract<Item, { kind: 'user' | 'assistant' | 'error' }>;

export function Message({ item }: { item: Say }) {
  const user = item.kind === 'user';
  const error = item.kind === 'error';
  return (
    <div className={cn('grid gap-[3px]', user && 'justify-items-end')}>
      {!user && item.who ? <div className={cn('text-[11.5px] text-muted', error && 'text-danger')}>{item.who}</div> : null}
      <div
        className={cn(
          'text-sm leading-[1.6] wrap-anywhere text-ink',
          user && 'max-w-[85%] rounded-lg rounded-br-sm bg-bubble px-3 py-[7px] whitespace-pre-wrap',
          error && 'whitespace-pre-wrap text-danger',
        )}
      >
        {item.kind === 'assistant' ? <Markdown text={item.text} /> : item.text}
      </div>
    </div>
  );
}
