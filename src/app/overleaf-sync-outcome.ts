import { noteHostFileWrites } from "../agent/agent-host-writes";
import type { OpenProjectFile } from "../app-types";
import type { ConflictReport } from "./overleaf-sync-conflicts";

/** Opens a conflicted file at its first spot, while the sync is still current. */
export const conflictOpener = (stillCurrent: () => boolean, open: OpenProjectFile) => (path: string, line = 1) => {
  if (stillCurrent()) void open(path, { line });
};

/**
 * Tell the agent panel which files the sync wrote, and the writer what its
 * conflicts left (overleaf-sync-conflicts.ts, loaded only when there are
 * some, for the eager-JS budget).
 *
 * Overleaf's text is a co-author's: a running agent turn must not count it as
 * its own change, or the turn's Undo would delete it and upload the deletion
 * (see agent-host-writes.ts). Returns false when the sync stopped being
 * current while files were read.
 */
export async function reportSyncOutcome(report: ConflictReport): Promise<boolean> {
  const { result, projectRoot } = report;
  noteHostFileWrites(projectRoot, [
    ...result.pulled, ...result.merged, ...result.conflicts.map((item) => item.path), ...result.deletedLocal,
  ]);
  if (!result.conflicts.length) return true;
  return (await import("./overleaf-sync-conflicts")).reportConflicts(report);
}

