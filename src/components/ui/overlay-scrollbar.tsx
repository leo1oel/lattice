import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  calculateOverlayAxisGeometry,
  type OverlayAxisGeometry,
  OVERLAY_SCROLLBAR_TRACK_INSET,
} from "./overlay-scrollbar-geometry";
import "./scroll-area.css";

type OverlayScrollbarsProps = {
  /**
   * Resolves the scrolling element. A new function identity re-attaches the
   * listeners, which is how callers follow a viewport they replace (the PDF
   * viewer builds a fresh one per document).
   */
  getViewport: () => HTMLElement | null;
};

type Axis = "x" | "y";

type AxisFlags = { canScrollEnd: boolean; canScrollStart: boolean };

const NO_OVERFLOW: AxisFlags = { canScrollEnd: false, canScrollStart: false };

const SCROLL_IDLE_MS = 180;
const MAX_VIEWPORT_ATTACH_FRAMES = 60;

function sameFlags(a: AxisFlags, b: AxisFlags) {
  return a.canScrollEnd === b.canScrollEnd && a.canScrollStart === b.canScrollStart;
}

function toFlags({ canScrollEnd, canScrollStart }: AxisFlags): AxisFlags {
  return { canScrollEnd, canScrollStart };
}

function trackLength(track: HTMLElement | null, axis: Axis) {
  if (!track) return 0;
  return axis === "y" ? track.clientHeight : track.clientWidth;
}

function readAxis(viewport: HTMLElement, track: HTMLElement | null, axis: Axis) {
  return calculateOverlayAxisGeometry(axis === "y"
    ? {
      content: viewport.scrollHeight,
      offset: viewport.scrollTop,
      track: trackLength(track, axis),
      viewport: viewport.clientHeight,
    }
    : {
      content: viewport.scrollWidth,
      offset: viewport.scrollLeft,
      track: trackLength(track, axis),
      viewport: viewport.clientWidth,
    });
}

// The thumb is written straight to the DOM: a PDF scrolls while pages render,
// and re-rendering this component on every frame would compete with that.
function applyThumb(track: HTMLElement | null, axis: Axis, geometry: OverlayAxisGeometry) {
  const thumb = track?.firstElementChild;
  if (!(thumb instanceof HTMLElement)) return;
  const size = `${geometry.thumbSize}px`;
  const transform = axis === "y"
    ? `translate3d(-2px, ${geometry.thumbOffset}px, 0)`
    : `translate3d(${geometry.thumbOffset}px, -2px, 0)`;
  if (axis === "y") {
    if (thumb.style.height !== size) thumb.style.height = size;
  } else if (thumb.style.width !== size) {
    thumb.style.width = size;
  }
  if (thumb.style.transform !== transform) thumb.style.transform = transform;
}

/**
 * Draws the Lattice hover-reveal scrollbars over a scroller that owns its own
 * native viewport, on both axes. Unlike `ExternalScrollbar` this reveals on the
 * bar itself rather than on the whole surface, which is what the editor's
 * scrollbar does — a document surface should not light up its edges just
 * because the pointer crossed the page.
 *
 * The scroller must hide its native scrollbars and the nearest positioned
 * ancestor must be the box the bars should span.
 */
