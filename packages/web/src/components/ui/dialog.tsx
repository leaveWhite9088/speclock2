import * as RD from '@radix-ui/react-dialog';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export const Dialog = RD.Root;

export function DialogContent({
  title,
  description,
  className,
  children,
  ...rest
}: { title: string; description?: ReactNode } & Omit<ComponentProps<typeof RD.Content>, 'title'>) {
  return (
    <RD.Portal>
      <RD.Overlay className="fixed inset-0 z-50 bg-black/40" />
      <RD.Content
        className={cn('fixed top-1/2 left-1/2 z-50 w-[min(460px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-raised p-5 shadow-pop', className)}
        {...rest}
      >
        <RD.Title className="m-0 text-base font-semibold">{title}</RD.Title>
        {description ? (
          <RD.Description className="mt-1 mb-2 text-[12.5px] text-muted">{description}</RD.Description>
        ) : (
          <RD.Description className="sr-only">{title}</RD.Description>
        )}
        {children}
      </RD.Content>
    </RD.Portal>
  );
}
