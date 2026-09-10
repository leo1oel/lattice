import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { FluidHoverHighlight, type FluidHoverHighlightProps } from "./fluid-hover-highlight";
import { useFluidHover } from "./use-fluid-hover";
import "./fluid-hover.css";

const menuItems = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]';
const boundary = '[role="separator"], [data-slot$="-label"], [cmdk-group-heading], .settings-nav-group-label';

/**
 * Visual-only bridge for existing Radix and app lists. The primitive still
 * owns focus, selection, pointer grace, and clicks; in particular, whitespace
 * must never activate the nearest destructive action. Register DOM rows here
 * rather than wrapping them, which would break Radix's asChild/collection API.
 * Mount inside a positioned `fluid-hover-surface`, in the scrolling viewport.
 */
export function FluidHoverSurface({ selector = menuItems, preserveSelection = false, transition }: {
  selector?: string;
  preserveSelection?: boolean;
  transition?: FluidHoverHighlightProps["transition"];
}) {
  const containerRef = useRef<HTMLElement | null>(null);
  const hover = useFluidHover(containerRef, { gapClick: false });
  const { registerItem, setActiveIndex, sessionRef, remeasure } = hover;
  const attach = useCallback((node: HTMLSpanElement | null) => {
    containerRef.current = node?.parentElement ?? null;
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let items: HTMLElement[] = [];
    let previous: HTMLElement | null = null;
    const owns = (node: Element) => node.closest(".fluid-hover-surface") === container;
    const clear = () => {
      previous = null;
      setActiveIndex(null);
    };
    const syncItems = () => {
      const next = Array.from(container.querySelectorAll<HTMLElement>(selector))
        .filter((item) => owns(item) && !item.closest('[hidden], [inert]'));
      if (next.length === items.length && next.every((item, i) => item === items[i])) return;
      clear();
      items.forEach((item, i) => {
        registerItem(i, null);
        item.removeAttribute("data-fluid-hover-item");
      });
      items = next;
      items.forEach((item, i) => {
        item.setAttribute("data-fluid-hover-item", "");
        registerItem(i, item);
      });
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      if (event.buttons || !target || !owns(target)
        || target.matches(':disabled, [data-disabled]:not([data-disabled="false"]), [aria-disabled="true"], [data-variant="destructive"], .destructive')
        || (preserveSelection && target.matches('.active, [aria-current="page"], [data-item-selected="true"]'))) {
        clear();
        return;
      }
      const index = items.indexOf(target);
      if (index < 0 || target === previous) return;
      // Crossing a section starts a new fade, never a slide through its label
      // or separator. Portaled submenus have an independent surface/session.
      const crossesBoundary = previous && Array.from(container.querySelectorAll(boundary)).some((divider) => {
        const a = previous!.compareDocumentPosition(divider);
        const b = target.compareDocumentPosition(divider);
        return !!(a & Node.DOCUMENT_POSITION_FOLLOWING) !== !!(b & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      if (!previous || crossesBoundary) sessionRef.current += 1;
      previous = target;
      setActiveIndex(index);
    };
    syncItems();
    // Filtering, asynchronous items and force-mounted popups can change the
    // collection without mounting this bridge again. Ignore our own attributes
    // and the animated overlay's style writes to avoid observer feedback.
    const observer = new MutationObserver((records) => {
      syncItems();
      // Virtualizers can reuse the same row nodes for different paths.
      if (records.some((record) => record.attributeName === "data-item-path")) {
        clear();
        remeasure();
      }
    });
    observer.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "inert", "data-item-path"] });
    container.addEventListener("pointermove", move);
    container.addEventListener("pointerdown", clear);
    container.addEventListener("pointerleave", clear);
    // ScrollArea and virtual trees put the scroll owner ABOVE the row scope.
    const eventRoot = container.getRootNode();
    eventRoot.addEventListener("scroll", clear, true);
    container.addEventListener("pointerenter", remeasure);
    // Keyboard navigation immediately returns to the primitive's focus/selected
    // background, even for listboxes whose focus stays in a sibling search box.
    container.ownerDocument.addEventListener("keydown", clear, true);
    return () => {
      observer.disconnect();
      container.removeEventListener("pointermove", move);
      container.removeEventListener("pointerdown", clear);
      container.removeEventListener("pointerleave", clear);
      eventRoot.removeEventListener("scroll", clear, true);
      container.removeEventListener("pointerenter", remeasure);
      container.ownerDocument.removeEventListener("keydown", clear, true);
      items.forEach((item, i) => {
        registerItem(i, null);
        item.removeAttribute("data-fluid-hover-item");
      });
    };
  }, [registerItem, remeasure, selector, preserveSelection, sessionRef, setActiveIndex]);

  useEffect(() => {
    const container = containerRef.current;
    if (hover.isMeasured && hover.activeIndex !== null) container?.setAttribute("data-fluid-hover-painted", "");
    else container?.removeAttribute("data-fluid-hover-painted");
    return () => container?.removeAttribute("data-fluid-hover-painted");
  }, [hover.isMeasured, hover.activeIndex]);

  return <>
    <span hidden aria-hidden="true" ref={attach} />
    <FluidHoverHighlight hover={hover} className="fluid-hover-highlight" transition={transition} />
  </>;
}
