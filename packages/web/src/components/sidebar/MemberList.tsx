import { useEffect } from 'react';
import { ContextRing } from '@/components/ui/context-ring';
import { Dot, type DotState } from '@/components/ui/dot';
import { Tag } from '@/components/ui/tag';
import { useCatalog, useDispatcherModels, useProject } from '@/hooks/queries';
import { memberLlm } from '@/lib/format';
import type { Context, Member } from '@/lib/types';
import { cn } from '@/lib/utils';
import { DISPATCHER, useUi } from '@/store';

interface RowProps {
  id: string;
  name: string;
  role?: string | null;
  type: string;
  llm: { text: string | null; faint: boolean };
  status: DotState;
  context?: Context | null;
}

function Row({ id, name, role, type, llm, status, context }: RowProps) {
  const current = useUi((s) => s.sel === id);
  const select = useUi((s) => s.select);
  return (
    <button
      type="button"
      aria-current={current}
      onClick={() => select(id)}
      className={cn('grid w-full grid-cols-[1fr_auto] items-center gap-x-2 gap-y-0.5 rounded-md border border-transparent px-2.5 py-2 text-left hover:bg-hover', current && 'border-line bg-raised')}
    >
      <span className="col-span-2 flex min-w-0 items-center gap-2 font-semibold">
        <Dot state={status} />
        <span className="truncate">{name}</span>
        <ContextRing c={context} className="ml-auto" />
      </span>
      {role ? <span className="col-span-2 truncate pl-4 text-[12.5px] text-muted">{role}</span> : null}
      <Tag type={type} llm={llm.text} faint={llm.faint} className="col-span-2 mt-0.5 ml-4 justify-self-start" />
    </button>
  );
}

function ExecutorRow({ m }: { m: Member }) {
  const { data: catalog } = useCatalog(m.type);
  return <Row id={m.key} name={m.id} role={m.role} type={m.type} llm={memberLlm(m, catalog)} status={m.busy ? 'busy' : m.alive ? 'on' : 'idle'} context={m.context} />;
}

export function MemberList() {
  const project = useProject();
  const select = useUi((s) => s.select);
  const sel = useUi((s) => s.sel);
  const { data: models } = useDispatcherModels(project?.id ?? '');

  // An executor that was deleted (here or elsewhere) must not stay selected.
  useEffect(() => {
    if (project && sel !== DISPATCHER && !project.instances.some((i) => i.key === sel)) select(DISPATCHER);
  }, [project, sel, select]);

  if (!project) {
    return <div className="p-3 text-[12.5px] text-muted">还没有项目。点右上的 ＋ 新建一个，项目是调度器和执行者的归属。</div>;
  }
  const d = project.dispatcher;
  const dName = models?.models.find((x) => x.value === models.current);
  return (
    <nav aria-label="成员" className="grid flex-1 content-start gap-0.5 overflow-y-auto px-2 py-1">
      <Row
        id={DISPATCHER}
        name="调度器"
        role="听你的需求，决定让谁去做"
        type="pi"
        llm={{ text: models?.current ? (dName?.name ?? models.current) : null, faint: !models?.current }}
        status={d?.busy ? 'busy' : d?.alive ? 'on' : 'idle'}
        context={d?.context}
      />
      {project.instances.length ? <div className="mx-2.5 my-1.5 h-px bg-line" /> : null}
      {project.instances.map((m) => (
        <ExecutorRow key={m.key} m={m} />
      ))}
    </nav>
  );
}
