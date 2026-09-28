/**
 * This window's Overleaf live channel.
 *
 * Every Overleaf realtime event reaches the app on one Tauri channel,
 * `overleaf-realtime`, tagged by `type` and stamped with the project root that
 * produced it (`RealtimeEvent` in src-tauri/src/overleaf_rt.rs lists them all).
 *
 * Every window runs its own live connection, and the backend addresses each
 * connection's events to the window that opened it (`emit_to(label, …)`). That
 * addressing only filters listeners that name a target: Tauri hands an event to
 * every listener registered for `EventTarget::Any` no matter which window it was
 * sent to, and a bare `listen()` registers exactly that. Left unscoped, a second
 * window linked to another Overleaf project received the first window's
 * collaborators, chat messages, file tree and disconnects as if they were its
 * own. Naming our window here is what makes the backend's addressing hold.
 */
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const OVERLEAF_REALTIME_EVENT = "overleaf-realtime";

function currentWindowLabel(): string | null {
  try {
    return getCurrentWindow().label;
  } catch {
    // No Tauri window metadata (tests, a page outside the app): there is no
    // other window whose events could arrive here.
    return null;
  }
}

export function listenOverleafRealtime<T>(handler: EventCallback<T>): Promise<UnlistenFn> {
  const label = currentWindowLabel();
  return label === null
    ? listen<T>(OVERLEAF_REALTIME_EVENT, handler)
    : listen<T>(OVERLEAF_REALTIME_EVENT, handler, { target: label });
}

/**
 * Deliver each event payload to `handler` until the returned cleanup runs,
 * including when the subscription itself only resolves after that.
 */
export function onOverleafEvent<T extends { type: string }>(handler: (event: T) => void): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void listenOverleafRealtime<T>((event) => {
    if (!disposed) handler(event.payload);
  }).then((dispose) => {
    if (disposed) dispose();
    else unlisten = dispose;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
