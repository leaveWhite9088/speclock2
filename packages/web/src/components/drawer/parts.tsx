import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export function SectionHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between text-[12.5px] font-semibold">
      <span>{title}</span>
      {action}
    </div>
  );
}

/** Submit button, "undo" link and the draft note under a draft-backed form. */
export function DraftActions({ dirty, valid, submitText, onUndo }: { dirty: boolean; valid: boolean; submitText: string; onUndo: () => void }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-3">
      <Button type="submit" variant="primary" className="px-4" disabled={!dirty || !valid}>
        {submitText}
      </Button>
      {dirty ? (
        <Button variant="link" onClick={onUndo}>
          撤销修改
        </Button>
      ) : null}
      {dirty ? <span className="basis-full text-[12.5px] text-muted">有未提交的修改，已存为草稿</span> : null}
    </div>
  );
}
