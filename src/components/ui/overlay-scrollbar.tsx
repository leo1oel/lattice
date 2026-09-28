import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { calculateScrollAxisGeometry, type ScrollAxisGeometry } from "./external-scrollbar-geometry";
import { useScrollbarViewport, type Axis } from "./scrollbar-track";
import "./scroll-area.css";

type AxisFlags = { canScrollEnd: boolean; canScrollStart: boolean };

const NO_OVERFLOW: AxisFlags = { canScrollEnd: false, canScrollStart: false };

const SCROLL_IDLE_MS = 180;

/** A 24px minimum thumb; sub-pixel extents are rounding noise from fractional zoom, not overflow. */
const OVERLAY_THUMB = { minThumb: 24, minOverflow: 1 };

function readAxis(viewport: HTMLElement, track: HTMLElement | null, axis: Axis) {
  const y = axis === "y";
  return calculateScrollAxisGeometry({
    content: y ? viewport.scrollHeight : viewport.scrollWidth,
    offset: y ? viewport.scrollTop : viewport.scrollLeft,
    track: track ? (y ? track.clientHeight : track.clientWidth) : 0,
    viewport: y ? viewport.clientHeight : viewport.clientWidth,
  }, OVERLAY_THUMB);
}

// The thumb is written straight to the DOM: a PDF scrolls while pages render,
// and re-rendering this component on every frame would compete with that.
function applyThumb(track: HTMLElement | null, axis: Axis, geometry: ScrollAxisGeometry) {
  const thumb = track?.firstElementChild;
  if (!(thumb instanceof HTMLElement)) return;
  const size = `${geometry.thumbSize}px`;
  const transform = axis === "y"
    ? `translate3d(-2px, ${geometry.thumbOffset}px, 0)`
    : `translate3d(${geometry.thumbOffset}px, -2px, 0)`;
  const sizeProperty = axis === "y" ? "height" : "width";
  if (thumb.style[sizeProperty] !== size) thumb.style[sizeProperty] = size;
  if (thumb.style.transform !== transform) thumb.style.transform = transform;
}

function updateFlags(current: AxisFlags, { canScrollEnd, canScrollStart }: AxisFlags) {
  return current.canScrollEnd === canScrollEnd && current.canScrollStart === canScrollStart
    ? current
    : { canScrollEnd, canScrollStart };
}

const hasOverflow = (flags: AxisFlags) => flags.canScrollEnd || flags.canScrollStart;

/** Which ends of an axis still have content: what the stylesheet reveals on. */
function overflowAttributes(axis: Axis, flags: AxisFlags) {
  return {
    [`data-overflow-${axis}-end`]: flags.canScrollEnd ? "" : undefined,
    [`data-overflow-${axis}-start`]: flags.canScrollStart ? "" : undefined,
  };
}

function watchContent(viewport: HTMLElement, scheduleMeasure: () => void) {
  const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
  resizeObserver?.observe(viewport);
  // The scrolled content: a PDF's page column resizes on every zoom or
  // refit without the viewport itself changing size.
  for (const child of viewport.children) {
    if (child instanceof HTMLElement) resizeObserver?.observe(child);
  }
  return () => resizeObserver?.disconnect();
}

/**
 * Draws the Lattice hover-reveal scrollbars over a scroller that owns its own
 * native viewport, on both axes. Unlike `ExternalScrollbar` this reveals on the
 * bar itself rather than on the whole surface, which is what the editor's
 * scrollbar does — a document surface should not light up its edges just
 * because the pointer crossed the page.
 *
 * The scroller must hide its native scrollbars and the nearest positioned
 * ancestor must be the box the bars should span. A new `getViewport` identity
 * re-attaches the listeners, which is how callers follow a viewport they
 * replace (the PDF viewer builds a fresh one per document).
 */
export function OverlayScrollbars({ getViewport }: { getViewport: () => HTMLElement | null }) {
  const verticalRef = useRef<HTMLDivElement | null>(null);
  const horizontalRef = useRef<HTMLDivElement | null>(null);
  const [vertical, setVertical] = useState(NO_OVERFLOW);
  const [horizontal, setHorizontal] = useState(NO_OVERFLOW);

  const measure = useCallback((viewport: HTMLElement | null) => {
    if (!viewport) {
      setVertical(NO_OVERFLOW);
      setHorizontal(NO_OVERFLOW);
      return;
    }
    const y = readAxis(viewport, verticalRef.current, "y");
    const x = readAxis(viewport, horizontalRef.current, "x");
    applyThumb(verticalRef.current, "y", y);
    applyThumb(horizontalRef.current, "x", x);
    setVertical((current) => updateFlags(current, y));
    setHorizontal((current) => updateFlags(current, x));
  }, []);

  const { viewportRef, scrolling, drag } = useScrollbarViewport(getViewport, measure, SCROLL_IDLE_MS, watchContent);

  // A track with no overflow is `display: none`, so it measures as zero length
  // and the thumb it would need cannot be sized until it is laid out again.
  // Re-measure once the flags have committed; the guards above make this settle
  // after one pass instead of looping.
  useLayoutEffect(() => {
    measure(viewportRef.current);
  }, [horizontal, measure, vertical, viewportRef]);

  const handlePointerDown = (axis: Axis, event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const geometry = readAxis(viewport, event.currentTarget, axis);
    if (!geometry.overflow) return;
    event.stopPropagation();
    drag.begin(event, axis, geometry);
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

  const shared = {
    "aria-hidden": true,
    className: "lattice-scrollbar overlay-scrollbar",
    "data-scrolling": scrolling ? "" : undefined,
    onPointerCancel: drag.end,
    onPointerMove: drag.move,
    onPointerUp: drag.end,
    onWheel: handleWheel,
  } as const;
  return (
    <>
      <div
        ref={verticalRef}
        {...shared}
        data-cross-axis={hasOverflow(horizontal) ? "" : undefined}
        data-orientation="vertical"
        {...overflowAttributes("y", vertical)}
        onPointerDown={(event) => handlePointerDown("y", event)}
      >
        <div className="lattice-scrollbar-thumb" data-slot="scroll-area-thumb" />
      </div>
      <div
        ref={horizontalRef}
        {...shared}
        data-cross-axis={hasOverflow(vertical) ? "" : undefined}
        data-orientation="horizontal"
        {...overflowAttributes("x", horizontal)}
        onPointerDown={(event) => handlePointerDown("x", event)}
      >
        <div className="lattice-scrollbar-thumb" data-slot="scroll-area-thumb" />
      </div>
    </>
  );
}
