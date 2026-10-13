import { startTransition, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/**
 * How far below the view the next batch starts drawing: a screen and a half,
 * and never less than a fast trackpad fling covers in the frames a batch
 * takes (a panel a few rows tall would otherwise show the blank spacer).
 */
const LOOKAHEAD_PX = 1200;

/**
 * How many rows of a long list to draw: a first batch, then more each time
 * the reader scrolls near the last one drawn. Rows once drawn stay, so
 * nothing a reader has seen is drawn again or loses its focus or selection;
 * a list of hundreds draws only what has been near the view.
 *
 * `spacer` goes after the rows and stands for the ones not drawn yet, sized
 * from `estimate`, so the scroll bar keeps the whole list's length; scrolled
 * into, it draws the next batch. A new `reset` (another view or filter)
 * starts again from the first batch.
 */
export function useProgressiveRows({ total, reset, scroller, estimate, batch = 24, atLeast = 0 }: {
  total: number;
  reset: string;
  /** The element the list scrolls in. */
  scroller: RefObject<HTMLElement | null>;
  /** A row's usual height in px. */
  estimate: number;
  batch?: number;
  /** Rows that must be drawn whatever the scroll, such as up to one opened from elsewhere. */
  atLeast?: number;
}) {
  const [drawn, setDrawn] = useState({ reset, limit: batch });
  let limit = drawn.limit;
  if (drawn.reset !== reset) {
    setDrawn({ reset, limit: batch });
    limit = batch;
  }
  const shown = Math.min(Math.max(limit, atLeast), total);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const spacer = spacerRef.current;
    if (!spacer || shown >= total) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      // A transition, so React draws the batch in slices between the frames of
      // a scroll; one batch past what this commit drew, however often the
      // observer fires before the next.
      startTransition(() => setDrawn((current) => (
        current.reset === reset ? { reset, limit: Math.max(current.limit, shown + batch) } : current
      )));
    }, { root: scroller.current, rootMargin: `0px 0px ${Math.max(LOOKAHEAD_PX, (scroller.current?.clientHeight ?? 0) * 1.5)}px 0px` });
    observer.observe(spacer);
    return () => observer.disconnect();
  }, [batch, reset, scroller, shown, total]);
  // Never a scroll anchor: rows drawn above it push it down, and a browser
  // holding it in place would carry a reader who jumped into it (the scroll
  // bar dragged down) along with it, batch after batch, to the end.
  const spacerStyle: CSSProperties = { height: (total - shown) * estimate, overflowAnchor: "none" };
  return {
    shown,
    /** The rest of the list, undrawn; null once every row is. */
    spacer: shown < total ? { ref: spacerRef, style: spacerStyle, "aria-hidden": true as const } : null,
  };
}
