import { useLayoutEffect, useRef } from 'react';
import { useSelectedMember } from '@/hooks/queries';
import { useConversation } from '@/hooks/useConversation';
import type { Item } from '@/lib/types';
import { Composer } from './Composer';
import { DispatchLine } from './DispatchLine';
import { Message } from './Message';
import { ToolGroup } from './ToolGroup';

type Block =
  | { kind: 'say'; item: Extract<Item, { kind: 'user' | 'assistant' | 'error' }> }
  | { kind: 'dispatch'; item: Extract<Item, { kind: 'dispatch' }> }
  | { kind: 'tools'; id: string; tools: Extract<Item, { kind: 'tool' }>[] };

/** Consecutive tool items become one collapsible group. */
function blocks(items: Item[]): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    if (item.kind === 'dispatch') out.push({ kind: 'dispatch', item });
    else if (item.kind !== 'tool') out.push({ kind: 'say', item });
    else {
      const last = out.at(-1);
      if (last?.kind === 'tools') last.tools.push(item);
      else out.push({ kind: 'tools', id: item.id, tools: [item] });
    }
  }
  return out;
}

function Empty({ hasProject, isDispatcher, hasMembers }: { hasProject: boolean; isDispatcher: boolean; hasMembers: boolean }) {
  const [title, body] = !hasProject
    ? ['先建一个项目', '项目是调度器和执行者的归属：一个根目录、一个调度器、若干执行者。点左上角的 ＋ 开始。']
    : isDispatcher
      ? ['和调度器说你要做什么', hasMembers ? '它会看每个执行者的用途，把活派下去，再把结果汇总给你。' : '这个项目还没有执行者。先在左下角新建一个，调度器才有人可派。']
      : ['还没有对话', '在下面直接给这个执行者发消息。它的模型和会话在右上的设置里改。'];
  return (
    <div className="mx-auto mt-[14vh] max-w-[740px] px-6 text-muted">
      <h2 className="m-0 mb-2 text-[19px] font-semibold tracking-tight text-ink">{title}</h2>
      <div className="max-w-[46ch]">{body}</div>
    </div>
  );
}

export function Chat() {
  const { project, sel, member, isDispatcher } = useSelectedMember();
  const { items, loading, send } = useConversation(project?.id ?? '', sel, member);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the conversation only while the reader is at the bottom.
  useLayoutEffect(() => {
    const s = scroller.current;
    if (s && stick.current) s.scrollTop = s.scrollHeight;
  }, [items]);
  useLayoutEffect(() => {
    stick.current = true; // a different conversation starts at its end
  }, [sel, project?.id]);

  const onScroll = () => {
    const s = scroller.current;
    if (s) stick.current = s.scrollHeight - s.scrollTop - s.clientHeight < 80;
  };

  const list = blocks(items);
  return (
    <>
      <div ref={scroller} onScroll={onScroll} tabIndex={-1} aria-live="polite" className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-1">
        {list.length === 0 ? (
          loading ? null : <Empty hasProject={Boolean(project)} isDispatcher={isDispatcher} hasMembers={Boolean(project?.instances.length)} />
        ) : (
          <div className="mx-auto grid max-w-[740px] grid-cols-[minmax(0,1fr)] gap-3.5 px-6 pt-1.5 pb-16 *:min-w-0">
            {list.map((b) =>
              b.kind === 'say' ? <Message key={b.item.id} item={b.item} /> : b.kind === 'dispatch' ? <DispatchLine key={b.item.id} item={b.item} /> : <ToolGroup key={b.id} tools={b.tools} />,
            )}
          </div>
        )}
      </div>
      {project ? (
        <Composer
          placeholder={isDispatcher ? '告诉调度器要做什么（Enter 发送，Shift+Enter 换行）' : `直接对 ${member?.id ?? ''} 说话（Enter 发送，Shift+Enter 换行）`}
          busy={isDispatcher ? Boolean(project.dispatcher?.busy) : Boolean(member?.busy)}
          onSend={(text) => {
            stick.current = true;
            return send(text);
          }}
        />
      ) : null}
    </>
  );
}
