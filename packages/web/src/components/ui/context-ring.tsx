import * as RT from '@radix-ui/react-tooltip';
import type { Context } from '@/lib/types';
import { cn } from '@/lib/utils';

const R = 7;
const C = 2 * Math.PI * R;
const fmt = (n?: number | null) => (n == null ? '?' : n >= 10_000 ? `${Math.round(n / 1000)}K` : n.toLocaleString());

/** A ring that fills with how much of the context window is used; hover for the percentage and the token counts. */
export function ContextRing({ c, className }: { c?: Context | null; className?: string }) {
  if (!c || c.percent == null) return null;
  const pct = Math.min(100, Math.max(0, c.percent));
  const tone = pct >= 95 ? 'text-danger' : pct >= 80 ? 'text-warn' : 'text-accent';
  return (
    <RT.Provider delayDuration={150}>
      <RT.Root>
        <RT.Trigger asChild>
          <span role="img" aria-label={`上下文已用 ${Math.round(pct)}%`} className={cn('inline-flex shrink-0', tone, className)}>
            <svg viewBox="0 0 20 20" className="size-4 -rotate-90">
              <circle cx="10" cy="10" r={R} fill="none" strokeWidth="2.5" className="stroke-line-2" />
              <circle cx="10" cy="10" r={R} fill="none" strokeWidth="2.5" strokeLinecap="round" stroke="currentColor" strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} />
            </svg>
          </span>
        </RT.Trigger>
        <RT.Portal>
          <RT.Content side="bottom" sideOffset={6} className="surface z-[80] px-2.5 py-1.5 text-[12.5px] tabular-nums">
            上下文已用 {Math.round(pct)}%
            <div className="text-muted">
              {fmt(c.used)} / {fmt(c.size)} tokens
            </div>
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}
