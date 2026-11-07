/** An import's progress toast: shown once the import outlasts a glance, then replaced by its outcome. */
import { notifyInfo, updateAppToastProgress } from "../telemetry/app-notify";
import { subscribeTauriEvent } from "./effect-helpers";
import { listenInThisWindow } from "./window-events";

/** The toast a long import reports progress in, which its outcome then replaces. */
export const IMPORT_TOAST = "project-import";
/** An import that outlasts a glance shows its progress. */
const IMPORT_PROGRESS_DELAY_MS = 400;

/** Run an import, showing its `project-import-progress` in a toast once it takes long enough to wait on. */
export async function withImportProgress<T>(source: string, title: string, run: () => Promise<T>): Promise<T> {
  let fraction = 0;
  let shown = false;
  const timer = window.setTimeout(() => {
    shown = true;
    notifyInfo(source, title, { progress: fraction, dedupeKey: IMPORT_TOAST });
  }, IMPORT_PROGRESS_DELAY_MS);
  const stop = subscribeTauriEvent<{ written: number; total: number }>(
    (handler) => listenInThisWindow("project-import-progress", handler),
    ({ written, total }) => {
      fraction = total ? written / total : 1;
      if (shown) updateAppToastProgress(IMPORT_TOAST, fraction);
    },
  );
  try {
    return await run();
  } finally {
    window.clearTimeout(timer);
    stop();
  }
}
