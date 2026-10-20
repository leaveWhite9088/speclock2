import * as RS from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fieldClass } from './input';

export interface SelectOption {
  value: string;
  label: string;
}

// Radix forbids an empty-string item value, so "" (the default choice) travels as this marker.
const EMPTY = '__empty__';

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** White once the choice differs from the default one. */
  filled?: boolean;
  className?: string;
}

/** Same look as Input, with a list that matches the page instead of the operating system's. */
export function Select({ value, onChange, options, placeholder, disabled, filled, className }: Props) {
  const shown = options.some((o) => o.value === value) ? (value === '' ? EMPTY : value) : undefined;
  return (
    <RS.Root value={shown} onValueChange={(v) => onChange(v === EMPTY ? '' : v)} disabled={disabled}>
      <RS.Trigger data-filled={Boolean(filled)} className={cn(fieldClass, 'flex items-center justify-between gap-2 text-left disabled:opacity-60', className)}>
        <span className="min-w-0 flex-1 truncate">
          <RS.Value placeholder={placeholder} />
        </span>
        <RS.Icon>
          <ChevronDown className="size-3.5 text-muted" />
        </RS.Icon>
      </RS.Trigger>
      <RS.Portal>
        <RS.Content
          position="popper"
          sideOffset={4}
          className="surface z-[70] max-h-72 min-w-(--radix-select-trigger-width) overflow-hidden p-1.5"
        >
          <RS.Viewport>
            {options.map((o) => (
              <RS.Item
                key={o.value || EMPTY}
                value={o.value === '' ? EMPTY : o.value}
                className="relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pr-7 pl-2.5 text-[13.5px] outline-none data-highlighted:bg-hover"
              >
                <RS.ItemText>{o.label}</RS.ItemText>
                <RS.ItemIndicator className="absolute right-2">
                  <Check className="size-3.5" />
                </RS.ItemIndicator>
              </RS.Item>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
}
