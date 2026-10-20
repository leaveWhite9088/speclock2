import { useCallback } from 'react';
import { useConfirm } from '@/components/ui/confirm';

/**
 * Try an action without force; if something is still running the backend says so ("… running …"),
 * name it and ask again. Resolves false when the user declines the second question.
 */
export function useForceable() {
  const confirm = useConfirm();
  return useCallback(
    async (label: string, run: (force: boolean) => Promise<unknown>): Promise<boolean> => {
      try {
        await run(false);
      } catch (err) {
        const message = (err as Error).message;
        if (!/running/.test(message)) throw err;
        const ok = await confirm({ title: label, description: `还有任务在运行：${message}\n\n继续会中断它们。确定吗？`, confirmText: '继续', danger: true });
        if (!ok) return false;
        await run(true);
      }
      return true;
    },
    [confirm],
  );
}
