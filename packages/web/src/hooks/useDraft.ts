import { useCallback, useEffect, useState } from 'react';

/**
 * Form values kept as a draft in localStorage, so a reload or a switch to another member does not lose
 * edits. `saved` is what is in effect now; `secret` fields are never written to the draft.
 */
export function useDraft<T extends Record<string, string>>(key: string, saved: T, secret: (keyof T)[] = []) {
  const savedSig = JSON.stringify(saved);
  const read = useCallback((): T => {
    try {
      return { ...saved, ...(JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<T>) };
    } catch {
      return saved; // a broken draft is just no draft
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, savedSig]);

  const [values, setValues] = useState<T>(read);
  useEffect(() => setValues(read()), [read]);

  const differs = (a: string | undefined, b: string | undefined) => (a ?? '').trim() !== (b ?? '').trim();
  const dirty = (Object.keys(saved) as (keyof T)[]).some((k) => differs(values[k], saved[k]));

  const set = (patch: Partial<T>) =>
    setValues((v) => {
      const next = { ...v, ...patch };
      const keep = Object.fromEntries((Object.keys(saved) as (keyof T)[]).filter((k) => !secret.includes(k) && differs(next[k], saved[k])).map((k) => [k, next[k]]));
      if (Object.keys(keep).length) localStorage.setItem(key, JSON.stringify(keep));
      else localStorage.removeItem(key);
      return next;
    });

  const undo = () => {
    localStorage.removeItem(key);
    setValues(saved);
  };
  const clear = () => localStorage.removeItem(key);

  return { values, set, dirty, undo, clear };
}
