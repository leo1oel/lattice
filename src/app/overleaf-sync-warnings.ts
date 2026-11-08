import { t } from "@lingui/core/macro";
import type { OverleafSyncResult } from "../app-types";
import type { AppToastAction } from "../telemetry/app-log-store";

export type OverleafSyncWarning = { message: string; action?: AppToastAction };

/**
 * What a finished sync left undone that would otherwise look synced: one
 * warning each, so the absence is not first discovered from the other side.
 * `resolve` opens the conflict resolver on a file.
 */
export function overleafSyncWarnings(
  result: OverleafSyncResult, resolve: (path: string) => void,
): OverleafSyncWarning[] {
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
  // Without the live channel a document goes up whole, and someone's edit
  // reached the project while one did. Which file they were in is not known,
  // so this says "may", and points to where their words are kept.
  if (result.uploadedOverEdits?.length) {
    const files = result.uploadedOverEdits.join(", ");
    warnings.push(t`Someone edited the Overleaf project while ${files} uploaded. An upload replaces the whole file, so it may have overwritten their latest typing there. Check the file's history on Overleaf to bring back anything missing.`);
  }
  // Overleaf keeps names apart that this Mac's disk treats as one; the sync
  // takes the first of each pair and leaves the other alone on both sides.
  if (result.caseCollisions?.length) {
    const pairs = result.caseCollisions.map(({ kept, skipped }) => `${kept} / ${skipped}`).join(", ");
    warnings.push(t`Overleaf has names that differ only in capitalization, which this Mac treats as the same name: ${pairs}. Only the first of each pair syncs here. Rename one of them on Overleaf to sync both.`);
  }
  // Held back while Overleaf moves on, named once when the hold starts: the
  // backend leaves out files the previous sync was holding already.
  const held = (result.newlyUnresolvedConflicts ?? []).map((file) => ({
    message: t`${file} still has conflict markers. Resolve them to bring in Overleaf's newer edits.`,
    action: { label: t`Resolve`, onClick: () => resolve(file) },
  }));
  return [...warnings.map((message) => ({ message })), ...held];
}
