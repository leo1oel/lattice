import { useEffect, useState } from "react";

type VisibilityListener = (visible: boolean) => void;

type SharedObserver = {
  observer: IntersectionObserver;
  listeners: Map<Element, VisibilityListener>;
};

const rootedObservers = new WeakMap<Element, Map<string, SharedObserver>>();
const viewportObservers = new Map<string, SharedObserver>();

function sharedObserver(root: Element | null, rootMargin: string): SharedObserver {
  const observers = root
    ? (rootedObservers.get(root) ?? new Map<string, SharedObserver>())
    : viewportObservers;
  if (root && !rootedObservers.has(root)) rootedObservers.set(root, observers);
  const existing = observers.get(rootMargin);
  if (existing) return existing;
  const listeners = new Map<Element, VisibilityListener>();
  const shared = {
    listeners,
    observer: new IntersectionObserver((entries) => {
      for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
    }, { root, rootMargin }),
  };
  observers.set(rootMargin, shared);
  return shared;
}

/**
 * Defers expensive editor content until it is comfortably ahead of the
 * document viewport, then releases its decoded media / rendered formula tree
 * after it moves outside that buffer. Instances sharing a scrollport also
 * share one IntersectionObserver instead of creating hundreds for a paper.
 */
export function useNearViewport<T extends Element>(rootMargin = "1400px 0px") {
  const [element, setElement] = useState<T | null>(null);
  const [nearViewport, setNearViewport] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return;
    const root = element.closest<HTMLElement>(".editor-doc-scroll");
    const shared = sharedObserver(root, rootMargin);
    shared.listeners.set(element, setNearViewport);
    shared.observer.observe(element);
    return () => {
      shared.observer.unobserve(element);
      shared.listeners.delete(element);
      if (shared.listeners.size > 0) return;
      shared.observer.disconnect();
      const observers = root ? rootedObservers.get(root) : viewportObservers;
      observers?.delete(rootMargin);
    };
  }, [element, rootMargin]);

  return { nearViewport, viewportRef: setElement };
}
