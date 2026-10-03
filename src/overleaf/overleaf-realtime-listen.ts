/**
 * This window's Overleaf live channel, as the current project hears it.
 *
 * Every Overleaf realtime event reaches the app on one Tauri channel,
 * `overleaf-realtime`, tagged by `type` and stamped with the project root that
 * produced it (`ScopedEvent` in src-tauri/src/ipc/overleaf_realtime.rs).
 *
 * Two things keep an event out of a project it does not belong to, and every
 * subscriber gets both here rather than repeating them:
 *
 * - Every window runs its own live connection, and the backend addresses each
 *   connection's events to the window that opened it (`emit_to(label, …)`).
 *   Left unscoped, a second window linked to another Overleaf project received
 *   the first window's collaborators, chat messages, file tree and disconnects
 *   as if they were its own; `listenInThisWindow` explains why.
 * - Within one window, cancelling a connection cannot retract events already
 *   queued for the UI, so project A's last chat message, tree change or
 *   disconnect can arrive after the window switched to project B. Only events
 *   stamped with the subscriber's current root are delivered.
 */
import { subscribeTauriEvent } from "../app/effect-helpers";
import { listenInThisWindow } from "../app/window-events";
import type {
  CommentRange, DocEntry, DocUpdateEvent, EntityEntry, OverleafPermission,
} from "./overleaf-realtime-model";
import type { PresenceUser } from "./use-overleaf-presence";

const OVERLEAF_REALTIME_EVENT = "overleaf-realtime";

/** What the live channel says, mirroring `RealtimeEvent` in src-tauri/src/overleaf_rt/events.rs. */
type ChannelEvent =
  | { type: "connected"; publicId: string }
  | { type: "projectJoined"; rootFolderId: string; docs: DocEntry[]; permission: OverleafPermission }
  | { type: "treeChanged"; docs: DocEntry[]; entities: EntityEntry[] }
  | DocUpdateEvent
  | { type: "docAck"; docId: string; version: number }
  | { type: "otError"; docId: string; message: string }
  | { type: "commentAnchored"; docId: string; range: CommentRange }
  | { type: "changesAccepted"; docId: string; changeIds: string[] }
  | { type: "trackChangesToggled"; on: boolean }
  | { type: "threadsChanged" }
  | { type: "presenceUpdated"; user: PresenceUser }
  | { type: "presenceLeft"; id: string }
  | {
    type: "chatMessage";
    id: string;
    content: string;
    authorName: string;
    authorEmail: string | null;
    /** Milliseconds since the epoch, as Overleaf reports it. */
    timestamp: number;
  }
  | { type: "disconnected"; reason: string };

/** One live-channel event and the local project whose connection produced it. */
export type OverleafEvent = ChannelEvent & { projectRoot: string };

/**
 * Deliver each of this window's events produced by the project
 * `readCurrentRoot` names when it arrives, until the returned cleanup runs —
 * including when the subscription itself only resolves after that. No current
 * project (`null`) hears nothing.
 *
 * `readCurrentRoot` is read per event, so a listener that outlives project
 * switches can read a ref; one torn down with its project returns that
 * project's root.
 */
export function onOverleafEvent(
  readCurrentRoot: () => string | null,
  handler: (event: OverleafEvent) => void,
): () => void {
  return subscribeTauriEvent<OverleafEvent>(
    (deliver) => listenInThisWindow(OVERLEAF_REALTIME_EVENT, deliver),
    (event) => {
      const projectRoot = readCurrentRoot();
      if (projectRoot !== null && event.projectRoot === projectRoot) handler(event);
    },
  );
}
