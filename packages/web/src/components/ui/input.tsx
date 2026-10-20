import type { InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/** The one text-field look; Select shares its border and focus ring. */
export const fieldClass =
  'field h-8 w-full px-2.5';

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input autoComplete="off" className={cn(fieldClass, className)} {...rest} />;
}
