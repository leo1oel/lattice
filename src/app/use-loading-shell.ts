import { useEffect, useRef, useState } from "react";

const LOADING_SHELL_DELAY_MS = 150;
/** Once shown, a shell stays this long, so a load ending just after the delay cannot flash it. */
const LOADING_SHELL_MIN_SHOWN_MS = 300;

/**
 * Whether the loading shell (`tool-loading-shell.tsx`) of the lazily loaded
 * tool whose opening `pending` tracks is on screen: from 150 ms into the
 * opening, and then for at least 300 ms, over the tool if it arrives sooner.
 */
export function useLoadingShell(pending: boolean) {
  const [shown, setShown] = useState(false);
  const shownAtRef = useRef(0);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => {
      shownAtRef.current = Date.now();
      setShown(true);
    }, LOADING_SHELL_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pending]);
  useEffect(() => {
    if (pending || !shown) return;
    const left = shownAtRef.current + LOADING_SHELL_MIN_SHOWN_MS - Date.now();
    const timer = window.setTimeout(() => setShown(false), Math.max(0, left));
    return () => window.clearTimeout(timer);
  }, [pending, shown]);
  return shown;
}
