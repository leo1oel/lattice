/**
 * The way out of a merge a git sync stopped on: the toast that offers Finish
 * merge and Cancel merge, and Cancel itself. Loaded only when a merge is open
 * (use-overleaf-workspace.ts imports it on demand), for the eager-JS budget.
 */
import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import type { OverleafSyncResult } from "../app-types";
import { confirmAction } from "../app-utils";
import { i18n } from "../i18n";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import { logAction, notifyWarning } from "../telemetry/app-notify";

/** One toast per window: a later sync's word on the merge replaces the earlier. */
export const MERGE_TOAST = "overleaf-git-merge";

type GitMergeCancel = {
  projectRoot: string;
  stillCurrent: () => boolean;
  /** Saves the editor; false when it could not. */
  save: () => Promise<boolean>;
  /** Re-reads the project and the open file after the folder went back. */
  reload: () => Promise<void>;
};

/**
 * Say that a git sync left a merge with Overleaf open, and offer the two ways
 * out. It stays up until one of them succeeds: an open merge blocks every
 * later sync, so a toast that timed out, or went with a finish refused over a
 * file still marked up, would leave the writer with only an error.
 *
 * Files still marked up are named; a file git cannot mark up (a figure, a
 * PDF) has kept this computer's version, which finishing the merge keeps.
 */
export function showOverleafGitMerge(result: OverleafSyncResult, actions: { finish: () => void; cancel: () => void }) {
  const marked = result.conflicts.filter((item) => item.markers).map((item) => item.path);
  const files = marked.join(", ");
  notifyWarning(i18n._(msg`Overleaf`), i18n._(msg`A merge with Overleaf is waiting on you`), {
    detail: marked.length
      ? i18n._(msg`Resolve the marked spots in ${files}, then finish the merge to send it up. Cancel puts the project back as it was before this sync.`)
      : i18n._(msg`Every marked spot is resolved. Finish the merge to send it up, or cancel it to put the project back as it was before this sync.`),
    timeoutMs: 0,
    dedupeKey: MERGE_TOAST,
    primaryAction: { label: i18n._(msg`Finish merge`), onClick: actions.finish, keepOpen: true },
    secondaryAction: { label: i18n._(msg`Cancel merge`), onClick: actions.cancel, keepOpen: true },
  });
}

/**
 * Cancel the merge a git sync stopped on. Asked first: the spots already
 * resolved are discarded with it. The editor is saved before, so a stale
 * buffer cannot write the merge's text back over the restored file.
 */
export async function cancelOverleafGitMerge({ projectRoot, stillCurrent, save, reload }: GitMergeCancel) {
  const confirmed = await confirmAction({
    title: i18n._(msg`Cancel the merge with Overleaf?`),
    message: i18n._(msg`The project goes back to how it was before this sync, and the spots you resolved are discarded. Overleaf keeps its changes; the next sync brings them in again.`),
    confirmLabel: i18n._(msg`Cancel merge`),
    cancelLabel: i18n._(msg`Keep merging`),
    destructive: true,
  }).catch(() => false);
  if (!confirmed || !stillCurrent() || !(await save()) || !stillCurrent()) return;
  const trace = logAction("Overleaf", i18n._(msg`Cancel merge`), projectRoot);
  try {
    await invoke("overleaf_git_abort_merge", { projectRoot });
    if (!stillCurrent()) return;
    dismissAppToastByDedupeKey(MERGE_TOAST);
    await reload();
    trace.ok(i18n._(msg`Merge with Overleaf cancelled`));
  } catch (reason) {
    trace.fail(reason);
  }
}
