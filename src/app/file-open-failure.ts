import { msg } from "@lingui/core/macro";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { formatSize, projectItemPath, toMessage } from "../app-utils";
import { i18n } from "../i18n";
import { notifyError } from "../telemetry/app-notify";
import { showError } from "./notify";

// Matched in backend text: src-tauri/src/project/tree.rs `too_large`.
const TOO_LARGE = /^This file is too large to open in the editor \((\d+) bytes; the limit is (\d+) bytes\)\.$/;

/**
 * Say why the project file `path` did not open. A text file past the
 * editor's size limit is not called binary: it gets both sizes, in the
 * interface language, and a way to it in Finder, where another app can open
 * it. Anything else shows as it came.
 */
export function showFileOpenFailure(reason: unknown, root: string | undefined, path: string) {
  const reported = toMessage(reason);
  const tooLarge = TOO_LARGE.exec(reported);
  if (!tooLarge) {
    showError(reported);
    return;
  }
  const name = path.split("/").pop() ?? path;
  const size = formatSize(Number(tooLarge[1]));
  const limit = formatSize(Number(tooLarge[2]));
  const reveal = (projectRoot: string) => revealItemInDir(projectItemPath(projectRoot, path)).catch((failure: unknown) => {
    const message = toMessage(failure);
    showError(i18n._(msg`Could not show that item in Finder. ${message}`));
  });
  notifyError(i18n._(msg`App`), i18n._(msg`${name} is too large to open in the editor`), {
    detail: i18n._(msg`It is ${size}; the editor opens files up to ${limit}. Open it in another app instead.`),
    primaryAction: root ? { label: i18n._(msg`Show in Finder`), onClick: () => reveal(root) } : undefined,
  });
}
