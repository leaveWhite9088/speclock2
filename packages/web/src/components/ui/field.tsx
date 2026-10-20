import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Form row: label on the left, control on the right, optional one-line hint under the control. */
export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn('grid grid-cols-[4.2em_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-[12.5px] text-muted', className)}>
      <span>{label}</span>
      {children}
      {hint ? (
        <small className="col-start-2 min-w-0 truncate text-[12.5px]" title={typeof hint === 'string' ? hint : undefined}>
          {hint}
        </small>
      ) : null}
    </label>
  );
}
