import { useEffect, useState } from 'react';
import { Dot } from '@/components/ui/dot';
import { took } from '@/lib/format';
import type { Turn } from '@/lib/types';

/**
 * Under the conversation while something works on it: what it is doing and how long since the message was sent.
 * It is the proof that the message arrived and is being dealt with.
 */
export function TurnStatus({ turn }: { turn: Turn }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div role="status" className="mx-auto flex max-w-[740px] items-center gap-2 px-6 pb-3 text-[12.5px] text-muted">
      <Dot state="busy" />
      <span>
        {turn.phase} · 已用 {took(Math.max(0, Date.now() - turn.startedAt))}
      </span>
    </div>
  );
}
