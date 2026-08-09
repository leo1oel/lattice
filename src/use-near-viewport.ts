import { useEffect, useState } from "react";

type VisibilityListener = (visible: boolean) => void;

type SharedObserver = {
  observer: IntersectionObserver;
  listeners: Map<Element, VisibilityListener>;
  pending: Map<Element, VisibilityListener>;
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
    const next = shared.pending.entries().next().value as [Element, VisibilityListener] | undefined;
    if (!next) return;
    const [element, listener] = next;
    shared.pending.delete(element);
    if (shared.listeners.get(element) === listener) listener(true);
    // One expensive image/formula per idle slice prevents a scroll boundary
    // from committing a whole screen of KaTeX and decoded images at once.
    scheduleMaterialization(shared);
  };
  if ("requestIdleCallback" in window) {
    shared.idleKind = "idle";
    shared.idleHandle = window.requestIdleCallback(materializeNext, { timeout: 160 });
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
  const listeners = new Map<Element, VisibilityListener>();
  const shared: SharedObserver = {
    listeners,
    pending: new Map(),
    idleHandle: null,
    idleKind: null,
    observer: new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const listener = listeners.get(entry.target);
        if (!listener) continue;
        if (entry.isIntersecting) shared.pending.set(entry.target, listener);
        else {
          shared.pending.delete(entry.target);
          listener(false);
        }
      }
      scheduleMaterialization(shared);
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
export function useNearViewport<T extends Element>(rootMargin = "900px 0px") {
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
      shared.pending.delete(element);
      if (shared.listeners.size > 0) return;
      cancelMaterialization(shared);
      shared.observer.disconnect();
      const observers = root ? rootedObservers.get(root) : viewportObservers;
      observers?.delete(rootMargin);
    };
  }, [element, rootMargin]);

  return { nearViewport, viewportRef: setElement };
}
