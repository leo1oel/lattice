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
  const shownKey = useRef<string | null>(null);
  const load = useCallback((key: string, request: () => Promise<T>) => {
    const current = ++generation.current;
    shownKey.current = key;
    setState({ key, value: null, error: "", loading: true });
    void request().then(
      (value) => { if (generation.current === current) setState({ key, value, error: "", loading: false }); },
      (reason) => { if (generation.current === current) setState({ key, value: null, error: toMessage(reason), loading: false }); },
    );
  }, []);
  /**
   * Read `key` again behind what is shown: the last answer stays until the new
   * one arrives, and is replaced only when it differs (or by the first answer
   * when `key` is not the one shown).
   */
  const revalidate = useCallback((key: string, request: () => Promise<T>) => {
    if (shownKey.current !== key) {
      load(key, request);
      return;
    }
    const current = ++generation.current;
    void request().then(
      (value) => {
        if (generation.current !== current) return;
        setState((shown) => (!shown.loading && !shown.error && JSON.stringify(shown.value) === JSON.stringify(value)
          ? shown
          : { key, value, error: "", loading: false }));
      },
      (reason) => {
        if (generation.current !== current) return;
        setState((shown) => (shown.value === null ? { key, value: null, error: toMessage(reason), loading: false } : { ...shown, loading: false }));
      },
    );
  }, [load]);
  const clear = useCallback(() => {
    generation.current += 1;
    shownKey.current = null;
    setState(IDLE);
  }, []);
  return { ...state, load, revalidate, clear };
}
