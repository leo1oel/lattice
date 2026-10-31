import { t } from "@lingui/core/macro";
import type { OverleafSyncResult } from "../app-types";

/**
 * What a finished sync left undone that would otherwise look synced: one
 * warning each, so the absence is not first discovered from the other side.
 */
export function overleafSyncWarnings(result: OverleafSyncResult): string[] {
  const warnings: string[] = [];
  if (result.skippedLarge?.length) {
    const files = result.skippedLarge.join(", ");
    warnings.push(t`Too large for Overleaf, so left on this machine: ${files}.`);
  }
  // A download that would have emptied or gutted files nobody changed on
  // Overleaf. Said once: the files simply stay, and the reason is that
  // Overleaf's own history does not confirm the change.
  if (result.refusedIncoming?.length) {
    const files = result.refusedIncoming.join(", ");
    warnings.push(t`Kept your copy of ${files}. Overleaf sent these files empty or much smaller, but its history does not confirm the change. To take Overleaf's version anyway, delete the file here and sync again.`);
  }
  // Overleaf keeps names apart that this Mac's disk treats as one; the sync
  // takes the first of each pair and leaves the other alone on both sides.
  if (result.caseCollisions?.length) {
    const pairs = result.caseCollisions.map(({ kept, skipped }) => `${kept} / ${skipped}`).join(", ");
    warnings.push(t`Overleaf has names that differ only in capitalization, which this Mac treats as the same name: ${pairs}. Only the first of each pair syncs here. Rename one of them on Overleaf to sync both.`);
  }
  return warnings;
}
