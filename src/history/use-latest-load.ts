import { useCallback, useRef, useState } from "react";
import { toMessage } from "../app-utils";

type LatestLoad<T> = { key: string | null; value: T | null; error: string; loading: boolean };

const IDLE = { key: null, value: null, error: "", loading: false };

/**
 * One keyed async load at a time, for "click a row to show its detail" panels.
 * Starting another load, or clearing, makes any earlier answer stale, so a
 * slow response for the previous row can never replace the current one.
 */
export function useLatestLoad<T>() {
  const [state, setState] = useState<LatestLoad<T>>(IDLE);
  const generation = useRef(0);
  const load = useCallback((key: string, request: () => Promise<T>) => {
    const current = ++generation.current;
    setState({ key, value: null, error: "", loading: true });
    void request().then(
      (value) => { if (generation.current === current) setState({ key, value, error: "", loading: false }); },
      (reason) => { if (generation.current === current) setState({ key, value: null, error: toMessage(reason), loading: false }); },
    );
  }, []);
  const clear = useCallback(() => {
    generation.current += 1;
    setState(IDLE);
  }, []);
  return { ...state, load, clear };
}
