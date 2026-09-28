import { useEffect, useState } from "react";
import { whenIdle } from "../dom-utils";

type VisibilityListener = (visible: boolean) => void;

type SharedObserver = {
  preloadObserver: IntersectionObserver;
  visibleObserver: IntersectionObserver;
  listeners: Map<Element, Set<VisibilityListener>>;
  pending: Map<VisibilityListener, Element>;
  cancelScheduled: (() => void) | null;
};

const PRELOAD_MARGIN = "900px 0px";
/** Observers per scrollport (`null` = the viewport), dropped with their last listener. */
const observersByRoot = new Map<Element | null, SharedObserver>();

function scheduleMaterialization(shared: SharedObserver) {
  if (shared.cancelScheduled || shared.pending.size === 0) return;
  const materializeNext = () => {
    shared.cancelScheduled = null;
    const startedAt = performance.now();
    let materialized = 0;
    while (shared.pending.size > 0 && materialized < 4 && performance.now() - startedAt < 6) {
      const [listener, element] = shared.pending.entries().next().value!;
      shared.pending.delete(listener);
      if (shared.listeners.get(element)?.has(listener)) listener(true);
      materialized += 1;
    }
    // Bound each speculative batch, while allowing enough progress to keep
    // formula-heavy documents ahead of ordinary trackpad scrolling.
    scheduleMaterialization(shared);
  };
  shared.cancelScheduled = whenIdle(materializeNext, 50, 32);
}

function sharedObserver(root: Element | null): SharedObserver {
  const existing = observersByRoot.get(root);
  if (existing) return existing;
  const listeners = new Map<Element, Set<VisibilityListener>>();
  const shared: SharedObserver = {
    listeners,
    pending: new Map(),
    cancelScheduled: null,
    preloadObserver: new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const targetListeners = listeners.get(entry.target);
        if (!targetListeners) continue;
        for (const listener of targetListeners) {
          if (entry.isIntersecting) shared.pending.set(listener, entry.target);
          else {
            shared.pending.delete(listener);
            listener(false);
          }
        }
      }
      scheduleMaterialization(shared);
    }, { root, rootMargin: PRELOAD_MARGIN }),
    visibleObserver: new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const targetListeners = listeners.get(entry.target);
        if (!targetListeners) continue;
        // Actual viewport work overtakes speculative preloads because idle
        // callbacks are commonly starved while WebKit handles a fling.
        for (const listener of targetListeners) {
          shared.pending.delete(listener);
          listener(true);
        }
      }
    }, { root }),
  };
  observersByRoot.set(root, shared);
  return shared;
}

/**
 * Defers expensive editor media until it is comfortably ahead of the
 * document viewport. Buffered work is staged across idle slices, but content
 * which reaches the real viewport bypasses that queue so a fast fling cannot
 * expose an unloaded placeholder. Instances sharing a scrollport use one
 * preload observer and one actual-visibility observer instead of per-image
 * observers. Formula leaves inside a contained list item observe that item,
 * so WebKit can preload them before it materializes the item's descendants.
 * Recently rendered content is retained briefly for smooth scroll reversal.
 */
export function useNearViewport<T extends Element>() {
  const [element, setElement] = useState<T | null>(null);
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return;
    const root = element.closest<HTMLElement>(".editor-doc-scroll");
    const shared = sharedObserver(root);
    // Use semantic wrappers whose identity survives decoration threshold
    // changes. Existing NodeViews don't remount when a list gains item #20.
    const observed = element.closest<HTMLElement>("li")
      ?? element.closest<HTMLElement>(".jsx-component-wrapper")
      ?? element;
    let offscreenTimer: ReturnType<typeof setTimeout> | undefined;
    const listener: VisibilityListener = (visible) => {
      clearTimeout(offscreenTimer);
      offscreenTimer = visible ? undefined : setTimeout(() => setNearViewport(false), 3_000);
      if (visible) setNearViewport(true);
    };
    const targetListeners = shared.listeners.get(observed) ?? new Set<VisibilityListener>();
    const firstForTarget = targetListeners.size === 0;
    targetListeners.add(listener);
    shared.listeners.set(observed, targetListeners);
    if (firstForTarget) {
      shared.preloadObserver.observe(observed);
      shared.visibleObserver.observe(observed);
    }
    return () => {
      clearTimeout(offscreenTimer);
      targetListeners.delete(listener);
      shared.pending.delete(listener);
      if (targetListeners.size === 0) {
        shared.preloadObserver.unobserve(observed);
        shared.visibleObserver.unobserve(observed);
        shared.listeners.delete(observed);
      }
      if (shared.listeners.size > 0) return;
      shared.cancelScheduled?.();
      shared.preloadObserver.disconnect();
      shared.visibleObserver.disconnect();
      observersByRoot.delete(root);
    };
  }, [element]);

  return { nearViewport, viewportRef: setElement };
}
