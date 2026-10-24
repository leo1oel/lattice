import { useCallback, useEffect } from "react";
import type { DocumentViewMode, PaperSummary, ProjectSnapshot } from "../app-types";
import { arxivIdFromTabKey, isHtmlFilePath, isPaperTabKey } from "../app-utils";
import { loadLastFile, loadWorkspaceLayout, persistLastFile, persistWorkspaceLayout } from "../settings/app-settings";
import type { DocumentOpens } from "./use-document-opens";
import type { DocumentStore } from "./use-document-store";
import { planWorkspaceRestore } from "./workspace-restore";

/** A project being entered: restore its saved tabs, then (after the project's slow scans) its Paper or asset surface. */
export type ProjectEntry = {
  /**
   * Put back the primary file, the tabs in strip order, the canvas mode and
   * the Paper view from the saved layout. Resolves false when the writer
   * opened something meanwhile (their document wins) or the project changed.
   */
  restore(papers: PaperSummary[]): Promise<boolean>;
  /** Open the restored Paper or asset tab through its reader, then start persisting the layout. */
  finish(): void;
};

/**
 * The project's tab layout: restored when a project is entered, and saved
 * (with the file open last) as it changes once that restore finished.
 */
export function useWorkspaceLayout(store: DocumentStore, opens: DocumentOpens) {
  const {
    depsRef, projectRef, projectOperationGenerationRef, projectRoot, intentRef, viewStates,
    file, tabs, setTabs, activeTab, mode, setMode, paperView, setPaperView, htmlModesRef, documentModeRef, bibModeRef,
    persistenceReadyRoot, setPersistenceReadyRoot, setTabsSettledRoot, setNavStack, setNavIndex,
    setPaper, setAssetLive, setPaperBuffers, showFileText,
  } = store;
  const { loadFile, openPaper, openAsset, choosePaperView } = opens;

  // ---- Layout persistence -----------------------------------------------------------------------------------------
  useEffect(() => {
    if (!projectRoot || persistenceReadyRoot !== projectRoot) return;
    persistWorkspaceLayout(projectRoot, {
      openTabs: tabs,
      activeFile: file,
      activeTab,
      canvasMode: mode,
      documentMode: documentModeRef.current,
      bibMode: bibModeRef.current,
      paperView,
    });
  }, [activeTab, bibModeRef, documentModeRef, file, mode, paperView, persistenceReadyRoot, projectRoot, tabs]);
  // Remember the file open per project, so reopening it lands on the last page.
  useEffect(() => {
    if (projectRoot && file) persistLastFile(projectRoot, file);
  }, [projectRoot, file]);

  // ---- Project entry -------------------------------------------------------------------------------------------------
  /**
   * Start entering `snapshot`'s project: drop the outgoing documents before
   * the new root reaches any effect (an autosave or the incoming project's
   * first Overleaf sync could otherwise write the old relative path into the
   * new project). Call after the transition began and before the snapshot is
   * published as the current project.
   */
  const enter = useCallback((snapshot: ProjectSnapshot): ProjectEntry => {
    const projectGeneration = projectOperationGenerationRef.current;
    const restoreGeneration = intentRef.current + 1;
    intentRef.current = restoreGeneration;
    const ownsProjectRestore = () => (
      projectOperationGenerationRef.current === projectGeneration
      && projectRef.current?.root === snapshot.root
    );
    setPersistenceReadyRoot(null);
    setTabsSettledRoot(null);
    showFileText("", "");
    viewStates.loadForProject(snapshot.root);
    setPaper(null);
    setAssetLive(null);
    setPaperBuffers("", null);
    setTabs([]);
    setMode("split");
    htmlModesRef.current.clear();
    documentModeRef.current = "split";
    bibModeRef.current = "source";
    /** A newer file intent from the writer cancels the rest of the restore. */
    let primaryGeneration = restoreGeneration;
    const restoreIsCurrent = () => ownsProjectRestore() && intentRef.current === primaryGeneration;
    const supersede = () => {
      if (ownsProjectRestore()) setTabsSettledRoot(snapshot.root);
      return false;
    };
    let plan: ReturnType<typeof planWorkspaceRestore> | null = null;
    let plannedPapers: PaperSummary[] = [];
    return {
      restore: async (papers) => {
        plannedPapers = papers;
        plan = planWorkspaceRestore(snapshot, papers, loadWorkspaceLayout(snapshot.root), loadLastFile(snapshot.root));
        const { primaryFile, activeTab: restoredTab, mode: restoredMode } = plan;
        documentModeRef.current = plan.documentMode;
        bibModeRef.current = plan.bibMode;
        if (!restoreIsCurrent()) return supersede();
        if (primaryFile && !(await loadFile(primaryFile, { expectedProjectRoot: snapshot.root, projectGeneration }))) {
          return supersede();
        }
        primaryGeneration = intentRef.current;
        if (!ownsProjectRestore()) return false;
        if (!restoreIsCurrent()) return supersede();
        if (isHtmlFilePath(restoredTab)) htmlModesRef.current.set(restoredTab, restoredMode as DocumentViewMode);
        setTabs(plan.tabs);
        setTabsSettledRoot(snapshot.root);
        setMode(restoredMode);
        setPaperView(plan.paperView);
        setNavStack(primaryFile ? [{ path: primaryFile, line: 1 }] : []);
        setNavIndex(primaryFile ? 0 : -1);
        return true;
      },
      finish: () => {
        // The project's slow scans ran since restore(); a file the writer
        // opened meanwhile must not be replaced by the restored Paper or asset.
        if (!plan || plan.activeKind === "document" || !restoreIsCurrent()) {
          setPersistenceReadyRoot(snapshot.root);
          return;
        }
        // Paper and asset tabs load through their own readers once the base
        // project state exists; this finishes the active surface without
        // changing tab order.
        const { activeTab: restoredTab, mode: restoredMode, paperView: restoredView } = plan;
        void (async () => {
          if (isPaperTabKey(restoredTab)) {
            const arxivId = arxivIdFromTabKey(restoredTab);
            const target = depsRef.current.papers.find((item) => item.arxivId === arxivId)
              ?? plannedPapers.find((item) => item.arxivId === arxivId);
            if (target) {
              if (!(await openPaper(target))) return;
              if (projectRef.current?.root === snapshot.root) {
                choosePaperView(restoredView);
                setMode(restoredMode === "source" || restoredMode === "split" ? restoredMode : "pdf");
              }
            }
          } else if (!(await openAsset(restoredTab))) return;
          if (projectRef.current?.root === snapshot.root) setPersistenceReadyRoot(snapshot.root);
        })();
      },
    };
  }, [
    bibModeRef, choosePaperView, depsRef, documentModeRef, htmlModesRef, intentRef, loadFile, openAsset, openPaper,
    projectOperationGenerationRef, projectRef, setAssetLive, setMode, setNavIndex, setNavStack, setPaper,
    setPaperBuffers, setPaperView, setPersistenceReadyRoot, setTabs, setTabsSettledRoot, showFileText, viewStates,
  ]);

  return enter;
}
