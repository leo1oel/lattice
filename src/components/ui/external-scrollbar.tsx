import { type WheelEvent as ReactWheelEvent, useCallback, useRef, useState } from "react";
import {
  calculateScrollAxisGeometry,
  EXTERNAL_THUMB,
  type ScrollAxisGeometry,
} from "./external-scrollbar-geometry";
import { useScrollbarViewport } from "./scrollbar-track";
import "./scroll-area.css";

const SCROLLING_HIDE_DELAY_MS = 500;

const EMPTY_TRACK: { top: number; height: number; axis: ScrollAxisGeometry } = {
  top: 0,
  height: 0,
  axis: calculateScrollAxisGeometry({ content: 0, offset: 0, track: 0, viewport: 0 }, EXTERNAL_THUMB),
};

/**
 * Draws the Lattice scrollbar for a scroll owner that cannot be wrapped by the
 * regular ScrollArea (for example, a virtualized viewport inside shadow DOM).
 * The native scrollbar must be hidden by the owner-specific stylesheet.
 */
export function ExternalScrollbar({ getViewport }: { getViewport: () => HTMLElement | null }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [track, setTrack] = useState(EMPTY_TRACK);
  const [hovering, setHovering] = useState(false);
  const { axis } = track;

  const measure = useCallback((viewport: HTMLElement | null) => {
    const surface = trackRef.current?.parentElement;
    if (!viewport || !surface) {
      setTrack(EMPTY_TRACK);
      return;
    }
    const height = Math.max(0, viewport.clientHeight);
    setTrack({
      top: viewport.getBoundingClientRect().top - surface.getBoundingClientRect().top,
      height,
      axis: calculateScrollAxisGeometry(
        { content: viewport.scrollHeight, offset: viewport.scrollTop, track: height, viewport: height },
        EXTERNAL_THUMB,
      ),
    });
  }, []);

  const watch = useCallback((viewport: HTMLElement, scheduleMeasure: () => void) => {
    const markHovering = () => setHovering(true);
    const clearHovering = () => setHovering(false);
    viewport.addEventListener("pointerenter", markHovering);
    viewport.addEventListener("pointerleave", clearHovering);
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
      viewport.removeEventListener("pointerenter", markHovering);
      viewport.removeEventListener("pointerleave", clearHovering);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, []);

  const [scrolling, setScrolling] = useState(false);
  const { viewportRef, drag } = useScrollbarViewport(
    getViewport,
    measure,
    SCROLLING_HIDE_DELAY_MS,
    watch,
    setScrolling,
  );

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport || !axis.overflow) return;
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
      data-overflow-y-end={axis.canScrollEnd ? "" : undefined}
      data-overflow-y-start={axis.canScrollStart ? "" : undefined}
      data-scrolling={scrolling ? "" : undefined}
      onPointerCancel={drag.end}
      onPointerDown={(event) => {
        if (axis.overflow) drag.begin(event, "y", axis);
      }}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => {
        setHovering(false);
        if (!drag.dragRef.current) setScrolling(false);
      }}
      onPointerMove={drag.move}
      onPointerUp={drag.end}
      onWheel={handleWheel}
      style={{ height: track.height, top: track.top }}
    >
      <div
        className="lattice-scrollbar-thumb"
        data-slot="scroll-area-thumb"
        style={{
          height: axis.thumbSize,
          transform: `translate3d(-2px, ${axis.thumbOffset}px, 0)`,
        }}
      />
    </div>
  );
}
