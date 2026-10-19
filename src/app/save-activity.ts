/**
 * What the editor's saves are doing: the save slot's report, and the counts
 * the disk-change detector checks so it never mistakes a save of ours, still
 * under way, for an edit made behind the editor.
 */
import type { Dispatch, SetStateAction } from "react";

/**
 * What the status bar's save slot reports: the last write to disk, as the
 * save promise resolved it. Autosave writes a moment after typing stops, so
 * "saving" is only shown for a write still running after SAVING_SHOWN_AFTER_MS;
 * a quick one goes straight from saved to saved, with no flicker.
 */
export type SaveStatus = {
  phase: "saved" | "saving" | "failed";
  /** When the last write landed or failed; null until this session writes. */
  at: number | null;
  /** The file that write was for. */
  path: string | null;
  /** Why it failed, in the system's words. */
  error?: string;
};

const SAVING_SHOWN_AFTER_MS = 400;
export const NOTHING_SAVED: SaveStatus = { phase: "saved", at: null, path: null };

/**
 * Saves asked for and not yet settled, every save ever asked for, and the
 * last one asked for, which the next waits behind (never rejects).
 */
export type SaveActivity = { pending: number; generation: number; queue: Promise<boolean> };

export const createSaveActivity = (): SaveActivity => ({ pending: 0, generation: 0, queue: Promise.resolve(true) });

/**
 * Run one save of the project at `root`, keeping `activity` counted and the
 * save slot honest. Kept outside the save body: React Compiler cannot lower
 * try/finally, while Promise.finally still covers every early return/error.
 *
 * One save at a time. Each sends the saved text as the base the backend
 * merges against, and that text only moves on when the save before it
 * answers. A second save sent meanwhile (autosave after an undo, a blur, a
 * build) carried the older base, so the writer's own first save looked like
 * an outside edit on disk and the merge put conflict markers between the two.
 * Queued, it reads the buffer and its base once the first has landed; with
 * nothing under way, it takes the buffer as it is now, as callers expect.
 */
export function trackSave(
  activity: SaveActivity,
  root: string | undefined,
  setSaveStatus: Dispatch<SetStateAction<SaveStatus & { root?: string }>>,
  saveContents: () => Promise<boolean>,
): Promise<boolean> {
  const idle = activity.pending === 0;
  activity.pending += 1;
  activity.generation += 1;
  const slow = window.setTimeout(() => setSaveStatus((status) => ({ ...(status.root === root ? status : NOTHING_SAVED), phase: "saving", root })), SAVING_SHOWN_AFTER_MS);
  const saving = idle ? saveContents() : activity.queue.then(saveContents);
  activity.queue = saving.catch(() => false);
  return saving.finally(() => {
    activity.pending -= 1;
    window.clearTimeout(slow);
    // A slow save that wrote nothing (another save had already written it) leaves the last word standing.
    setSaveStatus((status) => (status.phase === "saving" ? { ...status, phase: "saved" } : status));
  });
}
