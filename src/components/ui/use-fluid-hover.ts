// Adapted from https://www.fluidfunctionalism.com/r/use-fluid-hover.json.
// Fluid Functionalism (https://github.com/mickadesign/fluid-functionalism): MIT License, Copyright (c) 2026 Micka Touillaud.
// Full license text: THIRD_PARTY_NOTICES.md.
// Lattice only highlights vertical lists, so the upstream x / xy axes,
// per-item disabling and distance-capped gap clicks are not carried.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

interface ItemRect {
  top: number;
  height: number;
  left: number;
  width: number;
}

/**
 * An item the pointer is inside wins (the last one, if rects overlap);
 * otherwise the item whose center is nearest, so a pointer in a gap, in the
 * padding, or past the last row still lands. Ties keep the first item.
 * Rects live in the container's layout space: its bounding rect and live
 * scroll / border offsets map them into the pointer's viewport space, and its
 * layout height factors out an ancestor `transform: scale` (a popup mid
 * scale-in).
 */
function pickNearest(container: HTMLElement, rects: readonly (ItemRect | undefined)[], y: number) {
  const bounds = container.getBoundingClientRect();
  const scale = container.offsetHeight > 0 ? bounds.height / container.offsetHeight : 1;
  let closestIndex: number | null = null;
  let closestDistance = Infinity;
  let containingIndex: number | null = null;
  for (let index = 0; index < rects.length; index++) {
    const rect = rects[index];
    if (!rect) continue;
    const top = bounds.top + (container.clientTop + rect.top - container.scrollTop) * scale;
    const height = rect.height * scale;
    if (y >= top && y <= top + height) containingIndex = index;
    const distance = Math.abs(y - (top + height / 2));
    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = index;
    }
  }
  return containingIndex ?? closestIndex;
}

/** Set on the highlighted item (boolean attribute). */
const ACTIVE_ATTR = "data-fluid-hover-active";
/** Set on the container: the highlighted index, or absent. */
const ACTIVE_INDEX_ATTR = "data-fluid-hover-active-index";

const ACTIVATOR_SELECTOR =
  // eslint-disable-next-line lingui/no-unlocalized-strings -- DOM selector
  "a[href], button, [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='option'], [role='radio'], [role='checkbox'], [role='tab'], [role='link'], [role='button']";

/**
 * The element a routed click should land on. A registered item is usually
 * the interactive row itself; when it is only a box around one (a sidebar
 * row around its button, a card around its link), the first control inside
 * is what a real click on the row would have reached.
 */
function resolveActivator(element: HTMLElement): HTMLElement {
  if (element.matches(ACTIVATOR_SELECTOR) || element.hasAttribute("tabindex")) return element;
  return element.querySelector<HTMLElement>(ACTIVATOR_SELECTOR) ?? element;
}

/**
 * Publishable rects for every registered item, or null when the pass could
 * not complete. An element inside a display:none / not-yet-laid-out popup has
 * no offsetParent and reports every offset as 0; publishing that would pin
 * overlays to the top of the list. A boxless element is the only case:
 * `position: fixed` items also have no offsetParent but do have a size.
 */
function measureRects(container: HTMLElement, items: Map<number, HTMLElement>) {
  const rects: ItemRect[] = [];
  for (const [index, element] of items) {
    if (element.offsetParent === null && element.offsetWidth <= 0 && element.offsetHeight <= 0) {
      return null;
    }
    // offset* rather than getBoundingClientRect, so a CSS transform on the
    // parent (a popup's scale animation) does not skew the rects: they are
    // layout values in the coordinate space of `position: absolute`
    // children. Items nested inside positioned descendants of the container
    // (a sidebar sub-menu's rows inside a positioned row) accumulate those
    // ancestors' offsets; for a flat list the loop never runs.
    let top = element.offsetTop;
    let left = element.offsetLeft;
    let ancestor = element.offsetParent as HTMLElement | null;
    while (ancestor && ancestor !== container && container.contains(ancestor)) {
      top += ancestor.offsetTop + ancestor.clientTop;
      left += ancestor.offsetLeft + ancestor.clientLeft;
      ancestor = ancestor.offsetParent as HTMLElement | null;
    }
    rects[index] = { top, height: element.offsetHeight, left, width: element.offsetWidth };
  }
  return rects;
}

