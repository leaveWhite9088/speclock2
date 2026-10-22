import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ContextRing } from '@/components/ui/context-ring';
import { Tag } from '@/components/ui/tag';
import { toast } from '@/components/ui/toast';
import { useCatalog, useDispatcherModels, useSelectedMember } from '@/hooks/queries';
import { api, enc } from '@/lib/api';
import { memberLlm } from '@/lib/format';
import { useUi } from '@/store';

export function ChatHeader() {
  const qc = useQueryClient();
  const { project, member, isDispatcher } = useSelectedMember();
  const drawer = useUi((s) => s.drawer);
  const setDrawer = useUi((s) => s.setDrawer);
  const { data: models } = useDispatcherModels(project?.id ?? '', isDispatcher);
  const { data: catalog } = useCatalog(member?.type);
  const [starting, setStarting] = useState(false);

  if (!project) {
    return (
      <header className="flex min-h-[52px] items-center px-6 py-2.5">
        <h1 className="m-0 text-[15px] font-semibold">agentd</h1>
      </header>
    );
  }

  const d = project.dispatcher;
  const busy = isDispatcher ? d?.busy : member?.busy;
  const alive = isDispatcher ? d?.alive : member?.alive;
  const context = isDispatcher ? d?.context : member?.context;
  const llm = isDispatcher
    ? { text: models?.models.find((x) => x.value === models.current)?.name ?? models?.current ?? null, faint: !models?.current }
    : member
      ? memberLlm(member, catalog)
      : { text: null, faint: true };

  let state = member?.unstable ? '不稳定：最近多次被强制结束，已暂停派活' : busy ? '工作中' : member?.interrupted ? '上次任务因服务重启被中断，可能只做了一半，请先检查文件' : alive ? '待命' : member?.lastError ? `启动失败：${member.lastError.slice(0, 80)}` : '未启动，发消息时才会启动';

  const retry = async () => {
    if (!member) return;
    setStarting(true);
    try {
      await api('POST', `/api/agents/${enc(member.key)}/start`);
    } catch (e) {
      toast((e as Error).message);
    }
    setStarting(false);
    await qc.invalidateQueries({ queryKey: ['projects'] });
  };

  const recover = async () => {
    if (!member) return;
    try {
      await api('POST', `/api/agents/${enc(member.key)}/recover`);
    } catch (e) {
      toast((e as Error).message);
    }
    await qc.invalidateQueries({ queryKey: ['projects'] });
  };

  return (
    <header className="flex min-h-[52px] items-center justify-between gap-4 px-6 py-2.5">
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="m-0 text-[15px] font-semibold whitespace-nowrap">{isDispatcher ? '调度器' : (member?.id ?? '')}</h1>
        <Tag type={isDispatcher ? 'pi' : (member?.type ?? '')} llm={llm.text} faint={llm.faint} />
      </div>
      <div className="flex min-w-0 items-center gap-2.5">
        <ContextRing c={context} />
        <span className="min-w-0 truncate text-[12.5px] text-muted">{starting ? '正在启动…' : state}</span>
        {member?.unstable ? <Button onClick={() => void recover()}>恢复</Button> : null}
        {member && !alive && member.lastError ? (
          <Button disabled={starting} onClick={() => void retry()}>
            重试启动
          </Button>
        ) : null}
        <Button aria-pressed={drawer} onClick={() => setDrawer(!drawer)}>
          设置
        </Button>
      </div>
    </header>
  );
}
