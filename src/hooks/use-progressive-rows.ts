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
 * into, it draws the next batch. A new `reset` (another search, filter or
 * order) starts again from the first batch.
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
  // A batch taller than the rows it stands for, until the last batch has
  // been laid out: WebKit lays a size container (a paper row is one) out
  // twice, and between the two new rows are shorter, so a list scrolled to its
  // end would get shorter for a moment and pull the reader up. Never a scroll
  // anchor either: rows drawn above it would push it down, and a browser
  // holding it in place would carry the reader with it, batch after batch, to
  // the end of a list they jumped into.
  const done = shown >= total;
  const spacerStyle: CSSProperties = { height: (total - shown + batch) * estimate, overflowAnchor: "none" };
  useEffect(() => {
    const spacer = spacerRef.current;
    if (!done || !spacer) return;
    // Once the frame that drew the last rows has laid them out; written past
    // React, which keeps the same style while every row is drawn.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { spacer.style.height = "0px"; });
    });
    return () => cancelAnimationFrame(frame);
  }, [done, total]);
  return {
    shown,
    /** Rows are left to draw. */
    more: !done,
    /** Goes after the rows: the rest of the list, undrawn. Null for a list one batch holds. */
    spacer: total > batch ? { ref: spacerRef, style: spacerStyle, "aria-hidden": true as const } : null,
    /** Draw every row, for a jump to the end. */
    showAll: () => setDrawn({ reset, limit: total }),
  };
}
