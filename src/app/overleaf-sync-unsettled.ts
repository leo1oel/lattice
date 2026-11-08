import type { OverleafSyncResult } from "../app-types";

/**
 * Paths a finished sync left unsettled: conflicted, still marked up from an
 * earlier conflict, deleted, held back or too large. Live editing must not
 * rejoin them, because the file on disk and Overleaf's copy still disagree
 * and only a later sync, after the writer acts, brings them together.
 */
export function unsettledPaths(result: OverleafSyncResult): string[] {
  return [
    ...result.conflicts.map((conflict) => conflict.path), ...(result.unresolvedConflicts ?? []),
    ...result.deletedLocal, ...result.skippedRemoteDeletes, ...(result.skippedLarge ?? []),
    // A refused download whose local copy went up instead is settled.
    ...(result.refusedIncoming ?? []).filter((path) => !result.pushed.includes(path)),
  ];
}
