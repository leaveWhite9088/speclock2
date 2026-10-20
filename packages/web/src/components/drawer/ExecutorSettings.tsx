import { useQueryClient } from '@tanstack/react-query';
import type { FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useCatalog, useExecutorSessions } from '@/hooks/queries';
import { useDraft } from '@/hooks/useDraft';
import { useForceable } from '@/hooks/useForceable';
import { api, enc } from '@/lib/api';
import { modelName, relDir, when } from '@/lib/format';
import type { Member, Session } from '@/lib/types';
import { DISPATCHER, useUi } from '@/store';
import { SessionList } from './SessionList';
import { DraftActions, SectionHead } from './parts';

const activeSession = (m: Member, sessions: Session[]) => sessions.find((s) => s.active)?.sessionId ?? m.preferSession ?? sessions[0]?.sessionId ?? null;

export function ExecutorSettings({ m, projectId, root }: { m: Member; projectId: string; root: string }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const forceable = useForceable();
  const { select, setDrawer, reloadConversation } = useUi.getState();
  const { data: catalog } = useCatalog(m.type);
  const { data: sessions, error: sessionsError } = useExecutorSessions(m.key);

  let current = m.model ?? m.preferModel ?? '';
  if (current === catalog?.default) current = '';
  const saved = { name: m.id, role: m.role ?? '', model: current };
  const dirLabel = relDir(m.dir, root);
  const draft = useDraft(`draft:instance:${projectId}:${m.id}`, saved);
  const v = draft.values;

  const options = [{ value: '', label: catalog?.default ? `默认（${modelName(catalog, catalog.default)}）` : '默认' }, ...(catalog?.models ?? []).map((x) => ({ value: x.value, label: x.name || x.value }))];
  // The saved choice must show even when the model list could not be read.
  if (current && !options.some((o) => o.value === current)) options.push({ value: current, label: modelName(catalog, current) ?? current });

  const refreshAll = async () => {
    await qc.invalidateQueries({ queryKey: ['projects'] });
    await qc.invalidateQueries({ queryKey: ['sessions', m.key] });
    reloadConversation();
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const patch: Record<string, unknown> = {};
    if (v.name !== m.id) patch.name = v.name;
    if (v.role !== (m.role ?? '')) patch.role = v.role;
    if (v.model !== current) patch.model = v.model || null;
    try {
      const r = await api<{ key: string }>('PATCH', `/api/projects/${enc(projectId)}/instances/${enc(m.id)}`, patch);
      draft.clear();
      if (r.key !== m.key) select(r.key);
      toast('已提交');
      await qc.invalidateQueries({ queryKey: ['projects'] });
      if (patch.name !== undefined) reloadConversation();
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const base = `/api/agents/${enc(m.key)}`;
  const active = sessions ? activeSession(m, sessions) : null;

  const remove = async () => {
    if (!(await confirm({ title: `删除执行者「${m.id}」？`, description: '只移除配置和进程，它的会话记录保留在磁盘上。', confirmText: '删除', danger: true }))) return;
    try {
      const done = await forceable(`删除执行者 ${m.id}`, (force) => api('DELETE', `/api/projects/${enc(projectId)}/instances/${enc(m.id)}${force ? '?force=1' : ''}`));
      if (!done) return;
      setDrawer(false);
      select(DISPATCHER);
      await qc.invalidateQueries({ queryKey: ['projects'] });
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <>
      <form onSubmit={submit} className="grid gap-2">
        <Field label="名称">
          <Input required filled={v.name.trim() !== saved.name.trim()} value={v.name} onChange={(e) => draft.set({ name: e.target.value })} />
        </Field>
        <Field label="用途">
          <Input placeholder="调度器据此挑人，例如 后端服务" filled={v.role.trim() !== saved.role.trim()} value={v.role} onChange={(e) => draft.set({ role: e.target.value })} />
        </Field>
        <Field label="目录">
          <div className="truncate text-[12.5px] text-ink-2" title="目录在创建时定下，之后不能修改；要换目录请新建执行者">
            {dirLabel}
          </div>
        </Field>
        <Field label="模型">
          <Select filled={v.model !== saved.model} value={v.model} onChange={(x) => draft.set({ model: x })} options={options} />
        </Field>
        <DraftActions dirty={draft.dirty} valid={Boolean(v.name.trim())} submitText="提交修改" onUndo={draft.undo} />
      </form>

      <section>
        <SectionHead
          title="会话"
          action={
            <Button
              variant="link"
              onClick={async () => {
                try {
                  await api('POST', `${base}/sessions`, {});
                  toast('已新建会话');
                  await refreshAll();
                } catch (e) {
                  toast((e as Error).message);
                }
              }}
            >
              ＋ 新建
            </Button>
          }
        />
        <SessionList
          rows={sessions?.map((s) => ({ key: s.sessionId, title: s.label || s.title || s.sessionId.slice(0, 8), sub: when(s.updatedAt), current: s.sessionId === active }))}
          error={sessionsError?.message}
          emptyText="还没有会话，第一次发消息时会自动创建。"
          onUse={async (id) => {
            await api('POST', `${base}/use`, { sessionId: id });
            await refreshAll();
          }}
          onRename={async (id, label) => {
            await api('POST', `${base}/rename`, { sessionId: id, label });
            await refreshAll();
          }}
          onDelete={async (id) => {
            await api('DELETE', `${base}/sessions/${enc(id)}`);
            await refreshAll();
          }}
        />
      </section>

      <div className="border-t border-line pt-3.5">
        <Button variant="linkDanger" onClick={() => void remove()}>
          删除这个执行者
        </Button>
      </div>
    </>
  );
}
