import { cn } from '@/lib/utils';

const HARNESS: Record<string, string> = { mcode: 'bg-mcode', dsh: 'bg-dsh', pi: 'bg-pi', opencode: 'bg-opencode', claude: 'bg-claude', codex: 'bg-codex' };

/** CLI × LLM chip: who is running (coloured) and which model it uses. */
export function Tag({ type, llm, faint, className }: { type: string; llm?: string | null; faint?: boolean; className?: string }) {
  return (
    <span title={`${type} · ${llm || '默认模型'}`} className={cn('inline-flex min-w-0 max-w-full items-stretch overflow-hidden rounded-sm border border-line-2 text-[11.5px] leading-none', className)}>
      <span className={cn('shrink-0 px-1.5 py-1 font-mono font-bold text-chip-ink', HARNESS[type] ?? 'bg-other')}>{type}</span>
      <span className={cn('min-w-0 truncate bg-raised px-[7px] py-1', faint ? 'text-muted' : 'text-ink-2')}>{llm || '默认模型'}</span>
    </span>
  );
}
