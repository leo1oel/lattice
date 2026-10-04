import { useEffect, useState } from "react";

const LOADING_SHELL_DELAY_MS = 150;

/**
 * Whether the opening of a lazily loaded tool that `pending` tracks has run
 * long enough for its loading shell (`tool-loading-shell.tsx`). It stays true
 * through the commit that ends `pending`, which is the one that shows the tool
 * in the shell's place.
 */
export function useLoadingShell(pending: boolean) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!pending) return;
    const timer = window.setTimeout(() => setLate(true), LOADING_SHELL_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      setLate(false);
    };
  }, [pending]);
  return late;
}
