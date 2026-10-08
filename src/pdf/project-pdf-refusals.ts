/**
 * How the backend refuses a project PDF read, told apart without loading
 * PDF.js: the app shell checks for a removed file on startup's eager path.
 */
/* eslint-disable lingui/no-unlocalized-strings -- the backend's refusal texts, matched and never shown */
const FILE_CHANGED = "This PDF changed on disk.";
const FILE_MISSING = "That file or folder no longer exists.";
/* eslint-enable lingui/no-unlocalized-strings */

const refusalMessage = (reason: unknown) => (reason instanceof Error ? reason.message : reason);

/** Whether a read was refused because the file is no longer there. */
export function isProjectFileMissing(reason: unknown): boolean {
  return refusalMessage(reason) === FILE_MISSING;
}

/** Whether a range read was refused because the file was rewritten or removed since it was opened. */
export function isProjectPdfStale(reason: unknown): boolean {
  return refusalMessage(reason) === FILE_CHANGED || isProjectFileMissing(reason);
}
