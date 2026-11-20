import { t } from "@lingui/core/macro";
import type { OverleafSyncResult } from "../app-types";

/**
 * The line a finished sync ends on: what moved, or why nothing did. A file
 * held back still marked up is not synced, so it never reads as up to date,
 * whether this sync just left it so or an earlier one did.
 */
export function overleafSyncSummary(result: OverleafSyncResult): string {
  const pulled = result.pulled.length;
  const pushed = result.pushed.length;
  const merged = result.merged.length;
  if (merged) return t`Overleaf: pulled ${pulled}, pushed ${pushed}, merged ${merged}.`;
  if (pulled || pushed) return t`Overleaf: pulled ${pulled}, pushed ${pushed}.`;
  const files = [...new Set([...result.conflicts.map((item) => item.path), ...(result.unresolvedConflicts ?? [])])].join(", ");
  return files ? t`Overleaf: waiting on conflict resolution in ${files}.` : t`Overleaf: already up to date.`;
}
