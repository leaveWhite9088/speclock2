import { ArrowUp, Square } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { api, enc, pq } from '@/lib/api';
import { DISPATCHER, useUi } from '@/store';

interface Props {
  placeholder: string;
  busy: boolean;
  onSend: (text: string) => Promise<void>;
}

export function Composer({ placeholder, busy, onSend }: Props) {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const project = useUi((s) => s.project);
  const sel = useUi((s) => s.sel);

  // Grow with the text up to a limit, then scroll.
  useLayoutEffect(() => {
    const t = box.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = `${Math.min(t.scrollHeight, 220)}px`;
  }, [text]);

  const submit = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    try {
      await onSend(t);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const abort = async () => {
    try {
      await (sel === DISPATCHER ? api('POST', `/api/dispatcher/abort${pq(project)}`) : api('POST', `/api/agents/${enc(sel)}/cancel`));
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="mx-auto mb-5 flex w-[calc(100%-48px)] max-w-[740px] items-end gap-1.5 field rounded-lg py-1 pr-1 pl-3 focus-within:bg-raised focus-within:ring-2 focus-within:ring-accent/30"
    >
      <textarea
        ref={box}
        rows={1}
        value={text}
        placeholder={placeholder}
        aria-label="消息"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        className="max-h-[220px] min-h-8 flex-1 resize-none bg-transparent py-1.5 leading-[1.55] outline-none placeholder:text-muted"
      />
      {busy ? (
        <Button size="none" className="size-8 bg-line text-ink hover:bg-line-2" title="中断" aria-label="中断" onClick={() => void abort()}>
          <Square className="size-3.5 fill-current" />
        </Button>
      ) : null}
      <Button type="submit" variant="primary" size="none" className="size-8 disabled:opacity-20" title="发送" aria-label="发送" disabled={!text.trim()}>
        <ArrowUp className="size-4" />
      </Button>
    </form>
  );
}