export function OverlayScrollbars({ getViewport }: OverlayScrollbarsProps) {
  const verticalRef = useRef<HTMLDivElement | null>(null);
  const horizontalRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{
    axis: Axis;
    origin: number;
    pointerId: number;
    scrollPerPixel: number;
    start: number;
  } | null>(null);
  const [vertical, setVertical] = useState(NO_OVERFLOW);
  const [horizontal, setHorizontal] = useState(NO_OVERFLOW);
  const [scrolling, setScrolling] = useState(false);

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      setVertical(NO_OVERFLOW);
      setHorizontal(NO_OVERFLOW);
      return;
    }
    const y = readAxis(viewport, verticalRef.current, "y");
    const x = readAxis(viewport, horizontalRef.current, "x");
    applyThumb(verticalRef.current, "y", y);
    applyThumb(horizontalRef.current, "x", x);
    setVertical((current) => sameFlags(current, y) ? current : toFlags(y));
    setHorizontal((current) => sameFlags(current, x) ? current : toFlags(x));
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  // A track with no overflow is `display: none`, so it measures as zero length
  // and the thumb it would need cannot be sized until it is laid out again.
  // Re-measure once the flags have committed; the guards above make this settle
  // after one pass instead of looping.
  useLayoutEffect(() => {
    measure();
  }, [horizontal, measure, vertical]);

  useEffect(() => {
    let cancelled = false;
    let retryFrame: number | null = null;
    let attachAttempts = 0;
    let resizeObserver: ResizeObserver | null = null;
    let viewport: HTMLElement | null = null;

    const stopScrolling = () => {
      idleTimerRef.current = null;
      if (!dragRef.current) setScrolling(false);
    };
    const markScrolling = () => {
      scheduleMeasure();
      setScrolling(true);
      if (idleTimerRef.current != null) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = window.setTimeout(stopScrolling, SCROLL_IDLE_MS);
    };

    const attach = () => {
      if (cancelled) return;
      viewport = getViewport();
      if (!viewport) {
        // Tests polyfill rAF as a timeout; cap the retries so a viewport that
        // never appears cannot spin.
        attachAttempts += 1;
        if (attachAttempts < MAX_VIEWPORT_ATTACH_FRAMES) {
          retryFrame = requestAnimationFrame(attach);
        }
        return;
      }
      viewportRef.current = viewport;
      viewport.addEventListener("scroll", markScrolling, { passive: true });
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(scheduleMeasure);
        resizeObserver.observe(viewport);
        // The scrolled content: a PDF's page column resizes on every zoom or
        // refit without the viewport itself changing size.
        for (const child of viewport.children) {
          if (child instanceof HTMLElement) resizeObserver.observe(child);
        }
      }
      scheduleMeasure();
    };

    attach();
    return () => {
      cancelled = true;
      if (retryFrame != null) cancelAnimationFrame(retryFrame);
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (idleTimerRef.current != null) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      viewport?.removeEventListener("scroll", markScrolling);
      resizeObserver?.disconnect();
      viewportRef.current = null;
    };
  }, [getViewport, scheduleMeasure]);

  const setOffset = (axis: Axis, value: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (axis === "y") viewport.scrollTop = value;
    else viewport.scrollLeft = value;
  };

  const handlePointerDown = (axis: Axis, event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const track = event.currentTarget;
    const geometry = readAxis(viewport, track, axis);
    if (!geometry.overflow) return;
    event.preventDefault();
    event.stopPropagation();
    const point = axis === "y" ? event.clientY : event.clientX;
    const onThumb = event.target instanceof HTMLElement
      && event.target.dataset.slot === "scroll-area-thumb";
    if (!onThumb) {
      const bounds = track.getBoundingClientRect();
      const desired = point
        - (axis === "y" ? bounds.top : bounds.left)
        - OVERLAY_SCROLLBAR_TRACK_INSET
        - geometry.thumbSize / 2;
      const ratio = geometry.travel > 0
        ? Math.min(1, Math.max(0, desired / geometry.travel))
        : 0;
      setOffset(axis, geometry.maxOffset * ratio);
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

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = drag.axis === "y" ? event.clientY : event.clientX;
    setOffset(drag.axis, drag.start + (point - drag.origin) * drag.scrollPerPixel);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setScrolling(false);
  };

  // The bars cover a strip of the surface, so a wheel over one must still
  // scroll the document instead of stopping dead.
  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    // A pinch arrives as a modified wheel; scrolling the document instead of
    // letting the surface zoom would be the wrong answer.
    if (!viewport || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    viewport.scrollTop += event.deltaY;
    viewport.scrollLeft += event.deltaX;
  };

  return (
    <>
      <div
        ref={verticalRef}
        aria-hidden="true"
        className="lattice-scrollbar overlay-scrollbar"
        data-cross-axis={horizontal.canScrollEnd || horizontal.canScrollStart ? "" : undefined}
        data-orientation="vertical"
        data-overflow-y-end={vertical.canScrollEnd ? "" : undefined}
        data-overflow-y-start={vertical.canScrollStart ? "" : undefined}
        data-scrolling={scrolling ? "" : undefined}
        onPointerCancel={endDrag}
        onPointerDown={(event) => handlePointerDown("y", event)}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onWheel={handleWheel}
      >
        <div className="lattice-scrollbar-thumb" data-slot="scroll-area-thumb" />
      </div>
      <div
        ref={horizontalRef}
        aria-hidden="true"
        className="lattice-scrollbar overlay-scrollbar"
        data-cross-axis={vertical.canScrollEnd || vertical.canScrollStart ? "" : undefined}
        data-orientation="horizontal"
        data-overflow-x-end={horizontal.canScrollEnd ? "" : undefined}
        data-overflow-x-start={horizontal.canScrollStart ? "" : undefined}
        data-scrolling={scrolling ? "" : undefined}
        onPointerCancel={endDrag}
        onPointerDown={(event) => handlePointerDown("x", event)}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onWheel={handleWheel}
      >
        <div className="lattice-scrollbar-thumb" data-slot="scroll-area-thumb" />
      </div>
    </>
  );
}
