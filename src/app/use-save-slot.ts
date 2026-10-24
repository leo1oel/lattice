/**
 * The canvas's save slot: whether the document in front is saved, and whether
 * the saved text has reached Overleaf too, with the slot's retry, save-a-copy
 * and sync actions.
 */
import { useMemo } from "react";
import { overleafSaveState, type SaveSlot } from "../canvas/save-slot";
import { useStableHandlers } from "./effect-helpers";
import { saveSourceCopy } from "./save-source-copy";
import type { OpenDocuments } from "./use-open-documents";
import type { useOverleafWorkspace } from "./use-overleaf-workspace";

export function useSaveSlot(
  documents: OpenDocuments,
  overleaf: Pick<ReturnType<typeof useOverleafWorkspace>, "overleafLink" | "overleafSyncing" | "overleafSyncMode" | "overleafRealtime">,
  syncOverleaf: () => void,
): SaveSlot {
  const { overleafLink, overleafSyncing, overleafSyncMode, overleafRealtime } = overleaf;
  // The save slot's second layer (S1): whether the saved text has reached Overleaf too.
  const overleafSaveLayerState = overleafLink ? overleafSaveState({
    paused: Boolean(overleafLink.paused), syncing: overleafSyncing, mode: overleafSyncMode,
    channel: overleafRealtime.status, liveFile: overleafRealtime.liveFile,
    unacknowledged: overleafRealtime.unacknowledged, detail: overleafRealtime.detail,
  }) : null;
  const overleafLastSync = overleafLink?.lastSync ?? null;
  const saveSlotHandlers = useStableHandlers({
    onRetry: () => void documents.save(),
    // The copy is of the document whose write failed, as the slot names it:
    // with a Paper in front that is its reading file, not the retained source.
    onSaveCopy: () => {
      const path = documents.saveStatus.path ?? documents.canvas.path;
      const text = documents.bufferText(path);
      if (text !== null) void saveSourceCopy(path, text);
    },
    onSync: syncOverleaf,
  });
  // Memoized, as App re-renders on every keystroke and the slot is a popover.
  const saveStatus = documents.saveStatus;
  return useMemo<SaveSlot>(() => ({
    status: saveStatus,
    overleaf: overleafSaveLayerState ? { state: overleafSaveLayerState, lastSync: overleafLastSync } : null,
    ...saveSlotHandlers,
  }), [overleafLastSync, overleafSaveLayerState, saveSlotHandlers, saveStatus]);
}
