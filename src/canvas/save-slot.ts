import type { SaveStatus } from "../app/use-open-documents";
import type { RealtimeStatus } from "../overleaf/overleaf-realtime-model";
import type { OverleafSyncMode } from "../settings/app-settings";

/**
 * Where the linked Overleaf project stands, as the save slot words it:
 * - `live`: edits go to Overleaf as they are typed;
 * - `syncing`: a sync is running;
 * - `offline`: the live channel dropped, so edits wait on this Mac;
 * - `manual`: edits go when the writer syncs;
 * - `paused`: the link is paused.
 */
export type OverleafSaveLayer = { state: "live" | "syncing" | "offline" | "manual" | "paused"; lastSync: string | null };

/**
 * The layer's state for the file on screen. The live channel reconnecting
 * after a drop (it says why in `detail`) or given up on is offline; its first
 * connection, and a file the channel does not carry, read as an ordinary link.
 */
export function overleafSaveState({ paused, syncing, mode, channel, liveFile, detail }: {
  paused: boolean;
  syncing: boolean;
  mode: OverleafSyncMode;
  channel: RealtimeStatus;
  liveFile: boolean;
  detail: string | null;
}): OverleafSaveLayer["state"] {
  if (paused) return "paused";
  if (syncing) return "syncing";
  if (mode !== "live") return "manual";
  if (channel === "live" && liveFile) return "live";
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
