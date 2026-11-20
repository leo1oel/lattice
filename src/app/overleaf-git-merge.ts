import { msg } from "@lingui/core/macro";
import type { OverleafSyncResult } from "../app-types";
import { i18n } from "../i18n";
import { dismissAppToastByDedupeKey } from "../telemetry/app-log-store";
import { notifyWarning } from "../telemetry/app-notify";

/** One toast per window: a later sync's word on the merge replaces the earlier. */
const MERGE_TOAST = "overleaf-git-merge";

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

/** The merge was finished or cancelled: there is nothing left to offer. */
export function dismissOverleafGitMerge() {
  dismissAppToastByDedupeKey(MERGE_TOAST);
}
