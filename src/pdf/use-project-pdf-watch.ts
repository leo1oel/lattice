import { useEffect } from "react";
import { useLatestRef } from "../hooks/use-latest-ref";
import { changesReach, onProjectFilesChanged } from "../project/project-files-changed";

/** How often an open project PDF is checked against the file on disk when no watcher event says so first. */
export const PDF_RECHECK_MS = 2500;

/**
 * Ask `recheck` to compare an open project PDF with the version on disk.
 *
 * The viewer reads a PDF a range at a time from one version of the file, and
 * a page PDF.js has already read makes no further read, so a rewrite (a
 * build, the agent, an Overleaf pull) can never surface through the viewer
 * alone: neither can the project tree, which carries no version and does not
 * change when a file keeps its size. Every surface showing a project PDF, the
 * live document and a PDF kept open beside the notes alike, checks on the
 * watcher's reports that reach the file and on a poll for what a watcher
 * misses; a removed file is polled half as often until it comes back.
 * `path` null (nothing shown, or not a ranged PDF) checks nothing.
 */
export function useProjectPdfWatch(
  projectRoot: string | null | undefined,
  path: string | null,
  missing: boolean,
  recheck: () => void,
) {
  const recheckRef = useLatestRef(recheck);
  useEffect(() => {
    if (!projectRoot || !path) return;
    const check = () => recheckRef.current();
    const timer = window.setInterval(check, missing ? 2 * PDF_RECHECK_MS : PDF_RECHECK_MS);
    const stopListening = onProjectFilesChanged(projectRoot, (paths) => {
      if (changesReach(paths, path)) check();
    });
    return () => {
      window.clearInterval(timer);
      stopListening();
    };
  }, [missing, path, projectRoot, recheckRef]);
}
