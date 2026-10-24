import { msg } from "@lingui/core/macro";
import { useCallback } from "react";
import type { ProjectSnapshot } from "../app-types";
import type { OpenSlideMutation, OpenSlideSyncOperation } from "../editor/presentation/open-slide-bridge";
import { i18n } from "../i18n";
import { flattenProjectPaths } from "../build/compile-diagnostics";
import { isOpenSlideDeckPath, isProjectSourceFilePath } from "../app-utils";
import { showWarning } from "./notify";
import { writeOpenSlideMutation } from "./open-slide-writes";

/**
 * Applies one Open Slide save to the project, and answers with the canonical
 * bytes the runtime's shadow copy should take: a three-way merge can land
 * something other than what Open Slide sent.
 */
export function useApplyOpenSlideMutation({
  projectRef, activeFileRef, accept, recordSavedPaths, refreshProject, refreshHistory, loadFile, clearEditor,
}: {
  projectRef: { readonly current: ProjectSnapshot | null };
  activeFileRef: { readonly current: string };
  accept: (path: string, content: string) => unknown;
  recordSavedPaths: (paths: readonly string[]) => void;
  refreshProject: () => Promise<ProjectSnapshot>;
  refreshHistory: () => Promise<unknown>;
  loadFile: (path: string, options: { restoreView: false }) => Promise<unknown>;
  clearEditor: () => void;
}) {
  return useCallback(async (
    mutation: OpenSlideMutation,
  ): Promise<OpenSlideSyncOperation[]> => {
    const projectRoot = projectRef.current?.root;
    if (!projectRoot) throw new Error(i18n._(msg`The project closed before the Open Slide edit could be saved.`));
    const written = await writeOpenSlideMutation(mutation, projectRoot, () => projectRef.current?.root === projectRoot);
    if (written.text !== undefined) accept(mutation.path, written.text);
    if (written.hadConflicts) {
      const path = mutation.path;
      showWarning(i18n._(msg`Open Slide and another editor changed the same lines in ${path}; Lattice kept both with conflict markers.`));
    }
    const snapshot = await refreshProject();
    await refreshHistory();
    const deckPath = [mutation.path, activeFileRef.current].find(isOpenSlideDeckPath);
    if (deckPath) recordSavedPaths([deckPath]);
    if (mutation.kind === "delete" && activeFileRef.current === mutation.path) {
      const replacement = flattenProjectPaths(snapshot.files).find((candidate) => (
        candidate !== mutation.path && isProjectSourceFilePath(candidate)
      ));
      if (replacement) await loadFile(replacement, { restoreView: false });
      else clearEditor();
    }
    return mutation.kind === "delete"
      ? [{ path: mutation.path, kind: "delete" }]
      : [{
          path: mutation.path,
          kind: mutation.kind,
          ...(written.text !== undefined ? { text: written.text } : { base64: written.base64 }),
        }];
  }, [accept, activeFileRef, clearEditor, loadFile, projectRef, recordSavedPaths, refreshHistory, refreshProject]);
}
