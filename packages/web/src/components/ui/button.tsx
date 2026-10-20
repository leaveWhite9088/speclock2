import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent text-[13.5px] transition-colors disabled:pointer-events-none disabled:opacity-45',
  {
    variants: {
      variant: {
        primary: 'bg-ink font-semibold text-bg hover:opacity-90',
        outline: 'border-line-2 hover:bg-hover',
        ghost: 'hover:bg-hover',
        dashed: 'border-dashed border-line-2 text-ink-2 hover:border-solid hover:text-ink',
        danger: 'text-danger hover:bg-hover',
        link: 'h-auto px-0 text-[12.5px] font-medium text-accent hover:underline',
        linkDanger: 'h-auto px-0 text-[12.5px] font-medium text-danger hover:underline',
      },
      size: {
        md: 'h-8 px-3',
        sm: 'h-7 px-2.5',
        icon: 'size-[30px] p-0 text-muted hover:text-ink',
        iconSm: 'size-6 p-0 text-muted hover:text-ink [&_svg]:size-3.5',
        none: '',
      },
    },
    defaultVariants: { variant: 'outline', size: 'md' },
  },
);

type Props = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = 'button', ...rest }: Props) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...rest} />;
}
