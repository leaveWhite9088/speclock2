import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { emitLive, type LiveEvent, type LiveName } from '@/lib/events';
import { useUi } from '@/store';

// Per-token dispatcher events are for the conversation view only; the lists need not refetch on them.
const CHATTER = new Set(['message_update', 'tool_execution_start', 'tool_execution_end']);

/** One EventSource for the page. Everything that changes what the sidebar shows refetches `projects`. */
export function useLiveEvents() {
  const qc = useQueryClient();
  const setConn = useUi((s) => s.setConn);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => setConn('on');
    es.onerror = () => setConn('off');
    const refresh = () => void qc.invalidateQueries({ queryKey: ['projects'] });
    const names: LiveName[] = ['dispatcher.event', 'job.started', 'job.done', 'agent.exit'];
    for (const name of names) {
      es.addEventListener(name, (m) => {
        const payload = JSON.parse((m as MessageEvent<string>).data) as Omit<LiveEvent, 'name'> & { data?: LiveEvent['data'] };
        emitLive({ name, ...payload });
        if (name !== 'dispatcher.event' || !CHATTER.has(payload.data?.type ?? '')) refresh();
      });
    }
    return () => es.close();
  }, [qc, setConn]);
}