function sameRects(a: readonly (ItemRect | undefined)[], b: readonly (ItemRect | undefined)[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i];
    const r = b[i];
    if (p === r) continue; // both undefined (sparse slot)
    if (!p || !r || p.top !== r.top || p.left !== r.left || p.width !== r.width || p.height !== r.height) {
      return false;
    }
  }
  return true;
}

/**
 * How many frames the coalesced remeasure retries while the registered items
 * still have no layout box. A popup can be in the DOM one frame before it is
 * laid out; retrying beats publishing zeroed rects, and the cap keeps a list
 * that stays hidden for good from spinning frames forever.
 */
const measurementAttempts = 3;

/**
 * `gapClick` routes a click that lands between items to the highlighted one.
 * On by default: in a menu or a list the highlight is a promise about the
 * click. Pass `false` where empty space should stay inert.
 */
export function useFluidHover<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  { gapClick = true }: { gapClick?: boolean } = {},
) {
  const itemsRef = useRef(new Map<number, HTMLElement>());
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  // Mirrored for handlers that read it outside a render (the gap click).
  const activeIndexRef = useRef<number | null>(null);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  // The state, in the DOM: `data-fluid-hover-active` on the highlighted item
  // and `data-fluid-hover-active-index` on the container. Devtools shows it
  // and a test asserts on it without waiting for a frame. React does not
  // manage these attributes, so it never clobbers them.
  useEffect(() => {
    const container = containerRef.current;
    const items = itemsRef.current;
    if (activeIndex === null) container?.removeAttribute(ACTIVE_INDEX_ATTR);
    else container?.setAttribute(ACTIVE_INDEX_ATTR, String(activeIndex));
    const active = activeIndex === null ? undefined : items.get(activeIndex);
    active?.setAttribute(ACTIVE_ATTR, "");
    return () => {
      active?.removeAttribute(ACTIVE_ATTR);
      // A row that re-registered under this index while it was highlighted
      // (a remount under a new key) was marked by registerItem, not by this
      // effect: drop the mark from whatever element holds the index now.
      if (activeIndex !== null) items.get(activeIndex)?.removeAttribute(ACTIVE_ATTR);
    };
  }, [activeIndex, containerRef]);
  const [itemRects, setItemRects] = useState<ItemRect[]>([]);
  // True once every registered item has been measured and no remeasure is
  // pending, i.e. `itemRects` describes the current item set. Gate absolutely
  // positioned overlays on it: an overlay that mounts against a rect a later
  // pass still corrects animates from the wrong place to the right one, which
  // reads as the highlight sliding in from another row.
  const [isMeasured, setIsMeasured] = useState(false);
  const itemRectsRef = useRef<ItemRect[]>([]);
  const sessionRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const remeasureRafIdRef = useRef<number | null>(null);

  /**
   * The hook's single measurement pass: coalesces every trigger (item
   * registration, item or container resize) into one remeasure on the next
   * frame and is the only place readiness is reported, so `isMeasured` can
   * never turn true while another pass is still queued. An incomplete pass
   * publishes nothing, so the last complete measurement stands; an unchanged
   * one skips the state update so redundant remeasures don't churn renders.
   */
  const scheduleMeasurement = useCallback(
    function scheduleMeasurement(attemptsLeft: number) {
      if (remeasureRafIdRef.current !== null) cancelAnimationFrame(remeasureRafIdRef.current);
      remeasureRafIdRef.current = requestAnimationFrame(() => {
        remeasureRafIdRef.current = null;
        const container = containerRef.current;
        const rects = container ? measureRects(container, itemsRef.current) : null;
        if (rects) {
          if (!sameRects(itemRectsRef.current, rects)) {
            itemRectsRef.current = rects;
            setItemRects(rects);
          }
          setIsMeasured(true);
        } else if (attemptsLeft > 1) {
          scheduleMeasurement(attemptsLeft - 1);
        }
      });
    },
    [containerRef],
  );

  // Invalidates the published rects and reruns the pass, holding `isMeasured`
  // false until it settles. For a popup that stays mounted between opens: its
  // items stay registered, so nothing else would notice that their rects were
  // taken while it was hidden.
  const remeasure = useCallback(() => {
    // Readiness drops first: until the pass below settles, the published rects
    // may not describe what is on screen, and an overlay positioned from them
    // would be corrected after mounting — which animates as a slide.
    setIsMeasured(false);
    scheduleMeasurement(measurementAttempts);
  }, [scheduleMeasurement]);

  // Observes the registered items themselves (not just the container): rows
  // that change size in place — e.g. the site-wide size step flipping while a
  // selection background is up — must invalidate the published rects even when
  // the container the effect below captured has since been remounted and the
  // ref points at a different element than the one being observed.
  const itemRoRef = useRef<ResizeObserver | null>(null);

  const registerItem = useCallback(
    (index: number, element: HTMLElement | null) => {
      if (element) {
        itemsRef.current.set(index, element);
        if (itemRoRef.current === null && typeof ResizeObserver !== "undefined") {
          itemRoRef.current = new ResizeObserver(() => scheduleMeasurement(measurementAttempts));
        }
        itemRoRef.current?.observe(element);
        if (index === activeIndexRef.current) element.setAttribute(ACTIVE_ATTR, "");
      } else {
        const previous = itemsRef.current.get(index);
        if (previous) itemRoRef.current?.unobserve(previous);
        itemsRef.current.delete(index);
        // The highlighted row is gone: nothing should stay lit or receive a
        // routed click until the pointer picks again.
        if (index === activeIndexRef.current) setActiveIndex(null);
      }
      // Coalesce rapid register/unregister calls (e.g. when an AnimatePresence
      // remounts a list of rows) into a single remeasure on the next frame.
      remeasure();
    },
    [remeasure, scheduleMeasurement],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const y = e.clientY;
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const container = containerRef.current;
        if (container) setActiveIndex(pickNearest(container, itemRectsRef.current, y));
      });
    },
    [containerRef],
  );

  const handleMouseEnter = useCallback(() => {
    sessionRef.current += 1;
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setActiveIndex(null);
  }, []);

  // Routes a click that lands between items (a gap, the padding, past the last
  // row) to the highlighted item, so what is lit is what a click hits.
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const target = e.target as Node | null;
      if (!gapClick || !target) return;
      // Inside an item: the item owns the click.
      for (const element of itemsRef.current.values()) {
        if (element.contains(target)) return;
      }
      // A row that unmounted while its own click was still bubbling (a pick
      // whose primitive re-renders the list synchronously, like a "create"
      // row that becomes a real item) already landed; it is not a gap.
      if (!target.isConnected) return;
      // A control that sits between the rows (a search field at the top of
      // a menu, a footer button) keeps its own click too.
      const control = (target as Element).closest?.(
        "input, textarea, select, button, a, summary, [contenteditable], [role='textbox'], [role='searchbox'], [role='button']",
      );
      const index = activeIndexRef.current;
      const element = index === null ? undefined : itemsRef.current.get(index);
      // A real DOM click on the item, so its own handlers (and the primitive
      // wrapping it, if any) run exactly as if the pointer had been inside.
      if (!control && element) resolveActivator(element).click();
    },
    [gapClick],
  );

  // Remeasure when the container resizes — a reflow moves items even though
  // the registered set is unchanged. Readiness is deliberately not dropped:
  // the item set is unchanged, so the published rects stay usable, and hiding
  // overlays on every reflow would flicker them.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => scheduleMeasurement(measurementAttempts));
    ro.observe(container);
    return () => ro.disconnect();
  }, [containerRef, scheduleMeasurement]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
      if (remeasureRafIdRef.current !== null) cancelAnimationFrame(remeasureRafIdRef.current);
      itemRoRef.current?.disconnect();
      itemRoRef.current = null;
    };
  }, []);

  return {
    activeIndex,
    setActiveIndex,
    itemRects,
    isMeasured,
    sessionRef,
    handlers: {
      onMouseMove: handleMouseMove,
      onMouseEnter: handleMouseEnter,
      onMouseLeave: handleMouseLeave,
      onClick: handleClick,
    },
    registerItem,
    remeasure,
  };
}

/**
 * Registers an item's element with its list for as long as it is mounted:
 * pass the hook's `registerItem` (or the copy a context hands down), the
 * row's index, and its ref.
 */
export function useRegisterFluidHoverItem(
  registerItem: (index: number, element: HTMLElement | null) => void,
  index: number,
  ref: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    registerItem(index, ref.current);
    return () => registerItem(index, null);
  }, [index, registerItem, ref]);
}

export type UseFluidHoverReturn = ReturnType<typeof useFluidHover>;
