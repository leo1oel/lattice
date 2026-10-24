import { useCallback } from "react";
import { isProjectSourceFilePath, remapProjectPath, type ProjectPathChange } from "../app-utils";
import { flattenProjectPaths } from "../build/compile-diagnostics";
import type { DocumentOpens } from "./use-document-opens";
import type { DocumentStore } from "./use-document-store";

/** Carry the open documents through entries the project tree deleted, moved or renamed. */
export function useDocumentTreeChanges(store: DocumentStore, loadFile: DocumentOpens["loadFile"]) {
  const {
    depsRef, renderedRef, intentRef, tabsRef, closedRef, setTabs, setNavStack, setOpening, setMode, viewStates,
    fileRef, setFile, setAsset, setAssetLive, showFileText,
  } = store;

  /**
   * `paths` were deleted from disk. Retire every tab-strip and navigation
   * reference to them (and to anything inside a deleted directory) before
   * the refresh await, so autosave cannot recreate a deleted buffer and a
   * background tab cannot reopen a missing file; then put the root document
   * (or another open source) in front of a deleted file.
   */
  const remove = useCallback(async (paths: readonly string[]) => {
    const { file: activeFile, paper: openPaperNow, asset: openAsset } = renderedRef.current;
    const gone = (candidate: string | null | undefined) => Boolean(
      candidate && paths.some((path) => candidate === path || candidate.startsWith(`${path}/`)),
    );
    const deletedActiveFile = gone(activeFile);
    const deletedActiveAsset = gone(openAsset?.path);
    const remainingTabs = tabsRef.current.filter((tab) => !gone(tab));
    tabsRef.current = remainingTabs;
    closedRef.current = closedRef.current.filter((tab) => !gone(tab));
    setTabs(remainingTabs);
    setNavStack((entries) => entries.filter((entry) => !gone(entry.path)));
    const { updateCanvasRequest } = depsRef.current;
    updateCanvasRequest("restore", (request) => request && gone(request.path) ? null : request);
    updateCanvasRequest("navigation", (request) => request && gone(request.path) ? null : request);
    if (deletedActiveFile) {
      intentRef.current += 1;
      setOpening(null);
      showFileText("", "");
    }
    if (deletedActiveAsset) setAssetLive(null);
    viewStates.forget([...paths], gone);
    const snapshot = await depsRef.current.refreshProject();
    if (deletedActiveFile && !openAsset && !openPaperNow) {
      const livePaths = new Set(flattenProjectPaths(snapshot.files));
      const rootDocument = snapshot.manifest.rootDocuments.find((document) => (
        document.isDefault && livePaths.has(document.path) && !gone(document.path)
      )) ?? snapshot.manifest.rootDocuments.find((document) => (
        livePaths.has(document.path) && !gone(document.path)
      ));
      const replacement = rootDocument?.path
        ?? remainingTabs.find((tab) => livePaths.has(tab) && isProjectSourceFilePath(tab))
        ?? [...livePaths].find(isProjectSourceFilePath);
      if (replacement) await loadFile(replacement);
    } else if (deletedActiveAsset) {
      setMode("split");
    }
  }, [
    closedRef, depsRef, intentRef, loadFile, renderedRef, setAssetLive, setMode, setNavStack, setOpening, setTabs,
    showFileText, tabsRef, viewStates,
  ]);

  /** Files moved or were renamed: carry the tabs, the open documents, history and remembered views along. */
  const move = useCallback((changes: readonly ProjectPathChange[]) => {
    if (changes.length === 0) return;
    const remap = (path: string) => remapProjectPath(path, changes);
    viewStates.remap(changes, remap);
    setTabs((current) => current.map(remap));
    fileRef.current = remap(fileRef.current);
    setFile((path) => remap(path));
    setAsset((shown) => shown && { ...shown, path: remap(shown.path) });
    setNavStack((entries) => entries.map((entry) => ({ ...entry, path: remap(entry.path) })));
    depsRef.current.updateCanvasRequest("restore", (request) => request ? { ...request, path: remap(request.path) } : request);
  }, [depsRef, fileRef, setAsset, setFile, setNavStack, setTabs, viewStates]);

  return { remove, move };
}
