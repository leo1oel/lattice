import { listen } from "@tauri-apps/api/event";

/**
 * Cancellable subscriptions for `useEffect` bodies. Every function here
 * returns a synchronous disposer, so an effect can `return subscribe(...)`.
 */

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

/** Listen to a Tauri event until the returned disposer runs. */
export function subscribeTauriEvent<T>(event: string, handler: (payload: T) => void): () => void {
  let active = true;
  const dispose = disposeWhenSettled(listen<T>(event, (message) => {
    if (active) handler(message.payload);
  }));
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

/** Let React commit an opening state and WebKit paint it before heavy sync work. */
export function afterNextPaintOpportunity(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
}
