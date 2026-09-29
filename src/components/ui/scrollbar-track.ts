import { useCallback, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { EXTERNAL_SCROLLBAR_TRACK_INSET, type ScrollAxisGeometry } from "./external-scrollbar-geometry";

// Behaviour shared by the scrollbars drawn over a scroller Lattice cannot wrap
// in ScrollArea: `OverlayScrollbars` (the PDF viewer) and `ExternalScrollbar`
// (virtualized trees and Univer's sidebar).

export type Axis = "x" | "y";

const MAX_VIEWPORT_ATTACH_FRAMES = 60;

/**
 * Resolves the scroll owner and hands it to `attach` once it exists, retrying
 * once per frame. The retries are capped: tests polyfill rAF as a timeout, and
 * a viewport that never appears (a lookup the test mocks never satisfy) must
 * not spin. Returns the teardown, which also runs `attach`'s own.
 */
export function attachToViewport(
  getViewport: () => HTMLElement | null,
  attach: (viewport: HTMLElement) => () => void,
): () => void {
  let detach: (() => void) | undefined;
  let retryFrame: number | null = null;
  let attempts = 0;
  const tryAttach = () => {
    retryFrame = null;
    const viewport = getViewport();
    if (viewport) detach = attach(viewport);
    else if (++attempts < MAX_VIEWPORT_ATTACH_FRAMES) retryFrame = requestAnimationFrame(tryAttach);
  };
  tryAttach();
  return () => {
    if (retryFrame != null) cancelAnimationFrame(retryFrame);
    detach?.();
  };
}

function setScrollOffset(viewport: HTMLElement, axis: Axis, value: number) {
  if (axis === "y") viewport.scrollTop = value;
  else viewport.scrollLeft = value;
}

/**
 * Pointer dragging on a scrollbar track. A press on the track (not the thumb)
 * first jumps so the thumb centers under the pointer; the drag then maps
 * pointer travel onto scroll travel at the ratio captured at the press. The
 * track keeps pointer capture until release, and `setScrolling` holds the bar
 * revealed for the whole gesture.
 */
export function useScrollbarDrag(
  viewportRef: RefObject<HTMLElement | null>,
  setScrolling: (scrolling: boolean) => void,
) {
  const dragRef = useRef<{
    axis: Axis;
    origin: number;
    pointerId: number;
    scrollPerPixel: number;
    start: number;
  } | null>(null);

  const begin = (event: ReactPointerEvent<HTMLElement>, axis: Axis, geometry: ScrollAxisGeometry) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    event.preventDefault();
    const track = event.currentTarget;
    const point = axis === "y" ? event.clientY : event.clientX;
    const onThumb = event.target instanceof HTMLElement && event.target.dataset.slot === "scroll-area-thumb";
    if (!onThumb && geometry.travel > 0) {
      const bounds = track.getBoundingClientRect();
      const desired = point
        - (axis === "y" ? bounds.top : bounds.left)
        - EXTERNAL_SCROLLBAR_TRACK_INSET
        - geometry.thumbSize / 2;
      setScrollOffset(viewport, axis, geometry.maxOffset * Math.min(1, Math.max(0, desired / geometry.travel)));
    }
    dragRef.current = {
      axis,
      origin: point,
      pointerId: event.pointerId,
      scrollPerPixel: geometry.travel > 0 ? geometry.maxOffset / geometry.travel : 0,
      start: axis === "y" ? viewport.scrollTop : viewport.scrollLeft,
    };
    track.setPointerCapture(event.pointerId);
    setScrolling(true);
  };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const viewport = viewportRef.current;
    const drag = dragRef.current;
    if (!viewport || !drag || drag.pointerId !== event.pointerId) return;
    const point = drag.axis === "y" ? event.clientY : event.clientX;
    setScrollOffset(viewport, drag.axis, drag.start + (point - drag.origin) * drag.scrollPerPixel);
  };

  const end = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setScrolling(false);
  };

  return { begin, move, end, dragRef };
}

/**
 * The scroll owner a drawn scrollbar follows. Attaches to it once it exists,
 * coalesces re-measures into one per frame, and calls `setScrolling` from each
 * scroll until `idleMs` after the last one; a drag in progress holds it.
 * `watch` adds the owner-specific listeners and observers and returns their
 * teardown. Attached in a layout effect: a scrollbar often mounts because its
 * viewport is already in the DOM (Univer's All Functions list), and a later
 * attach would leave a committed bar that misses the first hover.
 */
export function useScrollbarViewport(
  getViewport: () => HTMLElement | null,
  measure: (viewport: HTMLElement | null) => void,
  idleMs: number,
  watch: (viewport: HTMLElement, scheduleMeasure: () => void) => () => void,
  setScrolling: (scrolling: boolean) => void,
) {
  const viewportRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drag = useScrollbarDrag(viewportRef, setScrolling);
  const { dragRef } = drag;

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure(viewportRef.current);
    });
  }, [measure]);

  useLayoutEffect(() => {
    const markScrolling = () => {
      scheduleMeasure();
      setScrolling(true);
      if (idleTimerRef.current != null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        idleTimerRef.current = null;
        if (!dragRef.current) setScrolling(false);
      }, idleMs);
    };
    const detach = attachToViewport(getViewport, (viewport) => {
      viewportRef.current = viewport;
      viewport.addEventListener("scroll", markScrolling, { passive: true });
      const unwatch = watch(viewport, scheduleMeasure);
      scheduleMeasure();
      return () => {
        viewport.removeEventListener("scroll", markScrolling);
        unwatch();
      };
    });
    return () => {
      detach();
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      if (idleTimerRef.current != null) clearTimeout(idleTimerRef.current);
      frameRef.current = idleTimerRef.current = null;
      viewportRef.current = null;
    };
  }, [dragRef, getViewport, idleMs, scheduleMeasure, setScrolling, watch]);

  return { viewportRef, drag };
}
