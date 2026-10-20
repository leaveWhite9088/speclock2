import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useDispatcherModels, useDispatcherSessions, useLlms, useProject } from '@/hooks/queries';
import { useDraft } from '@/hooks/useDraft';
import { api, enc, pq } from '@/lib/api';
import { when } from '@/lib/format';
import { useUi } from '@/store';
import { SessionList } from './SessionList';
import { DraftActions, SectionHead } from './parts';

function AddLlm() {
  const qc = useQueryClient();
  const { data: providers } = useLlms();
  const empty = { provider: '', baseUrl: '', apiKey: '', model: '' };
  const draft = useDraft('draft:llm', empty, ['apiKey']);
  const v = draft.values;
  const valid = Object.values(v).every((x) => x.trim());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', '/api/dispatcher/llms', { provider: v.provider, baseUrl: v.baseUrl, apiKey: v.apiKey, models: [{ id: v.model }] });
      draft.clear();
      draft.undo();
      toast('已添加，运行中的调度器已重启');
      await qc.invalidateQueries({ queryKey: ['llms'] });
      await qc.invalidateQueries({ queryKey: ['dispatcher-models'] });
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <details className="group">
      <summary className="cursor-pointer list-none text-[12.5px] text-accent [&::-webkit-details-marker]:hidden">添加 LLM（所有项目的调度器共用）</summary>
      <pre className="mt-2.5 font-mono text-xs leading-relaxed wrap-anywhere whitespace-pre-wrap text-muted">
        {providers ? (providers.length ? providers.map((p) => `${p.provider}  ${p.baseUrl}\n  ${p.models.map((x) => x.id).join(', ')}`).join('\n') : '还没有自定义 LLM。') : '读取中…'}
      </pre>
      <form onSubmit={submit} className="mt-2.5 grid gap-2">
        <Field label="名称">
          <Input required placeholder="例如 my-llm" value={v.provider} onChange={(e) => draft.set({ provider: e.target.value })} />
        </Field>
        <Field label="地址">
          <Input required placeholder="例如 https://api.x.com/v1" value={v.baseUrl} onChange={(e) => draft.set({ baseUrl: e.target.value })} />
        </Field>
        <Field label="Key">
          <Input required placeholder="写 $环境变量名 或直接填值" value={v.apiKey} onChange={(e) => draft.set({ apiKey: e.target.value })} />
        </Field>
        <Field label="模型 id">
          <Input required value={v.model} onChange={(e) => draft.set({ model: e.target.value })} />
        </Field>
        <DraftActions dirty={draft.dirty} valid={valid} submitText="添加并重启调度器" onUndo={draft.undo} />
      </form>
    </details>
  );
}

export function DispatcherSettings({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const reloadConversation = useUi((s) => s.reloadConversation);
  const project = useProject();
  const { data: models } = useDispatcherModels(projectId);
  const { data: sessions, error } = useDispatcherSessions(projectId);
  const [switching, setSwitching] = useState(false);
  const [changed, setChanged] = useState(false); // the model was switched here, so the field shows white

  const refreshAll = async () => {
    await qc.invalidateQueries({ queryKey: ['projects'] });
    await qc.invalidateQueries({ queryKey: ['dispatcher-sessions', projectId] });
    reloadConversation();
  };
  const byFile = (key: string) => sessions?.find((s) => s.file === key);

  const setModel = async (value: string) => {
    setSwitching(true);
    try {
      await api('POST', `/api/dispatcher/model${pq(projectId)}`, { value });
      await qc.invalidateQueries({ queryKey: ['dispatcher-models', projectId] });
      setChanged(true);
      toast('调度器模型已切换');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <>
      <div className="grid gap-2">
        <Field
          label="模型"
          hint={models?.hiddenWithoutCredentials ? `另有 ${models.hiddenWithoutCredentials} 个模型没有配置凭据，没有列出。` : '选择后立即生效。'}
        >
          <Select filled={changed} value={models?.current ?? ''} onChange={(v) => void setModel(v)} disabled={switching || !models} options={(models?.models ?? []).map((x) => ({ value: x.value, label: x.name || x.value }))} />
        </Field>
        {project?.root ? (
          <Field label="根目录">
            <div className="truncate text-[12.5px]" title={project.root}>
              {project.root}
            </div>
          </Field>
        ) : null}
      </div>

      <section>
        <SectionHead
          title="会话"
          action={
            <Button
              variant="link"
              onClick={async () => {
                try {
                  await api('POST', `/api/dispatcher/new${pq(projectId)}`);
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
          rows={sessions?.map((s) => ({ key: s.file, title: s.label || s.title || (s.sessionId ?? '').slice(0, 8), sub: when(s.updatedAt), current: Boolean(s.active) }))}
          error={error?.message}
          emptyText="还没有会话。"
          onUse={async (file) => {
            await api('POST', `/api/dispatcher/use${pq(projectId)}`, { sessionFile: byFile(file)?.file });
            await refreshAll();
          }}
          onRename={async (file, label) => {
            await api('POST', `/api/dispatcher/rename${pq(projectId)}`, { sessionFile: file, label });
            await refreshAll();
          }}
          onDelete={async (file) => {
            await api('DELETE', `/api/dispatcher/sessions${pq(projectId)}&file=${enc(file)}`);
            await refreshAll();
          }}
        />
      </section>

      <AddLlm />
    </>
  );
}
