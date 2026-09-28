import { useEffect, useRef } from "react";

/**
 * Keeps Enter from acting while an IME candidate is being accepted. WebKit can
 * emit compositionend immediately before the Enter that accepted the
 * candidate, so the guard stays up for the rest of that event turn.
 */
export function useCompositionGuard() {
  const composingRef = useRef(false);
  const clearTimerRef = useRef<number | null>(null);
  const cancelClear = () => {
    if (clearTimerRef.current !== null) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = null;
  };
  useEffect(() => () => {
    if (clearTimerRef.current !== null) window.clearTimeout(clearTimerRef.current);
  }, []);
  return {
    compositionProps: {
      onCompositionStart: () => {
        cancelClear();
        composingRef.current = true;
      },
      onCompositionEnd: () => {
        cancelClear();
        clearTimerRef.current = window.setTimeout(() => {
          composingRef.current = false;
          clearTimerRef.current = null;
        }, 0);
      },
    },
    isComposing: (event: React.KeyboardEvent) => (
      event.nativeEvent.isComposing
      || event.keyCode === 229
      || event.key === "Process"
      || composingRef.current
    ),
  };
}
