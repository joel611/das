import { useCallback, useEffect, useRef, useState } from "react";

/** Run `fn` now and every `ms`; keeps the last good value and reports the latest error. */
export function usePoll<T>(fn: () => Promise<T>, ms = 2000) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<Error>();
  const latest = useRef(fn);
  latest.current = fn;

  const refresh = useCallback(async () => {
    try {
      setData(await latest.current());
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), ms);
    return () => clearInterval(id);
  }, [refresh, ms]);

  return { data, error, refresh };
}
