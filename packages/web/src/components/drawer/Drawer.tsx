import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSelectedMember } from '@/hooks/queries';
import { useUi } from '@/store';
import { DispatcherSettings } from './DispatcherSettings';
import { ExecutorSettings } from './ExecutorSettings';

/** Settings of whoever is selected: the dispatcher's model and sessions, or an executor's config and sessions. */
export function Drawer() {
  const open = useUi((s) => s.drawer);
  const setDrawer = useUi((s) => s.setDrawer);
  const { project, member, isDispatcher } = useSelectedMember();
  if (!open || !project) return null;
  return (
    <aside
      aria-label="设置"
      onKeyDown={(e) => e.key === 'Escape' && setDrawer(false)}
      className="surface m-2 ml-0 flex min-h-0 w-[330px] flex-col max-[900px]:fixed max-[900px]:inset-y-0 max-[900px]:right-0 max-[900px]:z-10 max-[900px]:ml-2 max-[900px]:max-w-[92vw]"
    >
      <div className="flex min-h-[52px] items-center justify-between py-2.5 pr-3.5 pl-5">
        <h2 className="m-0 text-[15px] font-semibold">{isDispatcher ? '调度器设置' : `${member?.id ?? ''} 设置`}</h2>
        <Button size="icon" variant="ghost" aria-label="关闭设置" onClick={() => setDrawer(false)}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="grid flex-1 content-start gap-5 overflow-y-auto px-5 pt-1 pb-6">
        {isDispatcher ? <DispatcherSettings key={project.id} projectId={project.id} /> : member ? <ExecutorSettings key={member.key} m={member} projectId={project.id} root={project.root} /> : null}
      </div>
    </aside>
  );
}
