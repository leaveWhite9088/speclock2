import { cn } from '@/lib/utils';

export type DotState = 'idle' | 'on' | 'busy' | 'off';

/** Status dot: grey idle, green on, blue pulsing busy, red off. */
export function Dot({ state = 'idle', className }: { state?: DotState; className?: string }) {
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        state === 'idle' && 'bg-line-2',
        state === 'on' && 'bg-ok',
        state === 'off' && 'bg-danger',
        state === 'busy' && 'animate-pulse bg-accent motion-reduce:animate-none',
        className,
      )}
    />
  );
}
