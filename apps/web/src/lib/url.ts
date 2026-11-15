import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

/** Filter state lives in the URL so a link reproduces the exact view. */
export function useParam(name: string, fallback = ''): [string, (v: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const value = params.get(name) ?? fallback;
  const set = useCallback(
    (v: string | null) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (v === null || v === '' || v === fallback) next.delete(name);
          else next.set(name, v);
          return next;
        },
        { replace: true },
      ),
    [name, fallback, setParams],
  );
  return [value, set];
}

export function useBoolParam(name: string): [boolean, (v: boolean) => void] {
  const [v, set] = useParam(name);
  return [v === '1', (b: boolean) => set(b ? '1' : null)];
}

/** Keep `run` (and only it) when navigating between screens. */
export function useRunLink() {
  const [params] = useSearchParams();
  const run = params.get('run');
  return (path: string, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams(extra);
    if (run && !p.has('run')) p.set('run', run);
    const s = p.toString();
    return s ? `${path}?${s}` : path;
  };
}
