import { t } from "@lingui/core/macro";
import type { OverleafNameProblem, OverleafSyncResult } from "../app-types";
import type { AppToastAction } from "../telemetry/app-log-store";

export type OverleafSyncWarning = { message: string; action?: AppToastAction };

/** Why a file stays here: the rule of Overleaf's that its name breaks. */
function nameWarning(file: string, problem: OverleafNameProblem): string {
  switch (problem) {
    case "backslash":
      return t`Overleaf does not allow a backslash in file names, so ${file} stays on this machine. Rename it to sync it.`;
    case "asterisk":
      return t`Overleaf does not allow an asterisk in file names, so ${file} stays on this machine. Rename it to sync it.`;
    case "controlCharacter":
      return t`Overleaf does not allow control characters in file names, so ${file} stays on this machine. Rename it to sync it.`;
    case "dotsOrSpaces":
      return t`Overleaf does not allow a name that is a dot, or starts or ends with a space, so ${file} stays on this machine. Rename it to sync it.`;
    case "reserved":
      return t`Overleaf reserves the name ${file} at the top of a project, so it stays on this machine. Rename it to sync it.`;
    case "tooLong":
      return t`Overleaf does not allow names longer than 1024 characters, so ${file} stays on this machine. Rename it to sync it.`;
  }
}

/**
 * What a finished sync left undone that would otherwise look synced: one
 * warning each, so the absence is not first discovered from the other side.
 * `resolve` opens the conflict resolver on a file.
 */
export function overleafSyncWarnings(
  result: OverleafSyncResult, resolve: (path: string) => void,
): OverleafSyncWarning[] {
  const warnings: string[] = [];
  // An empty list joins to "", so each list below is said only when it names a file.
  let files = result.skippedLarge?.join(", ");
  if (files) warnings.push(t`Too large for Overleaf, so left on this machine: ${files}.`);
  // A name Overleaf refuses would fail its upload and, with it, the sync:
  // the file stays here, named on every sync with what to rename.
  for (const { path, problem } of result.skippedNames ?? []) warnings.push(nameWarning(path, problem));
  // A download that would have emptied or gutted files nobody changed on
  // Overleaf. Said once: the files simply stay, and the reason is that
  // Overleaf's own history does not confirm the change.
  files = result.refusedIncoming?.join(", ");
  if (files) {
    warnings.push(t`Kept your copy of ${files}. Overleaf sent these files empty or much smaller, but its history does not confirm the change. To take Overleaf's version anyway, delete the file here and sync again.`);
  }
  // Without the live channel a document goes up whole, and someone's edit
  // reached the project while one did. Which file they were in is not known,
  // so this says "may", and points to where their words are kept.
  files = result.uploadedOverEdits?.join(", ");
  if (files) {
    warnings.push(t`Someone edited the Overleaf project while ${files} uploaded. An upload replaces the whole file, so it may have overwritten their latest typing there. Check the file's history on Overleaf to bring back anything missing.`);
  }
  // Overleaf keeps names apart that this Mac's disk treats as one; the sync
  // takes the first of each pair and leaves the other alone on both sides.
  if (result.caseCollisions?.length) {
    const pairs = result.caseCollisions.map(({ kept, skipped }) => `${kept} / ${skipped}`).join(", ");
    warnings.push(t`Overleaf has names that differ only in capitalization, which this Mac treats as the same name: ${pairs}. Only the first of each pair syncs here. Rename one of them on Overleaf to sync both.`);
  }
  // Edited here and renamed or removed on Overleaf where the sync could not
  // follow: sending it under its old name would split the file, so it waits.
  // Named on every sync while held, with the way out.
  for (const file of result.heldRenames ?? []) {
    warnings.push(t`Overleaf renamed or removed ${file} while it was edited here, and Lattice could not tell where the edit belongs, so it stays here unsent. Copy the edit into the right file, then delete ${file} here.`);
  }
  // A folder deleted or renamed on Overleaf whose build outputs and empty
  // subfolders the sync cleared, kept for the writer's own files in it.
  for (const { folder, files: kept } of result.keptFolders ?? []) {
    const names = kept.join(", ");
    warnings.push(t`Overleaf no longer has the folder ${folder}. It stays here because it still holds files that never sync: ${names}. Delete them here if you no longer need them.`);
  }
  // Held back while Overleaf moves on, named once when the hold starts: the
  // backend leaves out files the previous sync was holding already.
  const held = (result.newlyUnresolvedConflicts ?? []).map((file) => ({
    message: t`${file} still has conflict markers. Resolve them to bring in Overleaf's newer edits.`,
    action: { label: t`Resolve`, onClick: () => resolve(file) },
  }));
  return [...warnings.map((message) => ({ message })), ...held];
}
