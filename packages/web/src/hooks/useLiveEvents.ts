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
  const setActivity = useUi((s) => s.setActivity);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => setConn('on');
    es.onerror = () => setConn('off');
    const refresh = () => void qc.invalidateQueries({ queryKey: ['projects'] });
    const names: LiveName[] = ['dispatcher.event', 'job.started', 'job.done', 'agent.exit', 'agent.forced-stop', 'agent.recovered', 'job.interrupted', 'job.running', 'progress', 'handoff.changed', 'agent.compacted'];
    for (const name of names) {
      es.addEventListener(name, (m) => {
        const payload = JSON.parse((m as MessageEvent<string>).data) as Omit<LiveEvent, 'name'> & { data?: LiveEvent['data'] };
        const key = (payload as { agent?: string }).agent;
        if (name === 'progress' || name === 'job.started' || name === 'job.running' || name === 'job.done') {
          if (key) {
            const p = payload as { elapsedMs?: number; queued?: boolean };
            if (name === 'job.done') setActivity(key, null);
            else if (name === 'job.running') setActivity(key, { startedAt: Date.now() }); // it really starts now, after the ones ahead of it
            else if (name === 'job.started' && p.queued) {
              /* waiting behind another prompt: not running yet, so no clock */
            }
            else if (!useUi.getState().activity[key]) setActivity(key, { startedAt: Date.now() - (p.elapsedMs ?? 0) });
          }
          if (name === 'progress') return; // frequent, and nothing on the page needs a refetch for it
        }
        emitLive({ name, ...payload });
        if (name !== 'dispatcher.event' || !CHATTER.has(payload.data?.type ?? '')) refresh();
      });
    }
    return () => es.close();
  }, [qc, setConn, setActivity]);
}
