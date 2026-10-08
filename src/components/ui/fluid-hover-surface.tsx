import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Transition } from "motion/react";
import { FluidHoverHighlight } from "./fluid-hover-highlight";
import { useFluidHover } from "./use-fluid-hover";
import "./fluid-hover.css";

const menuItems = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]';
const boundary = '[role="separator"], [data-slot$="-label"], [cmdk-group-heading], .settings-nav-group-label';
const unavailable = ':disabled, [data-disabled]:not([data-disabled="false"]), [aria-disabled="true"], [data-variant="destructive"], .destructive';
const selection = '.active, [aria-current="page"], [data-item-selected="true"]';
/**
 * How far past a row's edge the pointer still lights it: the hairline gap
 * between two rows (a Papers divider) is no dead zone, while a menu
 * separator's margin (4px each side) or a section label still is.
 */
const gapTolerance = 3;
/** `useFluidHover`'s mark on the lit row. */
const activeAttribute = "data-fluid-hover-active";
/** The attributes a primitive marks its current row with (`follow`). */
const currentAttributes = ["data-highlighted", "aria-selected"];

/**
 * Visual-only bridge for existing Radix and app lists. The primitive still
 * owns focus, selection, pointer grace, and clicks; in particular, whitespace
 * must never activate the nearest destructive action. Register DOM rows here
 * rather than wrapping them, which would break Radix's asChild/collection API.
 * Mount inside a positioned `fluid-hover-surface`, in the scrolling viewport.
 *
 * One fill answers both hands. The pointer moves it to the row under it; the
 * keyboard moves it to the primitive's own current row, `follow` (Radix marks
 * it `data-highlighted`; a picker listbox, `aria-selected`; a menu of plain
 * buttons, `:focus`), so arrowing
 * through a menu slides the same fill instead of lighting rows one by one.
 * Whichever hand moved last owns it. A list whose keyboard answer is the focus
 * ring instead (a tree, a sidebar) passes `follow={null}`: a key clears the
 * fill and leaves the ring alone.
 */
export function FluidHoverSurface({
  selector = menuItems,
  follow = "[data-highlighted]",
  preserveSelection = false,
  transition,
}: {
  selector?: string;
  follow?: string | null;
  preserveSelection?: boolean;
  transition?: Transition;
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
    // Until the pointer really moves, the fill shows the primitive's current
    // row: a picker opens with its first result current, as the keyboard
    // left it.
    let keyboard = follow !== null;
    let pointer: { x: number; y: number } | null = null;
    const owns = (node: Element) => node.closest(".fluid-hover-surface") === container;
    const clear = () => {
      previous = null;
      setActiveIndex(null);
    };
    const release = () => items.forEach((item, i) => {
      registerItem(i, null);
      item.removeAttribute("data-fluid-hover-item");
    });
    const moveTo = (target: HTMLElement | null) => {
      if (!target || !owns(target) || target.matches(unavailable)
        || (preserveSelection && target.matches(selection))) {
        clear();
        return;
      }
      const index = items.indexOf(target);
      if (index < 0) {
        clear();
        return;
      }
      if (target === previous) return;
      // Crossing a section starts a new fade, never a slide through its label
      // or separator. Portaled submenus have an independent surface/session.
      const crossesBoundary = previous && Array.from(container.querySelectorAll(boundary)).some((divider) => {
        const a = previous!.compareDocumentPosition(divider);
        const b = target.compareDocumentPosition(divider);
        return !!(a & Node.DOCUMENT_POSITION_FOLLOWING) !== !!(b & Node.DOCUMENT_POSITION_FOLLOWING);
      });
      if (!previous || crossesBoundary) sessionRef.current += 1;
      // Mark the row now rather than when React commits the index, so its
      // own fill (Radix's, set in the same frame) never shows beside the
      // fill that is still on its way over.
      previous?.removeAttribute(activeAttribute);
      target.setAttribute(activeAttribute, "");
      previous = target;
      setActiveIndex(index);
    };
    // `:focus` is read off the root's active element: it is what the selector
    // means, and jsdom's selector engine throws on it with nothing focused.
    const isCurrent = (item: HTMLElement) => follow === ":focus"
      ? (item.getRootNode() as Document | ShadowRoot).activeElement === item
      : !!follow && item.matches(follow);
    const followCurrent = () => {
      if (keyboard && follow) moveTo(items.find(isCurrent) ?? null);
    };
    const syncItems = () => {
      const next = Array.from(container.querySelectorAll<HTMLElement>(selector))
        .filter((item) => owns(item) && !item.closest('[hidden], [inert]'));
      if (next.length === items.length && next.every((item, i) => item === items[i])) return;
      clear();
      release();
      items = next;
      items.forEach((item, i) => {
        item.setAttribute("data-fluid-hover-item", "");
        registerItem(i, item);
      });
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      // A list that scrolls under a resting pointer gets a pointermove from
      // the browser with the same coordinates. Only a pointer that really
      // moved takes the fill back from the keyboard.
      if (pointer && pointer.x === event.clientX && pointer.y === event.clientY) return;
      pointer = { x: event.clientX, y: event.clientY };
      keyboard = false;
      if (event.buttons) {
        clear();
        return;
      }
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>(selector) : null;
      moveTo(target ?? nearestRow(event.clientY));
    };
    const nearestRow = (y: number) => {
      let nearest: HTMLElement | null = null;
      let distance = gapTolerance;
      for (const item of items) {
        const { top, bottom } = item.getBoundingClientRect();
        const away = y < top ? top - y : y > bottom ? y - bottom : 0;
        if (away <= distance) {
          nearest = item;
          distance = away;
        }
      }
      return nearest;
    };
    let keyTimer: ReturnType<typeof setTimeout> | undefined;
    const key = () => {
      keyboard = true;
      if (!follow) {
        clear();
        return;
      }
      // The primitive moves its current row in its own handler, after this
      // capture-phase listener: the observer below follows it there, and this
      // settles a key that moved nothing (or left nothing current) once the
      // primitive has answered it.
      clearTimeout(keyTimer);
      keyTimer = setTimeout(followCurrent, 0);
    };
    syncItems();
    followCurrent();
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
      followCurrent();
    });
    observer.observe(container, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["hidden", "inert", "data-item-path", ...(follow ? currentAttributes : [])],
    });
    const listening = new AbortController();
    const { signal } = listening;
    container.addEventListener("pointermove", move, { signal });
    container.addEventListener("pointerdown", clear, { signal });
    container.addEventListener("pointerleave", () => {
      pointer = null;
      if (!keyboard) clear();
    }, { signal });
    // ScrollArea and virtual trees put the scroll owner ABOVE the row scope.
    // A fill the keyboard placed scrolls with its row (it lives in the
    // scrolling viewport); one under a resting pointer would be left behind.
    container.getRootNode().addEventListener("scroll", () => {
      if (!keyboard) clear();
    }, { capture: true, signal });
    container.addEventListener("pointerenter", remeasure, { signal });
    // A menu of plain buttons makes its current row by focusing it (`:focus`).
    container.addEventListener("focusin", followCurrent, { signal });
    // Listboxes keep focus in a sibling search box, so keys are heard on the
    // document rather than in the list.
    container.ownerDocument.addEventListener("keydown", key, { capture: true, signal });
    return () => {
      clearTimeout(keyTimer);
      observer.disconnect();
      listening.abort();
      release();
    };
  }, [registerItem, remeasure, selector, follow, preserveSelection, sessionRef, setActiveIndex]);

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
