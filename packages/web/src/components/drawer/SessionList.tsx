import { Pencil, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

export interface SessionRowData {
  key: string;
  title: string;
  sub: string;
  current: boolean;
}

interface Props {
  rows: SessionRowData[] | undefined;
  error?: string;
  emptyText: string;
  onUse: (key: string) => Promise<void>;
  onRename: (key: string, label: string) => Promise<void>;
  onDelete: (key: string) => Promise<void>;
}

/** Click a session to switch to it, pencil to rename in place, bin to delete (never the one in use). */
export function SessionList({ rows, error, emptyText, onUse, onRename, onDelete }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const cancelled = useRef(false); // Escape unmounts the field, which blurs it; that must not save
  const confirm = useConfirm();
  const run = (fn: () => Promise<unknown>, done?: string) => async () => {
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      toast((e as Error).message);
    }
  };

  if (error) return <div className="px-2 py-1 text-[12.5px] text-muted">{error}</div>;
  if (!rows) return <div className="px-2 py-1 text-[12.5px] text-muted">读取中…</div>;
  if (!rows.length) return <div className="px-2 py-1 text-[12.5px] text-muted">{emptyText}</div>;

  return (
    <div className="-mx-2 grid max-h-80 overflow-y-auto">
      {rows.map((r) =>
        editing === r.key ? (
          <Input
            key={r.key}
            autoFocus
            defaultValue={r.title}
            className="mx-2 my-0.5 h-7 w-[calc(100%-16px)]"
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                cancelled.current = true;
                setEditing(null);
              } else if (e.key === 'Enter') e.currentTarget.blur();
            }}
            onBlur={(e) => {
              const label = e.currentTarget.value.trim();
              setEditing(null);
              if (!cancelled.current && label !== r.title) void run(() => onRename(r.key, label), '已重命名')();
            }}
          />
        ) : (
          <div key={r.key} className="group flex items-center gap-0.5 rounded-md hover:bg-hover">
            <button
              type="button"
              disabled={r.current}
              onClick={run(() => onUse(r.key))}
              className="grid min-w-0 flex-1 justify-items-start px-2 py-1.5 text-left disabled:cursor-default"
            >
              <span className={cn('max-w-full truncate', r.current && 'font-semibold text-accent')}>{r.title || '（无标题）'}</span>
              <small className="text-[11.5px] text-muted">{r.current ? `${r.sub} · 当前` : r.sub}</small>
            </button>
            <Button size="iconSm" variant="ghost" className="" title="重命名" aria-label="重命名" onClick={() => {
                cancelled.current = false;
                setEditing(r.key);
              }}>
              <Pencil />
            </Button>
            {!r.current ? (
              <Button
                size="iconSm"
                variant="ghost"
                className="hover:text-danger"
                title="删除会话"
                aria-label="删除会话"
                onClick={run(async () => {
                  if (await confirm({ title: `删除会话「${r.title || r.sub}」？`, description: '删除后无法在这里恢复。', confirmText: '删除', danger: true })) await onDelete(r.key);
                }, '已删除会话')}
              >
                <Trash2 />
              </Button>
            ) : null}
          </div>
        ),
      )}
    </div>
  );
}
