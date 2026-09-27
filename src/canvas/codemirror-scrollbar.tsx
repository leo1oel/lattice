import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";

function thumbGeometry(scroller: HTMLElement) {
  const trackHeight = Math.max(0, scroller.clientHeight - 8);
  const thumbHeight = Math.max(24, trackHeight * (scroller.clientHeight / scroller.scrollHeight));
  return { thumbHeight, travel: trackHeight - thumbHeight, maxScroll: scroller.scrollHeight - scroller.clientHeight };
}

/** The CodeMirror scroller the overlay `bar` sits beside. */
const scrollerBeside = (bar: HTMLElement) => bar.parentElement?.querySelector<HTMLElement>(".cm-scroller");

/** Lattice's overlay scrollbar for a CodeMirror view: a thumb that tracks the scroller and can be dragged. */
export function CodeMirrorScrollbar({ view }: { view: EditorView | null }) {
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const thumbFrameRef = useRef<number | null>(null);
  const scrollingTimerRef = useRef<number | null>(null);
  const lastScrollAtRef = useRef(0);
  const scrollingActiveRef = useRef(false);
  const dragRef = useRef<{ pointerY: number; scrollTop: number } | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [scrolling, setScrolling] = useState(false);

  const updateThumb = useCallback(() => {
    const scroller = view?.scrollDOM;
    const thumb = thumbRef.current;
    if (!scroller || !thumb) return;
    const { thumbHeight, travel, maxScroll } = thumbGeometry(scroller);
    const overflow = maxScroll > 1;
    setHasOverflow((current) => current === overflow ? current : overflow);
    if (!overflow) return;
    const top = 4 + Math.max(0, travel) * (scroller.scrollTop / maxScroll);
    const nextHeight = `${thumbHeight}px`;
    // The -2px keeps this thumb on the same line as every other Lattice
    // scrollbar, which the shared stylesheet insets from the track's edge.
    const nextTransform = `translate3d(-2px, ${top}px, 0)`;
    if (thumb.style.height !== nextHeight) thumb.style.height = nextHeight;
    if (thumb.style.transform !== nextTransform) thumb.style.transform = nextTransform;
  }, [view]);

  useEffect(() => {
    const scroller = view?.scrollDOM;
    if (!scroller) return;
    const scheduleThumbUpdate = () => {
      if (thumbFrameRef.current != null) return;
      thumbFrameRef.current = window.requestAnimationFrame(() => {
        thumbFrameRef.current = null;
        updateThumb();
      });
    };
    const finishScrolling = () => {
      const remaining = 180 - (performance.now() - lastScrollAtRef.current);
      if (remaining > 0) {
        scrollingTimerRef.current = window.setTimeout(finishScrolling, remaining);
        return;
      }
      scrollingTimerRef.current = null;
      scrollingActiveRef.current = false;
      setScrolling(false);
    };
    const handleScroll = () => {
      scheduleThumbUpdate();
      if (!scrollingActiveRef.current) {
        scrollingActiveRef.current = true;
        setScrolling(true);
      }
      lastScrollAtRef.current = performance.now();
      scrollingTimerRef.current ??= window.setTimeout(finishScrolling, 180);
    };
    const resizeObserver = new ResizeObserver(scheduleThumbUpdate);
    resizeObserver.observe(scroller);
    resizeObserver.observe(view.contentDOM);
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    updateThumb();
    return () => {
      resizeObserver.disconnect();
      scroller.removeEventListener("scroll", handleScroll);
      if (thumbFrameRef.current != null) window.cancelAnimationFrame(thumbFrameRef.current);
      thumbFrameRef.current = null;
      if (scrollingTimerRef.current) window.clearTimeout(scrollingTimerRef.current);
      scrollingTimerRef.current = null;
      scrollingActiveRef.current = false;
    };
  }, [updateThumb, view]);

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    scrollingActiveRef.current = false;
    setScrolling(false);
  };

  return (
    <div
      className="cm-overlay-scrollbar"
      data-overflow={hasOverflow || undefined}
      data-scrolling={scrolling || undefined}
      aria-hidden="true"
      onPointerDown={(event) => {
        const scroller = scrollerBeside(event.currentTarget);
        if (!scroller || !hasOverflow) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        scrollingActiveRef.current = true;
        setScrolling(true);
        if ((event.target as HTMLElement).closest(".cm-overlay-scrollbar-thumb")) {
          dragRef.current = { pointerY: event.clientY, scrollTop: scroller.scrollTop };
          return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
        scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
      }}
      onPointerMove={(event) => {
        const scroller = scrollerBeside(event.currentTarget);
        const drag = dragRef.current;
        if (!scroller || !drag) return;
        const { travel, maxScroll } = thumbGeometry(scroller);
        scroller.scrollTop = drag.scrollTop + (event.clientY - drag.pointerY) * (maxScroll / Math.max(1, travel));
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div ref={thumbRef} className="cm-overlay-scrollbar-thumb" />
    </div>
  );
}
