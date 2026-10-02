/**
 * Listening for events the backend addresses to one window.
 *
 * The backend's `emit_to(label, …)` only filters listeners that name a target:
 * Tauri hands an event to every listener registered for `EventTarget::Any` no
 * matter which window it was sent to, and a bare `listen()` registers exactly
 * that. Naming this window here is what makes the backend's addressing hold.
 */
import { listen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

function currentWindowLabel(): string | null {
  try {
    return getCurrentWindow().label;
  } catch {
    // No Tauri window metadata (tests, a page outside the app): there is no
    // other window whose events could arrive here.
    return null;
  }
}

export function listenInThisWindow<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  const label = currentWindowLabel();
  return label === null ? listen<T>(event, handler) : listen<T>(event, handler, { target: label });
}
