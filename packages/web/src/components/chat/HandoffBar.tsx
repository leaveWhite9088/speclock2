import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { api, enc } from '@/lib/api';
import { onLive } from '@/lib/events';
import { useUi } from '@/store';

export interface Handoff {
  id: string;
  agent: string;
  reason: string;
  evidence: string;
  status: 'pending' | 'generating' | 'review' | 'applying' | 'done' | 'cancelled';
  doc: string | null;
  error: string | null;
}

/**
 * Handoff proposals from the dispatcher. Nothing changes until a person generates the note, reads (and may edit)
 * it, and confirms: only then does the executor move to a new session.
 */
export function HandoffBar() {
  const project = useUi((s) => s.project);
  const qc = useQueryClient();
  const key = ['handoffs', project];
  const { data } = useQuery({
    queryKey: key,
    queryFn: () => api<{ handoffs: Handoff[] }>('GET', `/api/handoffs?project=${enc(project)}`),
    enabled: !!project,
  });
  useEffect(() => onLive((e) => e.name === 'handoff.changed' && void qc.invalidateQueries({ queryKey: key })), [qc, project]); // eslint-disable-line react-hooks/exhaustive-deps

  const [openId, setOpenId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const items = data?.handoffs ?? [];
  const open = items.find((h) => h.id === openId);

  const act = async (h: Handoff, what: 'generate' | 'apply' | 'cancel') => {
    setBusy(true);
    try {
      await api('POST', `/api/handoffs/${enc(h.id)}/${what}`, what === 'apply' ? { text } : undefined);
      if (what === 'apply' || what === 'cancel') setOpenId(null);
      if (what === 'apply') useUi.getState().reloadConversation();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: key });
    }
  };

  useEffect(() => {
    if (open?.status === 'review' && open.doc != null) setText(open.doc);
  }, [open?.id, open?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!items.length) return null;
  return (
    <>
      <div className="mx-6 mb-2 flex flex-col gap-1.5">
        {items.map((h) => (
          <div key={h.id} className="surface flex items-center gap-3 px-3 py-2 text-[13px]">
            <div className="min-w-0 flex-1">
              <div className="truncate">
                <b>{h.agent === '@dispatcher' ? '调度器' : h.agent}</b> 建议换一个新会话：{h.reason}
              </div>
              {h.error && <div className="truncate text-[12px] text-danger">{h.error}</div>}
            </div>
            {h.status === 'pending' && (
              <>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(h, 'generate')}>生成交接文档</Button>
                <Button size="sm" disabled={busy} onClick={() => void act(h, 'cancel')}>忽略</Button>
              </>
            )}
            {h.status === 'generating' && <span className="text-muted">正在写交接文档…</span>}
            {h.status === 'review' && <Button size="sm" variant="primary" onClick={() => setOpenId(h.id)}>查看并确认</Button>}
            {h.status === 'applying' && <span className="text-muted">正在切换到新会话…</span>}
          </div>
        ))}
      </div>
      <Dialog open={!!open && open.status === 'review'} onOpenChange={(o) => !o && setOpenId(null)}>
        {open && (
          <DialogContent
            title={`交接 ${open.agent === '@dispatcher' ? '调度器' : open.agent}`}
            description="下面是旧会话写的交接文档，可以直接修改。确认后会开一个新会话并让它先读这份文档；旧会话保留。"
            className="w-[min(720px,94vw)]"
          >
            <textarea
              className="field mt-2 h-[380px] w-full resize-none p-3 font-mono text-[12.5px] leading-relaxed"
              data-filled="true"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button disabled={busy} onClick={() => void act(open, 'cancel')}>放弃</Button>
              <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void act(open, 'apply')}>确认并开新会话</Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
