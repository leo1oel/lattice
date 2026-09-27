import {
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  calculateScrollAxisGeometry,
  EXTERNAL_THUMB,
  type ScrollAxisGeometry,
} from "./external-scrollbar-geometry";
import { attachToViewport, useScrollbarDrag } from "./scrollbar-track";
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
  const viewportRef = useRef<HTMLElement | null>(null);
  const scrollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frameRef = useRef<number | null>(null);
  const [track, setTrack] = useState(EMPTY_TRACK);
  const [hovering, setHovering] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const drag = useScrollbarDrag(viewportRef, setScrolling);
  const { axis } = track;

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
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

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  // Layout, not paint: this scrollbar often mounts because its viewport is
  // already in the DOM (Univer's All Functions list). A useEffect attach would
  // leave a committed node that does not yet listen for pointerenter, so the
  // first hover can miss — especially when jsdom's 16 ms rAF retry is delayed
  // behind other frames.
  useLayoutEffect(() => {
    const markScrolling = () => {
      scheduleMeasure();
      setScrolling(true);
      if (scrollingTimerRef.current != null) clearTimeout(scrollingTimerRef.current);
      scrollingTimerRef.current = setTimeout(() => {
        scrollingTimerRef.current = null;
        setScrolling(false);
      }, SCROLLING_HIDE_DELAY_MS);
    };
    const markHovering = () => setHovering(true);
    const clearHovering = () => setHovering(false);

    const detach = attachToViewport(getViewport, (viewport) => {
      viewportRef.current = viewport;
      viewport.addEventListener("scroll", markScrolling, { passive: true });
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
      if (mutationObserver) {
        mutationObserver.observe(root, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });
      }
      scheduleMeasure();
      return () => {
        viewport.removeEventListener("scroll", markScrolling);
        viewport.removeEventListener("pointerenter", markHovering);
        viewport.removeEventListener("pointerleave", clearHovering);
        resizeObserver?.disconnect();
        mutationObserver?.disconnect();
      };
    });
    return () => {
      detach();
      if (frameRef.current != null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (scrollingTimerRef.current != null) {
        clearTimeout(scrollingTimerRef.current);
        scrollingTimerRef.current = null;
      }
      viewportRef.current = null;
    };
  }, [getViewport, scheduleMeasure]);

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
