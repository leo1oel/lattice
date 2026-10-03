import { useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { frameCoalescer } from "../app/effect-helpers";
import { releaseReveal } from "../editor/editor-reveal";

function thumbGeometry(scroller: HTMLElement) {
  const trackHeight = Math.max(0, scroller.clientHeight - 8);
  const thumbHeight = Math.max(24, trackHeight * (scroller.clientHeight / scroller.scrollHeight));
  return { thumbHeight, travel: trackHeight - thumbHeight, maxScroll: scroller.scrollHeight - scroller.clientHeight };
}

/** The CodeMirror scroller the overlay `bar` sits beside. */
const scrollerBeside = (bar: HTMLElement) => bar.parentElement?.querySelector<HTMLElement>(".cm-scroller");

/** Lattice's overlay scrollbar for a CodeMirror view: a thumb that tracks the scroller and can be dragged. */
export function CodeMirrorScrollbar({ view }: { view: EditorView | null }) {
  const barRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const scrollingActiveRef = useRef(false);
  const dragRef = useRef<{ pointerY: number; scrollTop: number } | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  // Written to the DOM rather than kept in state, like the thumb: as state,
  // whether the bar hid between two wheel notches (two commits) depended on
  // how the notches fell against the idle timeout.
  const setScrolling = (scrolling: boolean) => barRef.current?.toggleAttribute("data-scrolling", scrolling);

  useEffect(() => {
    const scroller = view?.scrollDOM;
    if (!scroller) return;
    const updateThumb = () => {
      const thumb = thumbRef.current;
      if (!thumb) return;
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
    };
    const [scheduleThumbUpdate, cancelThumbUpdate] = frameCoalescer(updateThumb);
    let scrollingTimer: number | null = null;
    let lastScrollAt = 0;
    const finishScrolling = () => {
      const remaining = 180 - (performance.now() - lastScrollAt);
      if (remaining > 0) {
        scrollingTimer = window.setTimeout(finishScrolling, remaining);
        return;
      }
      scrollingTimer = null;
      scrollingActiveRef.current = false;
      setScrolling(false);
    };
    const handleScroll = () => {
      scheduleThumbUpdate();
      if (!scrollingActiveRef.current) {
        scrollingActiveRef.current = true;
        setScrolling(true);
      }
      lastScrollAt = performance.now();
      scrollingTimer ??= window.setTimeout(finishScrolling, 180);
    };
    const resizeObserver = new ResizeObserver(scheduleThumbUpdate);
    resizeObserver.observe(scroller);
    resizeObserver.observe(view.contentDOM);
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    updateThumb();
    return () => {
      resizeObserver.disconnect();
      scroller.removeEventListener("scroll", handleScroll);
      cancelThumbUpdate();
      if (scrollingTimer != null) window.clearTimeout(scrollingTimer);
      scrollingActiveRef.current = false;
    };
  }, [view]);

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    scrollingActiveRef.current = false;
    setScrolling(false);
  };

  return (
    <div
      ref={barRef}
      className="cm-overlay-scrollbar"
      data-overflow={hasOverflow || undefined}
      aria-hidden="true"
      onPointerDown={(event) => {
        const scroller = scrollerBeside(event.currentTarget);
        if (!scroller || !hasOverflow) return;
        // The bar sits outside the view's DOM, so a jump settling its target
        // would not see this gesture and pull the document back.
        if (view) releaseReveal(view);
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
