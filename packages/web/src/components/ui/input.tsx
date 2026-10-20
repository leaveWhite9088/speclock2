import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** The one text-field look; Select shares its border and focus ring. */
export const fieldClass =
  'field h-8 w-full px-2.5';

/** Grey while empty (or unchanged), white once filled (or changed): pass `filled` to say what "filled" means. */
export function Input({ className, filled, ...rest }: InputHTMLAttributes<HTMLInputElement> & { filled?: boolean }) {
  const on = filled ?? String(rest.value ?? rest.defaultValue ?? '') !== '';
  return <input autoComplete="off" data-filled={on} className={cn(fieldClass, className)} {...rest} />;
}
