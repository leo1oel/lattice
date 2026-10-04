import { useEffect, useRef, useState } from "react";

const LOADING_SHELL_DELAY_MS = 150;
/** Once shown, a shell stays this long, so a load ending just after the delay cannot flash it. */
const LOADING_SHELL_MIN_SHOWN_MS = 300;

/**
 * Whether the loading shell (`tool-loading-shell.tsx`) of the lazily loaded
 * tool whose opening `pending` tracks is on screen: from 150 ms into the
 * opening, and then for at least 300 ms, over the tool if it arrives sooner.
 * `wanted` is whether the tool is still asked for: closing it, or the shell,
 * takes the shell away at once.
 */
export function useLoadingShell(pending: boolean, wanted: boolean) {
  const [shown, setShown] = useState(false);
  if (shown && !wanted) setShown(false);
  const shownAtRef = useRef(0);
  const waiting = pending && wanted;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setTimeout(() => {
      shownAtRef.current = Date.now();
      setShown(true);
    }, LOADING_SHELL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [waiting]);
  useEffect(() => {
    if (waiting || !shown) return;
    const left = shownAtRef.current + LOADING_SHELL_MIN_SHOWN_MS - Date.now();
    const timer = window.setTimeout(() => setShown(false), Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [waiting, shown]);
  return shown;
}
