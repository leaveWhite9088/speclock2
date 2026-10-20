import * as RP from '@radix-ui/react-popover';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const Popover = RP.Root;
export const PopoverTrigger = RP.Trigger;
export const PopoverAnchor = RP.Anchor;

/** Floating panel. Radix closes it on outside click and Escape. */
export function PopoverContent({ className, ...rest }: ComponentProps<typeof RP.Content>) {
  return (
    <RP.Portal>
      <RP.Content
        align="start"
        sideOffset={6}
        className={cn('surface z-40 w-(--radix-popover-trigger-width) min-w-60 p-1.5', className)}
        {...rest}
      />
    </RP.Portal>
  );
}

/** A row in a menu-style popover. */
export function MenuItem({ className, ...rest }: ComponentProps<'button'>) {
  return (
    <button
      type="button"
      className={cn('menu-item', className)}
      {...rest}
    />
  );
}
