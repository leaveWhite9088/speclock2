import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** The one text-field look; Select shares its border and focus ring. */
export const fieldClass =
  'h-8 w-full rounded-md border border-line-2 bg-raised px-2.5 text-[13.5px] placeholder:text-muted hover:border-ink/30 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/15';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input autoComplete="off" className={cn(fieldClass, className)} {...rest} />;
}
