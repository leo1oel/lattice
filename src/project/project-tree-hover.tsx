import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";

/** Keep the stationary tree's hover spring, but never animate recycled rows
 * during scrolling. Unmounting also suspends the hover measurement observers. */
export function ProjectTreeHover({ getViewport }: { getViewport: () => HTMLElement | null }) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const [scrolling, setScrolling] = useState(false);
  useLayoutEffect(() => {
    let frame = 0;
    let attempts = 0;
    let target: HTMLElement | null = null;
    let scroller: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      // Hide even an exiting Motion overlay synchronously, before React commits.
      scroller?.setAttribute("data-tree-scrolling", "");
      setScrolling(true);
      clearTimeout(timer);
      timer = setTimeout(() => {
        scroller?.removeAttribute("data-tree-scrolling");
        setScrolling(false);
      }, 150);
    };
    const attach = () => {
      scroller = getViewport();
      if (!scroller) {
        if (++attempts < 60) frame = requestAnimationFrame(attach);
        return;
      }
      const syncRows = () => {
        // Sticky folder mirrors must not steal the scope from the real window.
        const next = scroller!.querySelector<HTMLElement>('[data-file-tree-virtualized-sticky="true"]');
        if (next === target) return;
        target?.classList.remove("fluid-hover-surface");
        target = next;
        target?.classList.add("fluid-hover-surface");
        setViewport(target);
      };
      observer = new MutationObserver(syncRows);
      observer.observe(scroller, { childList: true, subtree: true });
      syncRows();
      scroller.addEventListener("wheel", onScroll, { passive: true });
      scroller.addEventListener("scroll", onScroll, { passive: true });
    };
    attach();
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      observer?.disconnect();
      scroller?.removeEventListener("wheel", onScroll);
      scroller?.removeEventListener("scroll", onScroll);
      scroller?.removeAttribute("data-tree-scrolling");
      target?.classList.remove("fluid-hover-surface");
    };
  }, [getViewport]);
  return viewport && !scrolling ? createPortal(
    <FluidHoverSurface selector='button[data-type="item"]' preserveSelection />,
    viewport,
  ) : null;
}
