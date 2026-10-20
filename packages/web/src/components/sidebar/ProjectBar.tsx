import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Ellipsis, Plus } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Input } from '@/components/ui/input';
import { MenuItem, Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toast } from '@/components/ui/toast';
import { useProject, useProjectsQuery } from '@/hooks/queries';
import { useForceable } from '@/hooks/useForceable';
import { api, enc } from '@/lib/api';
import { useUi } from '@/store';

type Open = 'list' | 'new' | 'menu' | null;

/**
 * Project switcher, new-project form and project actions. One `open` value drives all three,
 * so opening one closes the others (and a click anywhere else closes it).
 */
export function ProjectBar() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const forceable = useForceable();
  const { data } = useProjectsQuery();
  const project = useProject();
  const setProject = useUi((s) => s.setProject);
  const [open, setOpen] = useState<Open>(null);
  const [form, setForm] = useState({ id: '', name: '', root: '' });
  const bind = (which: Exclude<Open, null>) => ({ open: open === which, onOpenChange: (o: boolean) => setOpen(o ? which : null) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['projects'] });

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', '/api/projects', { id: form.id, name: form.name || form.id, root: form.root });
      setForm({ id: '', name: '', root: '' });
      setOpen(null);
      await refresh();
      setProject(form.id);
      toast('项目已创建');
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const stop = async () => {
    setOpen(null);
    if (!project || !(await confirm({ title: `关闭项目「${project.name}」？`, description: '会停掉调度器和所有执行者的进程。配置和会话保留，下次用到时自动重新启动。' }))) return;
    try {
      if (await forceable('关闭项目', (force) => api('POST', `/api/projects/${enc(project.id)}/stop`, { force }))) {
        toast('项目已关闭');
        await refresh();
      }
    } catch (err) {
      toast((err as Error).message);
    }
  };

  const remove = async () => {
    setOpen(null);
    if (!project || !(await confirm({ title: `删除项目「${project.name}」的配置？`, description: '会停掉它的进程并移除执行者清单。项目目录里的文件不会被动。', confirmText: '删除', danger: true }))) return;
    try {
      if (await forceable('删除项目', (force) => api('DELETE', `/api/projects/${enc(project.id)}${force ? '?force=1' : ''}`))) {
        toast('项目已删除');
        setProject('');
        await refresh();
      }
    } catch (err) {
      toast((err as Error).message);
    }
  };

  return (
    <div className="flex items-center gap-0.5 px-3 pt-3 pb-1.5">
      <Popover {...bind('list')}>
        <PopoverTrigger asChild>
          <Button variant="ghost" size="none" className="h-[30px] min-w-0 flex-1 justify-start gap-1 px-2 text-[15px] font-semibold" title="切换项目">
            <span className="truncate">{project?.name ?? '还没有项目'}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="max-h-[60vh] w-60 overflow-y-auto" role="listbox">
          {data?.projects.length ? (
            data.projects.map((p) => (
              <MenuItem
                key={p.id}
                role="option"
                aria-selected={p.id === project?.id}
                onClick={() => {
                  setOpen(null);
                  if (p.id !== project?.id) setProject(p.id);
                }}
              >
                {p.name}
                {p.name !== p.id ? <small className="text-[11.5px] font-normal text-muted">{p.id}</small> : null}
              </MenuItem>
            ))
          ) : (
            <div className="p-2 text-[12.5px] text-muted">还没有项目，点右边的 ＋ 新建。</div>
          )}
        </PopoverContent>
      </Popover>

      <Popover {...bind('new')}>
        <PopoverTrigger asChild>
          <Button size="icon" variant="ghost" title="新建项目" aria-label="新建项目">
            <Plus className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-2.5">
          <form onSubmit={create} className="grid gap-2">
            <Input autoFocus placeholder="项目 id，例如 shop" required value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} />
            <Input placeholder="显示名（可不填）" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Input placeholder="根目录，绝对路径，需已存在" required value={form.root} onChange={(e) => setForm({ ...form, root: e.target.value })} />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setOpen(null)}>取消</Button>
              <Button type="submit" variant="primary">
                创建项目
              </Button>
            </div>
          </form>
        </PopoverContent>
      </Popover>

      <Popover {...bind('menu')}>
        <PopoverTrigger asChild>
          <Button size="icon" variant="ghost" title="项目操作" aria-label="项目操作" disabled={!project}>
            <Ellipsis className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-60">
          <MenuItem onClick={() => void stop()}>
            关闭项目<small className="text-[11.5px] text-muted">停掉所有进程，配置和会话保留</small>
          </MenuItem>
          <MenuItem className="text-danger" onClick={() => void remove()}>
            删除项目<small className="text-[11.5px] text-muted">移除配置，目录里的文件不动</small>
          </MenuItem>
        </PopoverContent>
      </Popover>
    </div>
  );
}
