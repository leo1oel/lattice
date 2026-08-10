import { useEffect, useState } from "react";

type VisibilityListener = (visible: boolean) => void;

type SharedObserver = {
  preloadObserver: IntersectionObserver;
  visibleObserver: IntersectionObserver;
  listeners: Map<Element, Set<VisibilityListener>>;
  pending: Map<VisibilityListener, Element>;
  idleHandle: number | null;
  idleKind: "idle" | "timer" | null;
};

const rootedObservers = new WeakMap<Element, Map<string, SharedObserver>>();
const viewportObservers = new Map<string, SharedObserver>();

function scheduleMaterialization(shared: SharedObserver) {
  if (shared.idleHandle != null || shared.pending.size === 0) return;
  const materializeNext = () => {
    shared.idleHandle = null;
    shared.idleKind = null;
    const startedAt = performance.now();
    let materialized = 0;
    while (shared.pending.size > 0 && materialized < 4 && performance.now() - startedAt < 6) {
      const next = shared.pending.entries().next().value as [VisibilityListener, Element] | undefined;
      if (!next) break;
      const [listener, element] = next;
      shared.pending.delete(listener);
      if (shared.listeners.get(element)?.has(listener)) listener(true);
      materialized += 1;
    }
    // Bound each speculative batch, while allowing enough progress to keep
    // formula-heavy documents ahead of ordinary trackpad scrolling.
    scheduleMaterialization(shared);
  };
  if ("requestIdleCallback" in window) {
    shared.idleKind = "idle";
    shared.idleHandle = window.requestIdleCallback(materializeNext, { timeout: 50 });
  } else {
    shared.idleKind = "timer";
    shared.idleHandle = globalThis.setTimeout(materializeNext, 32);
  }
}

function cancelMaterialization(shared: SharedObserver) {
  if (shared.idleHandle == null) return;
  if (shared.idleKind === "idle" && "cancelIdleCallback" in window) {
    window.cancelIdleCallback(shared.idleHandle);
  } else {
    window.clearTimeout(shared.idleHandle);
  }
  shared.idleHandle = null;
  shared.idleKind = null;
}

function sharedObserver(root: Element | null, rootMargin: string): SharedObserver {
  const observers = root
    ? (rootedObservers.get(root) ?? new Map<string, SharedObserver>())
    : viewportObservers;
  if (root && !rootedObservers.has(root)) rootedObservers.set(root, observers);
  const existing = observers.get(rootMargin);
  if (existing) return existing;
  const listeners = new Map<Element, Set<VisibilityListener>>();
  const shared: SharedObserver = {
    listeners,
    pending: new Map(),
    idleHandle: null,
    idleKind: null,
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
    }, { root, rootMargin }),
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
  observers.set(rootMargin, shared);
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
export function useNearViewport<T extends Element>(rootMargin = "900px 0px") {
  const [element, setElement] = useState<T | null>(null);
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return;
    const root = element.closest<HTMLElement>(".editor-doc-scroll");
    const shared = sharedObserver(root, rootMargin);
    // Use semantic wrappers whose identity survives decoration threshold
    // changes. Existing NodeViews don't remount when a list gains item #20.
    const observed = element.closest<HTMLElement>("li")
      ?? element.closest<HTMLElement>(".jsx-component-wrapper")
      ?? element;
    let offscreenTimer: ReturnType<typeof setTimeout> | null = null;
    const listener: VisibilityListener = (visible) => {
      if (visible) {
        if (offscreenTimer !== null) clearTimeout(offscreenTimer);
        offscreenTimer = null;
        setNearViewport(true);
        return;
      }
      if (offscreenTimer !== null) clearTimeout(offscreenTimer);
      offscreenTimer = setTimeout(() => {
        offscreenTimer = null;
        setNearViewport(false);
      }, 3_000);
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
      if (offscreenTimer !== null) clearTimeout(offscreenTimer);
      targetListeners.delete(listener);
      shared.pending.delete(listener);
      if (targetListeners.size === 0) {
        shared.preloadObserver.unobserve(observed);
        shared.visibleObserver.unobserve(observed);
        shared.listeners.delete(observed);
      }
      if (shared.listeners.size > 0) return;
      cancelMaterialization(shared);
      shared.preloadObserver.disconnect();
      shared.visibleObserver.disconnect();
      const observers = root ? rootedObservers.get(root) : viewportObservers;
      observers?.delete(rootMargin);
    };
  }, [element, rootMargin]);

  return { nearViewport, viewportRef: setElement };
}
