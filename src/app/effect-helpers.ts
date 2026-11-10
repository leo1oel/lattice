import { useCallback, useState } from "react";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { useLatestRef } from "../hooks/use-latest-ref";

/** Cancellable subscriptions for `useEffect` bodies: each returns a synchronous disposer. */

/**
 * Adopt an asynchronously-created unlisten function. Disposing before the
 * promise settles releases the subscription the moment it arrives instead of
 * leaking it (the "disposed flag + unlisten race" every Tauri listener needs).
 */
export function disposeWhenSettled(pending: Promise<() => void>): () => void {
  let disposed = false;
  let stop: (() => void) | undefined;
  pending.then((unlisten) => {
    if (disposed) unlisten();
    else stop = unlisten;
  }, () => {
    // Never subscribed (e.g. a browser preview has no native event bridge): nothing to release.
  });
  return () => {
    disposed = true;
    stop?.();
  };
}

/** Hand `pending`'s value to `commit`, unless the returned disposer has run by then. */
export function thenUnlessDisposed<T>(pending: Promise<T>, commit: (value: T) => void): () => void {
  let disposed = false;
  void pending.then((value) => {
    if (!disposed) commit(value);
  });
  return () => { disposed = true; };
}

/**
 * Listen to a Tauri event until the returned disposer runs. `event` is an event
 * name, or a scoped subscribe function such as one built on `listenInThisWindow`.
 */
export function subscribeTauriEvent<T>(
  event: string | ((handler: EventCallback<T>) => Promise<UnlistenFn>),
  handler: (payload: T) => void,
): () => void {
  let active = true;
  const onEvent: EventCallback<T> = (message) => {
    if (active) handler(message.payload);
  };
  const dispose = disposeWhenSettled(typeof event === "string" ? listen<T>(event, onEvent) : event(onEvent));
  return () => {
    active = false;
    dispose();
  };
}

/**
 * Run `callback` when the main thread is idle (bounded by `timeout`), or after
 * `fallbackMs` where requestIdleCallback does not exist.
 */
export function whenIdle(callback: () => void, timeout: number, fallbackMs: number): () => void {
  if ("requestIdleCallback" in window) {
    const idle = window.requestIdleCallback(callback, { timeout });
    return () => window.cancelIdleCallback(idle);
  }
  const timer = globalThis.setTimeout(callback, fallbackMs);
  return () => globalThis.clearTimeout(timer);
}

/** Coalesce calls into one `run` on the next animation frame; `cancel` drops a pending run. */
export function frameCoalescer(run: () => void): [schedule: () => void, cancel: () => void] {
  let frame: number | null = null;
  const schedule = () => {
    frame ??= window.requestAnimationFrame(() => {
      frame = null;
      run();
    });
  };
  const cancel = () => {
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
  };
  return [schedule, cancel];
}

/** Run `update` at most once a frame while `targets` resize or the window scrolls (anywhere) or resizes. */
export function onLayoutChange(targets: readonly (Element | null | undefined)[], update: () => void): () => void {
  const [schedule, cancel] = frameCoalescer(update);
  const observer = new ResizeObserver(schedule);
  for (const target of targets) if (target) observer.observe(target);
  const listening = new AbortController();
  window.addEventListener("scroll", schedule, { capture: true, signal: listening.signal });
  window.addEventListener("resize", schedule, { signal: listening.signal });
  return () => {
    cancel();
    observer.disconnect();
    listening.abort();
  };
}

export type TimerRef = { current: number | null };

export function clearTimer(timer: TimerRef) {
  if (timer.current !== null) window.clearTimeout(timer.current);
  timer.current = null;
}

/** (Re)start a one-shot timer held in a ref, replacing any pending run. */
export function restartTimer(timer: TimerRef, delay: number, run: () => void) {
  clearTimer(timer);
  timer.current = window.setTimeout(() => {
    timer.current = null;
    run();
  }, delay);
}

/**
 * Whether the window is off screen: minimized, on another Space, or covered
 * (WebKit's page visibility). Nobody sees a poll's answer then, so polls wait.
 */
export function windowHidden(): boolean {
  return document.visibilityState === "hidden";
}

/** Call `listener` each time the window comes back on screen. */
export function onWindowShown(listener: () => void): () => void {
  const onChange = () => {
    if (!windowHidden()) listener();
  };
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * `setInterval` for polls that only matter on screen: no ticks (and no
 * wakeups) while the window is hidden, and one tick at once when it is shown
 * again, so what changed meanwhile shows without waiting a period. A caller
 * that already checks on window focus passes `catchUp: false`: showing the
 * window focuses it too, and both ticks would run the same check twice.
 */
export function visibleInterval(tick: () => void, ms: number, { catchUp = true } = {}): () => void {
  let timer: number | null = null;
  const start = () => {
    if (timer === null) timer = window.setInterval(tick, ms);
  };
  const stop = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
  const onChange = () => {
    if (windowHidden()) {
      stop();
    } else if (timer === null) {
      start();
      if (catchUp) tick();
    }
  };
  if (!windowHidden()) start();
  document.addEventListener("visibilitychange", onChange);
  return () => {
    stop();
    document.removeEventListener("visibilitychange", onChange);
  };
}

/**
 * Stable forwarders over handlers whose identity changes every render: each
 * returned function keeps its identity for the caller's lifetime and calls the
 * latest committed handler, so a memoized child given them re-renders only
 * when its data changes. The handler names are fixed at the first render.
 */
export function useStableHandlers<T extends Record<string, ((...args: never[]) => unknown) | undefined>>(handlers: T): T {
  const handlersRef = useLatestRef(handlers);
  const [stable] = useState(() => {
    const forwarders: Record<string, (...args: unknown[]) => unknown> = {};
    for (const key of Object.keys(handlers)) {
      forwarders[key] = (...args) => (handlersRef.current[key] as ((...values: unknown[]) => unknown) | undefined)?.(...args);
    }
    return forwarders as unknown as T;
  });
  return stable;
}

/**
 * State with a ref twin for async work: `[value, setValue, ref, setLive]`. The
 * live setter leads with the ref, so work later in the same turn sees the
 * value; every commit brings the ref level with state again.
 */
export function useRefState<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const ref = useLatestRef(value);
  const setLive = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, [ref]);
  return [value, setValue, ref, setLive] as const;
}

/** Let React commit an opening state and WebKit paint it before heavy sync work. */
export function afterNextPaintOpportunity(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}
