/**
 * Subscribe to this window's Overleaf live channel.
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
