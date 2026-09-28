import { useEffect, type RefObject } from "react";
import { useLatestRef } from "./use-latest-ref";

/**
 * Attach a wheel handler that can actually call `preventDefault()`.
 *
 * React (17+) delegates `onWheel` through a passive root listener, so
 * `preventDefault()` inside the prop is a no-op: the surrounding scroll
 * container keeps scrolling underneath scroll-to-zoom controls. The fix is a
 * native listener registered with `{ passive: false }` — the same pattern
 * pdf-viewer.tsx uses for ctrl+wheel zoom.
 *
 * The handler is kept in a ref so callers can pass a fresh closure every
 * render without re-attaching the listener.
 */
export function useNonPassiveWheel(
  ref: RefObject<HTMLElement | null>,
  handler: (event: WheelEvent) => void,
): void {
  const handlerRef = useLatestRef(handler);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => handlerRef.current(event);
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [handlerRef, ref]);
}
