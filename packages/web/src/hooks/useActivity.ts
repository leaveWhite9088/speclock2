import { useEffect, useState } from 'react';
import { useProjectsQuery } from '@/hooks/queries';
import { took } from '@/lib/format';
import { useUi } from '@/store';

/** How long a running executor's task has been going, ticking once a second. Null when it is not running. */
export function useActivity(key: string | undefined) {
  const stored = useUi((s) => (key ? s.activity[key] : undefined));
  // A page opened while the task runs has seen no event yet: the executor's row says when it started.
  const { data } = useProjectsQuery();
  const row = key ? data?.projects.flatMap((p) => p.instances).find((i) => i.key === key)?.activity : null;
  const startedAt = stored?.startedAt ?? row?.startedAt;
  const [, tick] = useState(0);
  const on = startedAt != null;
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
  if (startedAt == null) return null;
  return { elapsedMs: Math.max(0, Date.now() - startedAt) };
}

/** The one thing shown while it runs: the total time so far. */
export function runLabel(l: NonNullable<ReturnType<typeof useActivity>>): string {
  return `进行中 · 已用时 ${took(l.elapsedMs)}`;
}
