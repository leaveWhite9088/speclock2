import { create } from 'zustand';

interface ToastState {
  message: string;
  show: (message: string) => void;
}

let timer: ReturnType<typeof setTimeout> | undefined;

export const useToast = create<ToastState>((set) => ({
  message: '',
  show: (message) => {
    set({ message });
    clearTimeout(timer);
    timer = setTimeout(() => set({ message: '' }), 4000);
  },
}));

/** Show a short message at the bottom of the page. Usable from anywhere, inside or outside React. */
export const toast = (message: string) => useToast.getState().show(message);

export function Toaster() {
  const message = useToast((s) => s.message);
  if (!message) return null;
  return (
    <div role="status" className="fixed bottom-24 left-1/2 z-[80] max-w-[80vw] -translate-x-1/2 rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] text-bg shadow-pop">
      {message}
    </div>
  );
}
