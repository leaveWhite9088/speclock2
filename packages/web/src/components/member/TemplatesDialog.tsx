import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { useInstanceTypes, useTemplates } from '@/hooks/queries';
import { api, enc } from '@/lib/api';
import type { Template } from '@/lib/types';

const EMPTY: Template = { id: '', name: '', role: '', dir: '.', type: '', model: '', prompt: '' };

/** Executor templates: what an executor is for and the system prompt that makes it so. Stored as markdown files on the server. */
export function TemplatesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: templates = [], isPending } = useTemplates(open);
  const { data: types = [] } = useInstanceTypes();
  const [edit, setEdit] = useState<{ t: Template; isNew: boolean } | null>(null);
  const set = (patch: Partial<Template>) => setEdit((e) => (e ? { ...e, t: { ...e.t, ...patch } } : e));

  const close = (o: boolean) => {
    if (!o) setEdit(null);
    onOpenChange(o);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    try {
      await api('PUT', `/api/templates/${enc(edit.t.id)}`, edit.t);
      toast('模板已保存，用它创建的执行者下次启动时使用新的提示词');
      setEdit(null);
      await qc.invalidateQueries({ queryKey: ['templates'] });
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const remove = async (t: Template) => {
    const n = t.usedBy?.length ?? 0;
    const ok = await confirm({
      title: `删除模板「${t.name}」？`,
      description: n ? `有 ${n} 个执行者是用它创建的。它们不会被删除，但会失去这个模板的提示词。` : '模板文件会被删除。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('DELETE', `/api/templates/${enc(t.id)}`);
      await qc.invalidateQueries({ queryKey: ['templates'] });
      await qc.invalidateQueries({ queryKey: ['projects'] });
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="w-[min(640px,94vw)]"
        title={edit ? (edit.isNew ? '新建模板' : `编辑模板「${edit.t.name}」`) : '执行者模板'}
        description={edit ? '提示词用 markdown 写，交给执行者的系统提示词，接在通用规则后面。' : '用模板快速创建执行者，并给它一段固定的系统提示词。模板存成 contexts/templates 下的 md 文件。'}
      >
        {edit ? (
          <form onSubmit={submit} className="grid gap-2">
            <Field label="标识">
              <Input required disabled={!edit.isNew} autoFocus={edit.isNew} placeholder="例如 spec-agent，字母数字和 - _" value={edit.t.id} onChange={(e) => set({ id: e.target.value, name: edit.t.name && edit.t.name !== edit.t.id ? edit.t.name : e.target.value })} />
            </Field>
            <Field label="名称">
              <Input value={edit.t.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="用途">
              <Input placeholder="调度器据此挑人，例如 负责工程规格、接口契约与任务书" value={edit.t.role} onChange={(e) => set({ role: e.target.value })} />
            </Field>
            <Field label="目录" hint="项目里的相对目录，「.」是项目根目录">
              <Input required value={edit.t.dir} onChange={(e) => set({ dir: e.target.value })} />
            </Field>
            <Field label="CLI" hint="只是建议，创建执行者时可以换">
              <Select filled={Boolean(edit.t.type)} value={edit.t.type} onChange={(v) => set({ type: v })} options={[{ value: '', label: '不指定' }, ...types.map((t) => ({ value: t, label: t }))]} />
            </Field>
            <Field label="模型" hint="只是建议，留空用 CLI 的默认模型">
              <Input placeholder="例如 opencode-go/glm-5.3-flash" value={edit.t.model} onChange={(e) => set({ model: e.target.value })} />
            </Field>
            <Field label="提示词" className="items-start">
              <textarea
                data-filled={edit.t.prompt !== ''}
                className="field h-72 w-full resize-y px-2.5 py-2 font-mono text-xs leading-[1.6]"
                placeholder="## 写给这类执行者的规则……"
                value={edit.t.prompt}
                onChange={(e) => set({ prompt: e.target.value })}
              />
            </Field>
            <div className="mt-1.5 flex justify-end gap-2">
              <Button onClick={() => setEdit(null)}>返回</Button>
              <Button type="submit" variant="primary" disabled={!edit.t.id.trim() || !edit.t.dir.trim()}>
                保存模板
              </Button>
            </div>
          </form>
        ) : (
          <div className="grid gap-2">
            <ul className="m-0 grid max-h-[50vh] list-none gap-1 overflow-y-auto p-0">
              {templates.map((t) => (
                <li key={t.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold">{t.name}</div>
                    <div className="truncate text-[12.5px] text-muted" title={t.role}>
                      {t.role || '没有写用途'}
                      {t.usedBy?.length ? ` · ${t.usedBy.length} 个执行者在用` : ''}
                    </div>
                  </div>
                  <Button variant="link" onClick={() => setEdit({ t, isNew: false })}>
                    编辑
                  </Button>
                  <Button variant="linkDanger" onClick={() => void remove(t)}>
                    删除
                  </Button>
                </li>
              ))}
              {!templates.length ? <li className="py-3 text-[12.5px] text-muted">{isPending ? '读取中…' : '还没有模板。'}</li> : null}
            </ul>
            <div className="mt-1.5 flex justify-between">
              <Button variant="link" onClick={() => setEdit({ t: EMPTY, isNew: true })}>
                ＋ 新建模板
              </Button>
              <Button onClick={() => close(false)}>关闭</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
