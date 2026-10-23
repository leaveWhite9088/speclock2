import { create } from 'zustand';

/** `sel` is DISPATCHER or an executor's key ("project~id"). */
export const DISPATCHER = '@dispatcher';

/** A running executor: when its task started (this page's clock). */
export interface Activity {
  startedAt: number;
}

interface UiState {
  /** Running executors, by key ("project~id"). */
  activity: Record<string, Activity>;
  setActivity: (key: string, a: Activity | null) => void;
  project: string;
  sel: string;
  drawer: boolean;
  /** SSE connection to the backend. */
  conn: 'connecting' | 'on' | 'off';
  /** Bumped when the conversation on screen must be read again (a session was switched or created). */
  conversationVersion: number;
  setProject: (id: string) => void;
  select: (key: string) => void;
  setDrawer: (open: boolean) => void;
  setConn: (c: UiState['conn']) => void;
  reloadConversation: () => void;
}

export const useUi = create<UiState>((set) => ({
  activity: {},
  setActivity: (key, a) =>
    set((s) => {
      const next = { ...s.activity };
      if (a) next[key] = a;
      else delete next[key];
      return { activity: next };
    }),
  project: localStorage.getItem('project') ?? '',
  sel: DISPATCHER,
  drawer: false,
  conn: 'connecting',
  conversationVersion: 0,
  setProject: (id) => {
    localStorage.setItem('project', id);
    set({ project: id, sel: DISPATCHER });
  },
  select: (key) => set({ sel: key }),
  setDrawer: (open) => set({ drawer: open }),
  setConn: (conn) => set({ conn }),
  reloadConversation: () => set((s) => ({ conversationVersion: s.conversationVersion + 1 })),
}));
