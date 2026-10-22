import { type WheelEvent as ReactWheelEvent, useCallback, useRef, useState } from "react";
import {
  calculateScrollAxisGeometry,
  EXTERNAL_THUMB,
  type ScrollAxisGeometry,
} from "./external-scrollbar-geometry";
import { useScrollbarViewport } from "./scrollbar-track";
import "./scroll-area.css";

const SCROLLING_HIDE_DELAY_MS = 500;

const EMPTY_AXIS = calculateScrollAxisGeometry({ content: 0, offset: 0, track: 0, viewport: 0 }, EXTERNAL_THUMB);
const EMPTY_BOX = { top: 0, height: 0 };
type Flags = { overflow: boolean; canScrollStart: boolean; canScrollEnd: boolean };
const NO_OVERFLOW: Flags = { overflow: false, canScrollStart: false, canScrollEnd: false };

// The thumb follows the scroll in the DOM, as the PDF's bars do
// (overlay-scrollbar.tsx): as React state, every frame of a scroll through
// the file tree re-rendered the bar and laid the page out a second time.
function applyThumb(track: HTMLElement | null, axis: ScrollAxisGeometry) {
  const thumb = track?.firstElementChild;
  if (!(thumb instanceof HTMLElement)) return;
  const height = `${axis.thumbSize}px`;
  const transform = `translate3d(-2px, ${axis.thumbOffset}px, 0)`;
  if (thumb.style.height !== height) thumb.style.height = height;
  if (thumb.style.transform !== transform) thumb.style.transform = transform;
}

/**
 * Draws the Lattice scrollbar for a scroll owner that cannot be wrapped by the
 * regular ScrollArea (for example, a virtualized viewport inside shadow DOM).
 * The native scrollbar must be hidden by the owner-specific stylesheet.
 * React renders it only when the track's box or which ends have more to show
 * change; a scroll moves the thumb and reveals the bar in the DOM.
 * `getHoverArea` widens where a pointer reveals the bar past the viewport,
 * for content drawn over it from outside, such as the file tree's pinned folders.
 */
export function ExternalScrollbar({ getViewport, getHoverArea }: {
  getViewport: () => HTMLElement | null;
  getHoverArea?: (viewport: HTMLElement) => HTMLElement | null;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState(EMPTY_BOX);
  const [flags, setFlags] = useState(NO_OVERFLOW);
  const [hovering, setHovering] = useState(false);
  // The latest geometry, for a drag or a wheel over the bar.
  const axisRef = useRef(EMPTY_AXIS);

  const measure = useCallback((viewport: HTMLElement | null) => {
    const surface = trackRef.current?.parentElement;
    const height = viewport && surface ? Math.max(0, viewport.clientHeight) : 0;
    const top = viewport && surface ? viewport.getBoundingClientRect().top - surface.getBoundingClientRect().top : 0;
    const axis = viewport && surface
      ? calculateScrollAxisGeometry(
        { content: viewport.scrollHeight, offset: viewport.scrollTop, track: height, viewport: height },
        EXTERNAL_THUMB,
      )
      : EMPTY_AXIS;
    axisRef.current = axis;
    applyThumb(trackRef.current, axis);
    setBox((current) => (current.top === top && current.height === height ? current : { top, height }));
    setFlags((current) => (
      current.overflow === axis.overflow && current.canScrollStart === axis.canScrollStart && current.canScrollEnd === axis.canScrollEnd
        ? current
        : { overflow: axis.overflow, canScrollStart: axis.canScrollStart, canScrollEnd: axis.canScrollEnd }
    ));
  }, []);

  const watch = useCallback((viewport: HTMLElement, scheduleMeasure: () => void) => {
    const markHovering = () => setHovering(true);
    const clearHovering = () => setHovering(false);
    const hoverArea = getHoverArea?.(viewport) ?? viewport;
    hoverArea.addEventListener("pointerenter", markHovering);
    hoverArea.addEventListener("pointerleave", clearHovering);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMeasure);
    const observed = [
      viewport,
      ...viewport.children,
      viewport.querySelector("[data-file-tree-virtualized-list]"),
      trackRef.current?.parentElement,
    ];
    for (const element of observed) {
      if (element instanceof HTMLElement) resizeObserver?.observe(element);
    }
    const root = viewport.getRootNode();
    const mutationObserver = root instanceof ShadowRoot ? new MutationObserver(scheduleMeasure) : null;
    mutationObserver?.observe(root, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });
    return () => {
      hoverArea.removeEventListener("pointerenter", markHovering);
      hoverArea.removeEventListener("pointerleave", clearHovering);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [getHoverArea]);

  const setScrolling = useCallback((scrolling: boolean) => {
    trackRef.current?.toggleAttribute("data-scrolling", scrolling);
  }, []);
  const { viewportRef, drag } = useScrollbarViewport(
    getViewport,
    measure,
    SCROLLING_HIDE_DELAY_MS,
    watch,
    setScrolling,
  );

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || !axisRef.current.overflow) return;
    event.preventDefault();
    viewport.scrollTop += event.deltaY;
  };

  return (
    <div
      ref={trackRef}
      aria-hidden="true"
      className="lattice-scrollbar external-scrollbar"
      data-hovering={hovering ? "" : undefined}
      data-orientation="vertical"
      data-overflow-y-end={flags.canScrollEnd ? "" : undefined}
      data-overflow-y-start={flags.canScrollStart ? "" : undefined}
      onPointerCancel={drag.end}
      onPointerDown={(event) => {
        if (axisRef.current.overflow) drag.begin(event, "y", axisRef.current);
      }}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => {
        setHovering(false);
        if (!drag.dragRef.current) setScrolling(false);
      }}
      onPointerMove={drag.move}
      onPointerUp={drag.end}
      onWheel={handleWheel}
      style={{ height: box.height, top: box.top }}
    >
      <div className="lattice-scrollbar-thumb" data-slot="scroll-area-thumb" />
    </div>
  );
}
