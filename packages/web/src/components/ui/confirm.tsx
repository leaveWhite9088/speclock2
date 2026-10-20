import * as AD from '@radix-ui/react-alert-dialog';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button } from './button';

interface Options {
  title: string;
  description?: ReactNode;
  confirmText?: string;
  danger?: boolean;
}
type Confirm = (o: Options) => Promise<boolean>;

const Ctx = createContext<Confirm>(() => Promise.resolve(false));

/** `const confirm = useConfirm(); if (!(await confirm({ title }))) return;` replaces window.confirm. */
export const useConfirm = () => useContext(Ctx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<Options | null>(null);
  const resolver = useRef<(ok: boolean) => void>(() => {});

  const confirm = useCallback<Confirm>((o) => {
    setOpts(o);
    return new Promise<boolean>((res) => {
      resolver.current = res;
    });
  }, []);
  const settle = (ok: boolean) => {
    resolver.current(ok);
    setOpts(null);
  };

  return (
    <Ctx.Provider value={confirm}>
      {children}
      <AD.Root open={opts !== null} onOpenChange={(o) => !o && settle(false)}>
        <AD.Portal>
          <AD.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <AD.Content className="fixed top-1/2 left-1/2 z-50 w-[min(420px,94vw)] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-raised p-5 shadow-pop">
            <AD.Title className="m-0 text-base font-semibold">{opts?.title}</AD.Title>
            <AD.Description className="mt-2 mb-4 whitespace-pre-wrap text-[13px] text-ink-2">{opts?.description}</AD.Description>
            <div className="flex justify-end gap-2">
              <AD.Cancel asChild>
                <Button>取消</Button>
              </AD.Cancel>
              <AD.Action asChild>
                <Button variant="primary" className={opts?.danger ? 'bg-danger text-white' : ''} onClick={() => settle(true)}>
                  {opts?.confirmText ?? '确定'}
                </Button>
              </AD.Action>
            </div>
          </AD.Content>
        </AD.Portal>
      </AD.Root>
    </Ctx.Provider>
  );
}
