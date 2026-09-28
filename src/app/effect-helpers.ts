import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";

/** Cancellable subscriptions for `useEffect` bodies: each returns a synchronous disposer. */

/**
 * Adopt an asynchronously-created unlisten function. Disposing before the
 * promise settles releases the subscription the moment it arrives instead of
 * leaking it (the "disposed flag + unlisten race" every Tauri listener needs).
 */
export function disposeWhenSettled(pending: Promise<() => void>): () => void {
  let disposed = false;
  let stop: (() => void) | undefined;
  void pending.then((unlisten) => {
    if (disposed) unlisten();
    else stop = unlisten;
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
 * name, or a scoped subscribe function such as `listenOverleafRealtime`.
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
 * A ref that follows `value` after every commit, for handlers and timers that
 * outlive the render. Written in a layout effect, never during render: a
 * render-phase ref write makes the React Compiler skip the calling hook.
 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * State with a ref twin for async work: `[value, setValue, ref, setLive]`. The
 * live setter leads with the ref, so work later in the same turn sees the
 * value; every commit brings the ref level with state again.
 */
export function useRefState<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const ref = useLatest(value);
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
