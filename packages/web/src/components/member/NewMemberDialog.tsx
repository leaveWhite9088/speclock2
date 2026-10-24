import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useCatalog, useDirs, useInstanceTypes, useProbeSessions, useProject, useTemplates } from '@/hooks/queries';
import { api, enc } from '@/lib/api';
import { modelLabel, modelName, relDir, when } from '@/lib/format';
import { useUi } from '@/store';
import { TemplatesDialog } from './TemplatesDialog';

const EMPTY = { id: '', type: '', dir: '', role: '', model: '', sessionId: 'new', template: '' };

export function NewMemberDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const project = useProject();
  const select = useUi((s) => s.select);
  const [form, setForm] = useState(EMPTY);
  const [managing, setManaging] = useState(false);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  const { data: types = [] } = useInstanceTypes();
  const { data: templates = [] } = useTemplates(open);
  const tpl = templates.find((t) => t.id === form.template);
  // A template fills in what it knows; everything stays editable.
  const pick = (id: string) => {
    const t = templates.find((x) => x.id === id);
    // The name follows the template while it is the template's own name (or empty): a name the person typed stays.
    const autoName = form.id === '' || form.id === tpl?.id;
    if (!t) return set({ template: '', id: autoName ? '' : form.id });
    set({ template: id, id: autoName ? t.id : form.id, type: t.type && types.includes(t.type) ? t.type : form.type, dir: relDir(t.dir, project?.root), role: t.role, model: t.model, sessionId: 'new' });
  };
  const type = form.type || types[0] || '';
  const dir = relDir(form.dir, project?.root);
  const { data: dirs = [] } = useDirs(project?.id ?? '', open);
  const { data: catalog, isPending: modelsLoading } = useCatalog(open ? type : undefined);
  // Listing sessions can start a CLI (10 s or more), so it loads on its own and never holds back the models.
  const { data: sessions, isPending: sessionsLoading, isError } = useProbeSessions(project?.id ?? "", type, dir, open);

  const known = ['./', ...dirs.map((d) => relDir(d))];

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!project) return;
    try {
      await api('POST', `/api/projects/${enc(project.id)}/instances`, {
        id: form.id,
        type,
        dir,
        role: form.role || undefined,
        model: form.model || undefined,
        sessionId: form.sessionId || 'new',
        template: form.template || undefined,
      });
      onOpenChange(false);
      setForm(EMPTY);
      toast('已创建，第一次用到时才会启动');
      await qc.invalidateQueries({ queryKey: ['projects'] });
      select(`${project.id}~${form.id}`);
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="新建执行者" description="执行者是固定在项目某个目录里的 CLI 进程。创建时只写配置，第一次用到才会启动。">
        <form onSubmit={submit} className="grid gap-2">
          <Field label="模板" hint={tpl ? '系统提示词来自这个模板，改提示词请点右边的「管理模板」' : templates.length ? undefined : '还没有模板，点右边的「管理模板」建一个'}>
            <div className="flex min-w-0 items-center gap-2">
              <Select className="min-w-0 flex-1" filled={Boolean(form.template)} value={form.template} onChange={pick} options={[{ value: '', label: '不使用模板' }, ...templates.map((t) => ({ value: t.id, label: t.name }))]} />
              <Button variant="link" className="shrink-0" onClick={() => setManaging(true)}>
                管理模板
              </Button>
            </div>
          </Field>
          <Field label="名称">
            <Input required autoFocus placeholder="例如 dsh-backend" value={form.id} onChange={(e) => set({ id: e.target.value })} />
          </Field>
          <Field label="CLI">
            <Select filled={Boolean(form.type)} value={type} onChange={(v) => set({ type: v, model: '', sessionId: 'new' })} options={types.map((t) => ({ value: t, label: t }))} />
          </Field>
          <Field label="目录">
            <Input
              required
              list="member-dirs"
              placeholder="选已有目录，或填新的"
              value={form.dir}
              onChange={(e) => set({ dir: e.target.value, sessionId: 'new' })}
              onBlur={() => form.dir.trim() && set({ dir: relDir(form.dir, project?.root) })}
            />
            <datalist id="member-dirs">
              {known.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </Field>
          <Field label="用途">
            <Input placeholder="调度器据此挑人，例如 后端服务" value={form.role} onChange={(e) => set({ role: e.target.value })} />
          </Field>
          <Field label="模型">
            <Select
              filled={form.model !== ''}
              value={form.model}
              onChange={(v) => set({ model: v })}
              placeholder={modelsLoading ? '读取中…' : undefined}
              options={[
                { value: '', label: catalog?.default ? `默认（${modelName(catalog, catalog.default)}）` : '默认' },
                ...(catalog?.models ?? []).map((m) => ({ value: m.value, label: modelLabel(m.value, m.name) })),
              ]}
            />
          </Field>
          <Field label="会话">
            <Select
              filled={form.sessionId !== 'new'}
              value={form.sessionId}
              onChange={(v) => set({ sessionId: v })}
              placeholder={sessionsLoading ? '读取中，需要启动一次 CLI，约 10 秒…' : undefined}
              options={[
                { value: 'new', label: '新建会话' },
                ...(isError ? [] : (sessions ?? []).map((s) => ({ value: s.sessionId, label: `${s.title || s.sessionId.slice(0, 8)}，${when(s.updatedAt)}` }))),
              ]}
            />
          </Field>
          <div className="mt-1.5 flex justify-end gap-2">
            <Button onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" variant="primary" disabled={!project}>
              创建执行者
            </Button>
          </div>
        </form>
      </DialogContent>
      <TemplatesDialog open={managing} onOpenChange={setManaging} />
    </Dialog>
  );
}
