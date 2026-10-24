import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dot } from '@/components/ui/dot';
import { useProject, useProjectsQuery } from '@/hooks/queries';
import { useUi } from '@/store';
import { NewMemberDialog } from '../member/NewMemberDialog';
import { TemplatesDialog } from '../member/TemplatesDialog';
import { MemberList } from './MemberList';
import { ProjectBar } from './ProjectBar';

function StatusBar() {
  const conn = useUi((s) => s.conn);
  const { data } = useProjectsQuery();
  const l = data?.limits;
  const full = l ? `进程 ${l.alive}/${l.maxProcesses}${l.global ? `，其中项目外 ${l.global}` : ''}，空闲 ${l.idleMinutes} 分钟回收` : '';
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-[11.5px] whitespace-nowrap text-muted">
      <Dot state={conn === 'on' ? 'on' : conn === 'off' ? 'off' : 'idle'} />
      <span>{conn === 'on' ? '已连接' : conn === 'off' ? '未连接' : '连接中'}</span>
      {l ? (
        <>
          <span className="size-0.5 shrink-0 rounded-full bg-muted" aria-hidden />
          <span className="min-w-0 truncate" title={full}>
            进程 {l.alive}/{l.maxProcesses} · 空闲 {l.idleMinutes} 分钟回收
          </span>
        </>
      ) : null}
    </div>
  );
}

export function Sidebar() {
  const project = useProject();
  const [creating, setCreating] = useState(false);
  const [templating, setTemplating] = useState(false);
  return (
    <aside className="flex min-h-0 flex-col bg-side max-[620px]:max-h-[34vh]">
      <ProjectBar />
      <MemberList />
      <div className="grid gap-2 px-3 pt-2 pb-3 max-[620px]:hidden">
        <Button variant="outline" className="w-full" disabled={!project} onClick={() => setCreating(true)}>
          新建执行者
        </Button>
        <Button variant="link" className="justify-self-start" onClick={() => setTemplating(true)}>
          执行者模板
        </Button>
        <StatusBar />
      </div>
      <NewMemberDialog open={creating} onOpenChange={setCreating} />
      <TemplatesDialog open={templating} onOpenChange={setTemplating} />
    </aside>
  );
}
