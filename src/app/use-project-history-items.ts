import { useMemo } from "react";
import type { HistoryItem } from "../history/history-drawer";

/**
 * The project's saved history and the agent's checkpoints as one list, newest
 * first. Cached on the two lists alone: App re-renders on every keystroke, and
 * neither list changes then, so typing never re-sorts the history.
 */
export function useProjectHistoryItems(history: HistoryItem[], checkpointHistory: HistoryItem[]): HistoryItem[] {
  return useMemo(() => [...history, ...checkpointHistory].sort((left, right) => (
    right.timestamp.localeCompare(left.timestamp)
  )), [checkpointHistory, history]);
}
