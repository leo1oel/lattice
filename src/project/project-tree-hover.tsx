import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";

/** Pierre owns the virtualized Shadow DOM. Mount behind the rows themselves,
 * not behind their opaque virtual window; keep its scroll/drag model intact. */
export function ProjectTreeHover({ getViewport }: { getViewport: () => HTMLElement | null }) {
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    let attempts = 0;
    let target: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    const attach = () => {
      const scroller = getViewport();
      if (!scroller) {
        if (++attempts < 60) frame = requestAnimationFrame(attach);
        return;
      }
      const syncRows = () => {
        const next = scroller.querySelector('button[data-type="item"]')?.parentElement ?? null;
        if (next === target) return;
        target?.classList.remove("fluid-hover-surface");
        target = next;
        target?.classList.add("fluid-hover-surface");
        setViewport(target);
      };
      // An empty project or a filtered tree can acquire its first rows later.
      observer = new MutationObserver(syncRows);
      observer.observe(scroller, { childList: true, subtree: true });
      syncRows();
    };
    attach();
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      target?.classList.remove("fluid-hover-surface");
    };
  }, [getViewport]);
  return viewport ? createPortal(
    <FluidHoverSurface selector='button[data-type="item"]' preserveSelection />,
    viewport,
  ) : null;
}
