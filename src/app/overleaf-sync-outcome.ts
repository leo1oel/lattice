import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { noteHostFileWrites } from "../agent/agent-host-writes";
import type { OpenProjectFile, OverleafSyncResult } from "../app-types";
import { parseConflictBlocks } from "../history/conflict-markers";
import { i18n } from "../i18n";
import { showError, showingErrors, showWarning } from "./notify";

/** Opens a conflicted file at its first spot, while the sync is still current. */
export const conflictOpener = (stillCurrent: () => boolean, open: OpenProjectFile) => (path: string, line = 1) => {
  if (stillCurrent()) void open(path, { line });
};

/**
 * Tell the agent panel which files the sync wrote, and the writer what its
 * conflicts left: a text file with spots to resolve opens in the editor,
 * where each spot carries its own choices (conflict-choices.ts); a figure
 * changed on both sides keeps the newer copy, and says whose, with the other
 * one a click away.
 *
 * Overleaf's text is a co-author's: a running agent turn must not count it as
 * its own change, or the turn's Undo would delete it and upload the deletion
 * (see agent-host-writes.ts).
 *
 * A later disk write can supersede the snapshot, so never point at spots in a
 * clean file; an unreadable one is opened, which shows what it holds. Returns
 * false when the sync stopped being current while files were read.
 */
export async function reportSyncOutcome({ result, projectRoot, stillCurrent, openConflict, restored }: {
  result: OverleafSyncResult;
  projectRoot: string;
  stillCurrent: () => boolean;
  /** Opens `path` in the editor at `line`, bringing the editor on screen. */
  openConflict: (path: string, line: number) => void;
  /** A set-aside copy went back on its path: an edit for the next sync to send. */
  restored: (paths: string[]) => void;
}): Promise<boolean> {
  noteHostFileWrites(projectRoot, [
    ...result.pulled, ...result.merged, ...result.conflicts.map((item) => item.path), ...result.deletedLocal,
  ]);
  if (!result.conflicts.length) return true;
  const marked: (OverleafSyncResult["conflicts"][number] & { line: number })[] = [];
  for (const item of result.conflicts.filter((conflict) => conflict.markers !== false)) {
    const content = await invoke<string>("read_project_file", { path: item.path, projectRoot }).catch(() => null);
    const spot = content === null ? undefined : parseConflictBlocks(content).find((block) => block.kind === "conflict");
    if (content === null || spot) marked.push({ ...item, line: spot?.line ?? 1 });
    if (!stillCurrent()) return false;
  }
  if (marked.length) {
    const files = marked.map((item) => item.path).join(", ");
    showError(i18n._(msg`${files} changed in the same place here and on Overleaf. Choose what to keep at each marked spot in the editor; nothing uploads until then.`), "Overleaf");
  }
  for (const item of result.conflicts.filter((conflict) => conflict.markers === false)) {
    const file = item.path;
    const message = item.kept === "thisMac"
      ? i18n._(msg`${file} changed here and on Overleaf. Yours is newer, so it stays and goes up; Overleaf's is kept aside.`)
      : i18n._(msg`${file} changed here and on Overleaf. Overleaf's is newer, so it replaced yours; yours is kept aside.`);
    showWarning(message, "Overleaf", {
      label: item.kept === "thisMac" ? i18n._(msg`Use Overleaf's`) : i18n._(msg`Use mine`),
      onClick: () => void showingErrors(async () => {
        await invoke("overleaf_restore_set_aside", { projectRoot, setAside: item.setAside, path: item.path });
        if (stillCurrent()) restored([item.path]);
      }),
    });
  }
  if (marked[0]) openConflict(marked[0].path, marked[0].line);
  return true;
}
