import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import type { OverleafSyncResult } from "../app-types";
import { hasConflictMarkers } from "../history/conflict-markers";
import { i18n } from "../i18n";
import { showError } from "./notify";

/**
 * Tell the writer what a sync's conflicts left on disk, and open the
 * resolver on the first file that has spots to resolve.
 *
 * Only a file with markers has spots to resolve; for a figure or PDF, say
 * plainly that both versions are sitting on disk. A later disk write can
 * supersede the snapshot, so never demand choices for a clean file; an
 * unreadable one goes to the resolver, which reports it. Returns false when
 * the sync stopped being current while files were read.
 */
export async function reportSyncConflicts({ result, projectRoot, stillCurrent, openConflict }: {
  result: OverleafSyncResult;
  projectRoot: string;
  stillCurrent: () => boolean;
  openConflict: (path: string) => void;
}): Promise<boolean> {
  if (!result.conflicts.length) return true;
  const marked: OverleafSyncResult["conflicts"] = [];
  for (const item of result.conflicts.filter((conflict) => conflict.markers !== false)) {
    const content = await invoke<string>("read_project_file", { path: item.path, projectRoot }).catch(() => null);
    if (content === null || hasConflictMarkers(content)) marked.push(item);
    if (!stillCurrent()) return false;
  }
  const whole = result.conflicts.filter((item) => item.markers === false);
  const markedFiles = marked.map((item) => item.path).join(", ");
  const wholeFiles = whole.map((item) => item.path).join(", ");
  const parts = [
    marked.length ? i18n._(msg`Couldn’t merge ${markedFiles}. Both versions are kept; resolve each spot to finish. Nothing uploads until then.`) : "",
    whole.length ? i18n._(msg`${wholeFiles} changed on both sides. Overleaf’s version is in the project; yours is in the “(local conflict …)” file beside it.`) : "",
  ].filter(Boolean);
  if (parts.length) showError(parts.join(" "));
  // Only worth opening for a file that actually has markers in it.
  if (marked[0]) openConflict(marked[0].path);
  return true;
}
