/**
 * This window's Overleaf live channel.
 *
 * Every Overleaf realtime event reaches the app on one Tauri channel,
 * `overleaf-realtime`, tagged by `type` and stamped with the project root that
 * produced it (`RealtimeEvent` in src-tauri/src/overleaf_rt.rs lists them all).
 *
 * Every window runs its own live connection, and the backend addresses each
 * connection's events to the window that opened it (`emit_to(label, …)`).
 * Left unscoped, a second window linked to another Overleaf project received
 * the first window's collaborators, chat messages, file tree and disconnects
 * as if they were its own; `listenInThisWindow` explains why.
 */
import type { EventCallback, UnlistenFn } from "@tauri-apps/api/event";
import { subscribeTauriEvent } from "../app/effect-helpers";
import { listenInThisWindow } from "../app/window-events";

const OVERLEAF_REALTIME_EVENT = "overleaf-realtime";

export function listenOverleafRealtime<T>(handler: EventCallback<T>): Promise<UnlistenFn> {
  return listenInThisWindow<T>(OVERLEAF_REALTIME_EVENT, handler);
}

/**
 * Deliver each event payload to `handler` until the returned cleanup runs,
 * including when the subscription itself only resolves after that.
 */
export function onOverleafEvent<T extends { type: string }>(handler: (event: T) => void): () => void {
  return subscribeTauriEvent<T>(listenOverleafRealtime, handler);
}
