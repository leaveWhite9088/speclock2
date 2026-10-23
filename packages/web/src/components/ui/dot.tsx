import { cn } from '@/lib/utils';

export type DotState = 'idle' | 'on' | 'busy' | 'off';

/** Status dot: grey idle, green on, blue breathing (grows, glows, fades) busy, red off. */
export function Dot({ state = 'idle', className }: { state?: DotState; className?: string }) {
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        state === 'idle' && 'bg-line-2',
        state === 'on' && 'bg-ok',
        state === 'off' && 'bg-danger',
        state === 'busy' && 'animate-[breathe_1.4s_ease-in-out_infinite] bg-accent motion-reduce:animate-none motion-reduce:ring-4 motion-reduce:ring-accent/25',
        className,
      )}
    />
  );
}
