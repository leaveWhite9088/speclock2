import { ChevronRight } from 'lucide-react';
import type { Item } from '@/lib/types';

type Thought = Extract<Item, { kind: 'thought' }>;

/** What an executor reasoned before it answered; closed by default, since most readers want the answer. */
export function ThoughtBlock({ item }: { item: Thought }) {
  return (
    <details className="group -my-1 text-[12.5px] text-muted">
      <summary className="flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 py-0.5 hover:text-ink [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3 shrink-0 transition-transform group-open:rotate-90" />
        <span className="whitespace-nowrap">{item.live ? '思考中…' : '思考过程'}{item.chars ? ` · ${item.chars} 字` : item.live ? ` · ${item.text.length} 字` : ''}</span>
      </summary>
      <pre className="m-0 mt-0.5 ml-4 max-h-72 overflow-auto border-l border-line-2 pl-2.5 font-sans text-[12.5px] leading-[1.6] wrap-anywhere whitespace-pre-wrap">{item.text}</pre>
    </details>
  );
}
