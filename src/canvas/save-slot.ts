import type { SaveStatus } from "../app/use-open-documents";
import type { RealtimeStatus } from "../overleaf/overleaf-realtime-model";
import type { OverleafSyncMode } from "../settings/app-settings";

/**
 * Where the linked Overleaf project stands, as the save slot words it:
 * - `live`: edits go to Overleaf as they are typed, and Overleaf has every one;
 * - `sending`: live, with an edit Overleaf has not acknowledged yet;
 * - `syncing`: a sync is running;
 * - `offline`: the live channel dropped, so edits wait on this Mac;
 * - `manual`: edits go when the writer syncs;
 * - `paused`: the link is paused.
 */
export type OverleafSaveLayer = { state: "live" | "sending" | "syncing" | "offline" | "manual" | "paused"; lastSync: string | null };

/**
 * The layer's state for the file on screen. The live channel reconnecting
 * after a drop (it says why in `detail`) or given up on is offline; its first
 * connection, and a file the channel does not carry, read as an ordinary link.
 * Carrying the file is not having synced it: until Overleaf acknowledges the
 * last edit (`unacknowledged`), the file is still on its way.
 */
export function overleafSaveState({ paused, syncing, mode, channel, liveFile, unacknowledged, detail }: {
  paused: boolean;
  syncing: boolean;
  mode: OverleafSyncMode;
  channel: RealtimeStatus;
  liveFile: boolean;
  unacknowledged: boolean;
  detail: string | null;
}): OverleafSaveLayer["state"] {
  if (paused) return "paused";
  if (syncing) return "syncing";
  if (mode !== "live") return "manual";
  if (channel === "live" && liveFile) return unacknowledged ? "sending" : "live";
  if (channel === "error" || (channel === "connecting" && detail)) return "offline";
  return "manual";
}

export type SaveSlot = {
  status: SaveStatus;
  overleaf: OverleafSaveLayer | null;
  onRetry: () => void;
  onSaveCopy: () => void;
  onSync: () => void;
};
