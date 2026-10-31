/**
 * What App renders into the Trellis panels' hosts by portal: the project file
 * tree, the paper library, the agent, each panel's tab-bar action row, and the
 * editor's opening overlay. Trellis arranges the panels; App owns what is in
 * them. Each panel's content sits in its own PanelErrorBoundary, so a render
 * error there stays in that panel.
 *
 * A hook that returns the portals rather than a component: a component here
 * would render again with every App render, each keystroke included, for
 * nothing on screen.
 */
import { Suspense, useMemo, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { SynaraLoadingSurface } from "../agent/synara-loading-surface";
import { paperImportStageLabel } from "../papers/paper-import-progress";
import type { NewEntryRequest, NewEntryType } from "../project/project-new-entries";
import type { SymbolOccurrence } from "../project/references-panel";
import type { AppLocale, Theme } from "../settings/app-settings";
import type { TrellisController } from "../trellis/trellis-controller";
import { PanelErrorBoundary } from "../telemetry/panel-error-boundary";
import { PanelActions } from "../trellis/trellis-panel-actions";
import type { GitStatus, PaperSummary, ProjectSnapshot } from "../app-types";
import { PaperLibrary, ProjectFileTree, TrellisAgentSurface } from "./app-lazy-panels";
import { useStableHandlers } from "./effect-helpers";
import { showError } from "./notify";
import { OpeningOverlay } from "./opening-overlay";
import type { OpenDocuments } from "./use-open-documents";
import type { usePaperActions } from "./use-paper-actions";
import type { usePreviewPrewarm } from "./use-preview-prewarm";
import type { useProjectLibrary } from "./use-project-library";
import type { ProjectSearch } from "./use-project-search";
import type { useProjectTree } from "./use-project-tree";
import type { ReferenceImport } from "./use-reference-import";
import type { SynaraHost } from "./use-synara-host";
import type { ToolDrawers } from "./use-tool-drawers";

/** Papers' read state while the window's paper list is still another project's. */
const PAPERS_LOADING = { status: "loading" } as const;

/** The portals, or nothing on the welcome screen. */
export function usePanelPortals({
  project, documents, trellis, agentPresent, theme, appLocale, tree, prewarm, projectSearch, newEntry, gitFiles,
  rootDocumentPath, library, overleafSyncing, paperActions, referenceImport, openSymbolOccurrence, synara, tools,
  checkReferences,
}: {
  project: ProjectSnapshot | null;
  documents: OpenDocuments;
  trellis: TrellisController;
  agentPresent: boolean;
  theme: Theme;
  appLocale: AppLocale;
  tree: ReturnType<typeof useProjectTree>;
  prewarm: Pick<ReturnType<typeof usePreviewPrewarm>, "prewarmLikelyProjectFile" | "prewarmLikelyPaper">;
  projectSearch: { open: boolean; setOpen: Dispatch<SetStateAction<boolean>>; openFind: ProjectSearch["openFind"] };
  newEntry: { request: NewEntryRequest | null; requestNew: (type: NewEntryType) => void };
  gitFiles: GitStatus["files"];
  rootDocumentPath: string | null | undefined;
  library: Pick<ReturnType<typeof useProjectLibrary>, "papers" | "paperLoad" | "retryPapers" | "citations" | "unusedSymbols">;
  overleafSyncing: boolean;
  paperActions: ReturnType<typeof usePaperActions>;
  referenceImport: ReferenceImport;
  openSymbolOccurrence: (occurrence: SymbolOccurrence) => Promise<void>;
  synara: SynaraHost;
  tools: Pick<ToolDrawers, "open">;
  checkReferences: () => void;
}) {
  const { file: activeFile, paper: activePaper, asset: activeAsset, openPaper } = documents;
  const { papers, paperLoad, citations, unusedSymbols } = library;
  const { open: projectSearchOpen, setOpen: setProjectSearchOpen, openFind: openProjectFind } = projectSearch;
  const requestNewEntry = newEntry.requestNew;
  const primaryBibliography = project?.manifest.primaryBibliography ?? "";
  const protectedProjectPaths = useMemo(
    () => [...(rootDocumentPath ? [rootDocumentPath] : []), primaryBibliography],
    [primaryBibliography, rootDocumentPath],
  );
  // Panel action rows (Trellis tab-bar accessories): memoized, because App
  // re-renders on every keystroke and each row is a set of tooltip buttons.
  const { origin: synaraOrigin, permissionMode, autoModeAvailable, changePermissionMode } = synara;
  const panelActionHandlers = useStableHandlers({
    onCheckReferences: checkReferences,
    onDiscoverLiterature: () => tools.open("literature"),
  });
  const trellisActions = useMemo(() => {
    const actions = (mode: "project" | "papers" | "agent") => (
      <PanelActions
        mode={mode}
        synara={{ origin: synaraOrigin, permissionMode, autoModeAvailable, changePermissionMode }}
        openAddPapers={referenceImport.openAddSheet}
        {...panelActionHandlers}
        openProjectFind={openProjectFind}
        setProjectSearchOpen={setProjectSearchOpen}
        requestNewEntry={requestNewEntry}
      />
    );
    return { project: actions("project"), papers: actions("papers"), agent: actions("agent") };
    // `synara` is rebuilt each render; the row reads only the fields listed.
  }, [
    autoModeAvailable, changePermissionMode, openProjectFind, panelActionHandlers, permissionMode,
    referenceImport.openAddSheet, requestNewEntry, setProjectSearchOpen, synaraOrigin,
  ]);
  // The sidebar panels' callbacks are mostly inline, so they change on every
  // App render; the memoized panels get stable forwarders instead.
  const fileTreeHandlers = useStableHandlers({
    onFile: tree.openFileFromClick,
    onLikelyFile: prewarm.prewarmLikelyProjectFile,
    onAsset: tree.openAssetFromClick,
    onBeginFigureDrag: tree.beginFigureDrag,
    onBeginFileDrag: tree.beginFileDrag,
    onCreateEntry: tree.createEntry,
    onDeleteEntries: tree.deleteEntries,
    onRenameEntry: tree.renameEntry,
    onMoveEntries: tree.moveEntries,
    onCopyEntries: tree.copyEntries,
    onError: showError,
    onReveal: tree.revealItem,
    onImportAssets: tree.chooseAssets,
    onImportFiles: (targetDirectory: string) => void tree.chooseFiles(targetDirectory),
    onPasteImage: (targetDirectory: string) => void tree.importSystemClipboardImage(targetDirectory),
  });
  const paperLibraryHandlers = useStableHandlers({
    onReveal: tree.revealItem,
    onPaper: openPaper,
    onLikelyPaper: prewarm.prewarmLikelyPaper,
    onFetchFullText: (paper: PaperSummary) => void paperActions.fetchAndOpenPaper(paper),
    onCancelFetch: paperActions.cancelPaperFetches,
    onDeletePaper: paperActions.deletePaper,
    onEditBibEntry: (paper: PaperSummary) => void referenceImport.editBibEntry(paper),
    onOpenCitationUse: (usage: SymbolOccurrence) => void openSymbolOccurrence(usage),
    setImportInput: referenceImport.setInput,
    onImport: referenceImport.importFromInput,
    onCancelImport: referenceImport.cancelImport,
    onAddPapers: (seed: string) => referenceImport.openAddSheet(seed),
    onSearchLiterature: (query: string) => {
      referenceImport.searchLiterature(query);
      tools.open("literature");
    },
  });

  if (!project) return null;
  return (
    <>
      {createPortal(
        <PanelErrorBoundary name="project" resetKey={project.root}>
        <Suspense fallback={null}>
          <ProjectFileTree
            key={project.root}
            projectKey={project.root}
            searchOpen={projectSearchOpen}
            newEntryRequest={newEntry.request}
            revealRequest={tree.revealRequest}
            onSearchOpenChange={setProjectSearchOpen}
            files={project.files}
            gitStatus={gitFiles}
            // The tree marks the file in front only while its tab is open.
            // Closing the last file tab leaves it in front with nothing to
            // replace it, and a row that stays selected cannot be clicked
            // open again: the tree opens files on a selection change.
            activeFile={activeAsset || activePaper || (documents.tabsReady && !documents.tabs.includes(activeFile)) ? "" : activeFile}
            activeAssetPath={activeAsset?.path ?? ""}
            protectedPaths={protectedProjectPaths}
            assetDropTarget={tree.assetDropTarget}
            assetImporting={tree.assetImporting}
            {...fileTreeHandlers}
          />
        </Suspense>
        </PanelErrorBoundary>,
        trellis.hosts.project,
      )}
      {createPortal(
        <PanelErrorBoundary name="papers" resetKey={project.root}>
        <Suspense fallback={null}>
          <PaperLibrary
            projectKey={project.root}
            papers={papers}
            // Another project's read state says nothing about this one's.
            load={paperLoad.root === project.root ? paperLoad : PAPERS_LOADING}
            syncing={overleafSyncing && !papers.length}
            onRetryLoad={library.retryPapers}
            citations={citations}
            // Refreshed after every save, so the counts follow the manuscript.
            citationUsageRevision={unusedSymbols}
            activePaper={activePaper}
            paperFetchStates={paperActions.paperFetchStates}
            importInput={referenceImport.input}
            recentImport={referenceImport.recentImport?.projectRoot === project.root ? referenceImport.recentImport : null}
            importStage={referenceImport.stage ? paperImportStageLabel(referenceImport.stage) : null}
            importStageId={referenceImport.stage}
            importLabel={referenceImport.importLabel}
            justAdded={referenceImport.justAdded?.projectRoot === project.root ? referenceImport.justAdded.keys : undefined}
            importing={referenceImport.importing}
            {...paperLibraryHandlers}
          />
        </Suspense>
        </PanelErrorBoundary>,
        trellis.hosts.papers,
      )}
      {createPortal(trellisActions.project, trellis.hosts.projectActions)}
      {createPortal(trellisActions.papers, trellis.hosts.papersActions)}
      {createPortal(trellisActions.agent, trellis.hosts.agentActions)}
      {agentPresent && createPortal(
        <PanelErrorBoundary name="agent" resetKey={project.root}>
        <Suspense fallback={<div className="synara-frame-shell"><SynaraLoadingSurface thread waiting={synara.frameMounted} runtime={synara.runtime} onRetry={synara.retryAgent} /></div>}>
          <TrellisAgentSurface
            synara={synara}
            projectRoot={project.root}
            theme={theme}
            appLocale={appLocale}
            dropActive={tree.drops.agentPanel}
          />
        </Suspense>
        </PanelErrorBoundary>,
        trellis.hosts.agent,
      )}
      {createPortal(
        <OpeningOverlay documents={documents.store} />,
        trellis.hosts.editor,
      )}
    </>
  );
}
