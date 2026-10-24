import {
  Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type SetStateAction,
} from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { useAppearance } from "./settings/use-appearance";
import { isBrowserHosted } from "./platform/browser-runtime";
import { configureInterfaceSounds } from "./telemetry/interface-sounds";
import { configureToastPosition } from "./telemetry/toast-position";
import { useProjectSearch } from "./app/use-project-search";
import { useReferenceImages } from "./app/use-reference-images";
import { useReferenceImport } from "./app/use-reference-import";
import { overleafThreadOf, useEditorComments } from "./app/use-editor-comments";
import { annotationRounds } from "./app/annotation-rounds";
import { useAgentCheckpoints } from "./app/use-agent-checkpoints";
import { useBuildPipeline } from "./app/use-build-pipeline";
import { useLivePreview } from "./live-preview/use-live-preview";
import { useTexSetup } from "./app/use-tex-setup";
import { useCanvasRequests } from "./app/use-canvas-requests";
import { useBuildErrorFix } from "./app/use-build-error-fix";
import { useOpenDocuments } from "./app/use-open-documents";
import { useProjectLifecycle } from "./app/use-project-lifecycle";
import { useProjectTree } from "./app/use-project-tree";
import { useLatexStructure } from "./app/use-latex-structure";
import { useSyncTexNavigation } from "./app/use-synctex-navigation";
import { useSynaraHost } from "./app/use-synara-host";
import { useAgentContext } from "./app/use-agent-context";
import { useProjectState, useProjectTreeWatch } from "./app/use-project-state";
import { useProjectLibrary } from "./app/use-project-library";
import { useProjectHistoryItems } from "./app/use-project-history-items";
import { addSpellingWordToProject } from "./app/project-spelling-action";
import { usePreviewPrewarm } from "./app/use-preview-prewarm";
import { useSettledSource } from "./app/use-settled-source";
import {
  useFullscreen,
  useTrafficLightAlignment,
  useWindowMinimumSize,
} from "./app/use-native-window";
import { useRefState, useStableHandlers } from "./app/effect-helpers";
import { useLatestRef } from "./hooks/use-latest-ref";
import { useGuidedTour } from "./onboarding/use-guided-tour";
import { useOverleafWorkspace } from "./app/use-overleaf-workspace";
import { commandShortcutText } from "./app/use-app-commands";
import { useCommandTable } from "./app/use-command-table";
import { AppCommandOverlays } from "./app/app-command-overlays";
import { usePaperActions } from "./app/use-paper-actions";
import { useSourceNavigation } from "./app/use-source-navigation";
import { AppDocumentSurfaces } from "./app/app-document-surfaces";
import { AppPanelPortals } from "./app/app-panel-portals";
import { AppSettingsDialog } from "./app/app-settings-dialog";
import { useSettingsWindow } from "./app/use-settings-window";
import { useCommentAuthor } from "./app/use-comment-author";
import { AppOverleafDialogs } from "./app/app-overleaf-dialogs";
import { AppSubmissionDialogs } from "./app/app-submission-dialogs";
import { AppCanvasToolbar } from "./app/app-canvas-toolbar";
import { AppOverlays } from "./app/app-overlays";
import { useAgentSpreadsheetResolver } from "./app/use-agent-spreadsheet-resolver";
import { useSaveSlot } from "./app/use-save-slot";
import { useBuildPreferences } from "./app/use-build-preferences";
import { FocusModeBar } from "./app/focus-mode-bar";
import { useToolDrawers } from "./app/use-tool-drawers";
import { useTrellisBridge } from "./app/use-trellis-bridge";
import { useApplyOpenSlideMutation } from "./app/use-apply-open-slide-mutation";
import { AppOverleafCollabDrawer } from "./app/app-overleaf-drawer";
import { AppEditorPanels } from "./app/app-editor-panels";
import { AppHistoryDrawers } from "./app/app-history-drawers";
import { AppProjectDialogs, TexSetupDialogs } from "./app/app-project-dialogs";
import { AppProjectSearchDialogs, AppSearchDialogs, type SearchDialog } from "./app/app-search-dialogs";
import { AppTitlebar } from "./app/app-titlebar";
import { useInterfaceZoom } from "./app/use-interface-zoom";
import { useWhatsNew } from "./app/use-whats-new";
import { TrellisController, TrellisControllerContext, useTrellisUi } from "./trellis/trellis-controller";
import { TrellisTitlebar } from "./trellis/trellis-titlebar";
import type { OpenSlideContext } from "./editor/presentation/open-slide-bridge";
import { ChunkGate } from "./components/chunk-gate";
import { lazyChunk } from "./lib/lazy-chunk";
import { loadTrellisWorkspace } from "./app/workspace-chunks";
import type { AppSurfaces } from "./app/app-surfaces";
import { ReferencesPanel } from "./project/references-panel";
import { resolveAppLocale } from "./settings/app-settings";
import type { AgentProjectDocumentToolRequest } from "./agent/agent-project-document-tools";
import type { BuildAgentCommentsOptions } from "./agent/agent-editor-comments";
import {
  flattenProjectPaths,
  resolveDiagnosticPath,
  type CompileDiagnostic,
} from "./build/compile-diagnostics";
import { useTexlabDiagnostics } from "./build/use-texlab-diagnostics";
import { useCompileRepair } from "./build/use-compile-repair";
import { Welcome } from "./project/project-dialogs";
import type { NewEntryRequest, NewEntryType } from "./project/project-new-entries";
import { baseArxivId } from "./papers/arxiv-id";
import type {
  EditorPosition,
  InsertSymbolCommand,
  ViewRestoreRequest,
  CompileProject,
} from "./app-types";
import {
  isWholeFileEditorPath,
  toMessage,
} from "./app-utils";
// setError / setWarning / setNotice are the toast shims; they
// live beside the hooks extracted out of this file so both can use them.
import { showError, showingErrors } from "./app/notify";
import "./App.css";

const PaperDropBridge = lazy(() => import("./papers/paper-drop-bridge"));
// The workspace, the canvas and the project PDF beside it render behind a
// ChunkGate, so a project's first frame shows as soon as their chunks are in,
// with no Suspense reveal to wait out. The file tree and paper library
// (app-panel-portals.tsx) keep their boundaries: their reveal waits, after the
// editor's. The canvas, the project PDF and Settings come with App's surfaces
// (app/app-surfaces.ts).
// The workspace (and the Trellis library) load after the eager startup chunks.
const TrellisWorkspace = lazyChunk(loadTrellisWorkspace, (module) => module.default);
const GuidedTour = lazy(() => import("./onboarding/guided-tour"));

function App({ surfaces }: { surfaces: AppSurfaces }) {
  const {
    documentCanvas: { load: loadDocumentCanvas },
    settingsDialog: SettingsDialog,
  } = surfaces;
  const { t } = useLingui();
  // The Trellis workspace arranges every panel; App owns what is in them.
  const [trellis] = useState(() => new TrellisController());
  // Only the fields App reads: the rest of the workspace state (ready, other
  // panels' presence, hidden panels…) changes during the layout restore and
  // must not re-render App. One subscription, not one per field, because each
  // is two hooks on every App render; the snapshot is a string so an
  // unchanged answer does not re-render.
  const trellisFlags = useTrellisUi(trellis, (ui) => (
    [ui.present.agent, ui.visible.agent, ui.pdfLive, ui.editorHibernated, ui.dirty, ui.focus, ui.focusPdf].map((flag) => (flag ? "1" : "0")).join("")
  ));
  const [agentPresent, agentVisible, pdfLive, editorHibernated, workspaceDirty, focusMode, focusPdf] = [...trellisFlags].map((flag) => flag === "1");
  const browserHosted = isBrowserHosted();
  const projectState = useProjectState();
  const {
    project, setProject, projectRef,
    projectOperationGenerationRef,
    captureProjectScope,
  } = projectState;
  const library = useProjectLibrary(projectState);
  const {
    papers, citationKeys, citations, references,
    unusedSymbols, history, diskTodos, setDiskTodos, projectWordCount,
    loadHistory, loadTodos, loadWordCount, refreshUnusedSymbols, refreshHistory, refreshTodos, refreshWordCount,
    refreshAfterSave, refreshProject,
  } = library;
  const [buildPreferences, setBuildPreferences] = useBuildPreferences();
  /** Bumped whenever a save actually writes, so pushes follow real edits. */
  const [saveGeneration, setSaveGeneration] = useState(0);
  const savedPathsRef = useRef(new Set<string>());
  const recordSavedPaths = useCallback((paths: readonly string[]) => {
    if (!paths.length) return;
    for (const path of paths) savedPathsRef.current.add(path);
    setSaveGeneration((generation) => generation + 1);
  }, []);
  const compileRef = useRef<CompileProject>(async () => undefined);
  const externalOverleafEditsRef = useRef<(paths: readonly string[]) => void>(() => {});
  const canvasRequests = useCanvasRequests();
  const { update: updateCanvasRequest, settle: settleRequest } = canvasRequests;
  // Speculative preview work skips the open document, so it is set up after
  // the store; every open cancels it through this forwarder.
  const cancelPrewarmRef = useRef(() => {});
  const documents = useOpenDocuments({
    projectState, papers, updateCanvasRequest, refreshProject,
    cancelPrewarm: () => cancelPrewarmRef.current(),
    onSaved: (root, paths) => {
      recordSavedPaths(paths);
      // Called after this render, like afterSave below: the PDF is now older than these files.
      buildPipeline.markInputsChanged(paths);
      refreshAfterSave(root, paths.some((path) => path.endsWith(".tex")), paths.some((path) => /\.bib$/i.test(path)));
    },
    onDiskEdit: (path) => externalOverleafEditsRef.current([path]),
    autoBuild: {
      enabled: buildPreferences.autoBuildMode === "automatic",
      // Called after this render, by which point the build pipeline below exists.
      afterSave: () => void buildPipeline.runBuild(false, { automatic: true }),
      afterDiskEdit: () => void compileRef.current(),
    },
  });
  const {
    file: activeFile, text: source, savedText: savedSource, paper: activePaper, paperView, asset: activeAsset,
    mode: canvasMode,
  } = documents;
  const {
    openFile, openAsset, flush, save, load: loadFile, accept, reveal, clear: clearEditor,
  } = documents;
  const { file: activeFileRef, text: sourceRef, saved: savedSourceRef, asset: activeAssetRef } = documents.live;
  const [postStartupInteraction, setPostStartupInteraction] = useState(false);
  const [paperPdfOpen, setPaperPdfOpen] = useState(false);
  const {
    workspaceIndex,
    cancelPreviewPrewarm,
    prewarmLikelyProjectFile,
    prewarmLikelyPaper,
  } = usePreviewPrewarm(project, projectRef, { activeFile, activePaperId: activePaper?.arxivId, paperView }, loadDocumentCanvas);
  useLayoutEffect(() => { cancelPrewarmRef.current = cancelPreviewPrewarm; }, [cancelPreviewPrewarm]);
  const overleafSyncingRef = useRef(false);
  /** Resolves when the in-flight Overleaf sync has finished its disk refresh. */
  const overleafSyncSettledRef = useRef<Promise<void> | null>(null);
  const resolveOverleafSyncRef = useRef<(() => void) | null>(null);
  const agentCommentsOptionsRef = useRef<(() => BuildAgentCommentsOptions | null) | null>(null);
  const flushWholeFilesBeforeProjectTransitionRef = useRef<() => Promise<void>>(async () => {});
  const openOverleafSettingsRef = useRef<() => void>(() => {});
  useEffect(() => {
    const listening = new AbortController();
    const enableInteractivePreviews = () => {
      setPostStartupInteraction(true);
      listening.abort();
    };
    window.addEventListener("pointerdown", enableInteractivePreviews, { capture: true, signal: listening.signal });
    window.addEventListener("keydown", enableInteractivePreviews, { capture: true, signal: listening.signal });
    return () => listening.abort();
  }, []);
  // The ref is read by the presence hook, which must not re-subscribe on every keystroke.
  const [editorPosition, setEditorPosition, editorPositionRef] = useRefState<EditorPosition | null>(null);
  const addProjectSpellingWord = useCallback((word: string) => (
    addSpellingWordToProject(word, { projectRef, setProject })
  ), [projectRef, setProject]);
  const setViewRestore = useCallback((update: SetStateAction<ViewRestoreRequest | null>) => {
    updateCanvasRequest("restore", update);
  }, [updateCanvasRequest]);
  const [tableGeneratorOpen, setTableGeneratorOpen] = useState(false);
  const projectSearch = useProjectSearch({
    projectRef, captureProjectScope, save,
    unsavedEdits: () => sourceRef.current !== savedSourceRef.current,
    afterReplace: async () => {
      if (activeFileRef.current) await loadFile(activeFileRef.current);
      await refreshProject();
      await refreshHistory();
    },
  });
  const { openFind: openProjectFind } = projectSearch;
  const [searchDialog, setSearchDialog] = useState<SearchDialog | null>(null);
  const openCompileDiagnosticRef = useRef<(diagnostic: CompileDiagnostic) => Promise<void>>(async () => undefined);
  const openMarkdownProjectPathRef = useRef<(path: string) => void>(() => undefined);
  const requestEditorLine = useCallback((path: string, line: number) => {
    updateCanvasRequest("navigation", { path, line, id: crypto.randomUUID() });
  }, [updateCanvasRequest]);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const projectRootRef = useLatestRef(project?.root ?? null);
  const agentProjectDocumentCreatorRef = useRef<((
    request: AgentProjectDocumentToolRequest,
  ) => Promise<string>) | null>(null);
  useAgentSpreadsheetResolver(projectRootRef, recordSavedPaths);
  /** Insert `\cite{key}`/`\ref{key}` at the caret, bringing an editor on screen first. */
  const insertCitation = useCallback((key: string, command: InsertSymbolCommand) => {
    updateCanvasRequest("cite", { key, command, id: crypto.randomUUID() });
    reveal("editor");
  }, [reveal, updateCanvasRequest]);
  const [bibliographyAuditRoot, setBibliographyAuditRoot] = useState<string | null>(null);
  const [bibliographyAuditOpen, setBibliographyAuditOpen] = useState(false);
  const [arxivExportOpen, setArxivExportOpen] = useState(false);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [newEntryRequest, setNewEntryRequest] = useState<NewEntryRequest | null>(null);
  const requestNewEntry = useCallback((type: NewEntryType) => {
    setNewEntryRequest((previous) => ({ type, serial: (previous?.serial ?? 0) + 1 }));
  }, []);
  const [openSlideContext, setOpenSlideContext] = useState<OpenSlideContext | null>(null);
  const appearanceControls = useAppearance();
  const { theme, themePreference, setThemePreference, appearance, setAppearance, windowBacking } = appearanceControls;
  const interfaceZoom = useInterfaceZoom(setAppearance);
  const whatsNew = useWhatsNew();
  const synara = useSynaraHost({
    project,
    projectRef,
    agentVisible,
    appearance: {
      theme,
      tint: appearance.tint,
      accent: appearance.accent,
      translucency: appearance.translucency,
      translucent: windowBacking === "translucent",
    },
    bridge: {
      openProviderSettings: () => settingsWindow.openProviderSettings(),
      openProjectPath: (path) => openMarkdownProjectPathRef.current(path),
      openReview: (turn) => {
        tools.open("git", turn ? { turnReview: { ...turn, filePath: null } } : { gitView: "changes" });
      },
      clearSelection: () => agentContext.dismissSelection(),
      flushVisualMarkdown: () => {
        flush();
      },
      agentCommentsOptions: () => agentCommentsOptionsRef.current?.() ?? null,
      annotationTools: () => projectRootRef.current ? annotationRounds.toolHost : null,
      projectDocumentCreator: () => agentProjectDocumentCreatorRef.current,
      onHistorySnapshot: (snapshot) => agentCheckpoints.handleSnapshot(snapshot),
      onMinimumWidth: (width) => trellis.ui.set({ agentMinWidth: width }),
    },
  });
  const { postMessage: postSynaraMessage, requestRuntime: requestSynaraRuntime } = synara;
  const settingsWindow = useSettingsWindow(requestSynaraRuntime);
  const commentAuthor = useCommentAuthor(project?.root, settingsWindow.open);
  const { id: editorCommentAuthorId, name: authorName } = commentAuthor;
  const autoBuildModeRef = useLatestRef(buildPreferences.autoBuildMode);
  const agentCheckpoints = useAgentCheckpoints({
    project,
    projectRef,
    autoBuildModeRef,
    compileRef,
    onExternalEdits: externalOverleafEditsRef,
    postMessage: synara.postMessage,
  });
  const texSetup = useTexSetup(() => void compileRef.current(true, true));
  const livePreview = useLivePreview({ project, activeFile, source, savedSource });
  const buildPipeline = useBuildPipeline({
    project,
    projectRef,
    setProject,
    projectGenerationRef: projectOperationGenerationRef,
    activeFileRef,
    sourceRef,
    savedSourceRef,
    agent: agentCheckpoints,
    openDiagnosticRef: openCompileDiagnosticRef,
    onMissingTex: texSetup.openForMissingTex,
    livePreview: livePreview.buildHooks,
    autoBuildModeRef,
  });
  // The live preview compares the base PDF's page count with its own layout's.
  const { buildHooks: livePreviewHooks, state: livePreviewState } = livePreview;
  useEffect(() => {
    livePreviewHooks.current?.basePageCount(pdfPageCount);
  }, [livePreviewHooks, livePreviewState, pdfPageCount]);
  const { build, setBuild, building, outcome: buildOutcome, pdfUrl, runBuild } = buildPipeline;
  const { reset: resetAgentCheckpoints } = agentCheckpoints;
  const { resetQueue: resetBuildQueue, setDiagnosticsExpanded } = buildPipeline;
  // App's actions whose identity is a contract rather than a cache: effects
  // clean up through them (the reset below cancels the queued build when it
  // reruns), the canvas's request effects depend on settleCanvasRequest, and
  // builds and Settings are reached from hooks, refs, the palette and memoized
  // panels. Each forwarder keeps its identity for App's lifetime and calls the
  // body App last committed, so a body may read state declared further down;
  // the React Compiler caches everything else App renders. Declared ahead of
  // the effects and hooks that call them: the latest bodies land in a layout
  // effect, which must run before theirs.
  const {
    resetAgentCompileTracking, compile, compileAndShowPdf, openCompileDiagnostic,
    showSettingsTab, openSettings, closeSettings, settleCanvasRequest,
  } = useStableHandlers({
    resetAgentCompileTracking: (cancelQueuedBuild = false) => {
      resetAgentCheckpoints();
      resetBuildQueue(cancelQueuedBuild);
    },
    compile: async (
      force = false,
      sound = false,
      options?: { consumeAgentAssociations?: boolean },
    ) => {
      if (!project) return;
      await runBuild(force, {
        immediatePreview: true,
        requested: true,
        sound,
        consumeAgentAssociations: options?.consumeAgentAssociations,
      });
    },
    /**
     * An explicit build (button, palette) also brings a closed or hidden PDF
     * panel back under Trellis; in focus mode the PDF stays as the writer set it.
     */
    compileAndShowPdf: (
      force?: boolean,
      sound?: boolean,
      options?: { consumeAgentAssociations?: boolean },
    ) => {
      if (!trellis.ui.get().focus) trellis.showPanel("pdf", { focus: false });
      return compile(force, sound, options);
    },
    openCompileDiagnostic: async (diagnostic: CompileDiagnostic) => {
      if (!project) return;
      const path = resolveDiagnosticPath(
        diagnostic.file,
        flattenProjectPaths(project.files),
        activeFile,
      );
      if (!path) {
        showError(diagnostic.message);
        return;
      }
      await showingErrors(async () => {
        await openFile(path, { line: diagnostic.line ?? undefined });
        setDiagnosticsExpanded(true);
      });
    },
    showSettingsTab: settingsWindow.showTab,
    openSettings: settingsWindow.openSettings,
    closeSettings: settingsWindow.close,
    settleCanvasRequest: (id: string) => {
      settleRequest(id);
      settleBuildErrorFix(id);
    },
  });
  useEffect(() => {
    resetAgentCompileTracking();
    return () => resetAgentCompileTracking();
  }, [project?.root, resetAgentCompileTracking]);
  useEffect(() => () => resetAgentCompileTracking(true), [resetAgentCompileTracking]);
  const syncTex = useSyncTexNavigation({
    documents, captureProjectScope, editorPosition, editorPositionRef, build: buildPipeline, trellis,
  });
  const { revealSourceInPdf } = syncTex;
  const agentContext = useAgentContext({
    synara, project, papers, agentVisible,
    workspace: {
      activeFile, activePaper, activePaperPath: documents.paperPath, canvasMode, paperView, editorPosition,
      pdfPage: pdfPageNumber, pdfPageCount, presentation: openSlideContext,
    },
  });
  const { resetSelection: resetAgentSelection } = agentContext;
  const projectGit = useProjectTreeWatch(projectState, true);
  const { setGitStatus } = projectGit;
  const appLocale = resolveAppLocale(appearance.interfaceLanguage);
  // How notifications sound and where they stand. One effect for both: each
  // hook App runs at startup is on the startup render budget.
  useEffect(() => {
    configureInterfaceSounds(appearance.interfaceSounds);
    configureToastPosition(appearance.toastPosition);
  }, [appearance.interfaceSounds, appearance.toastPosition]);
  useWindowMinimumSize(appearance.interfaceScale, trellis.layoutMinWidth);
  const isFullscreen = useFullscreen();
  const shellRef = useRef<HTMLDivElement | null>(null);

  const projectHistory = useProjectHistoryItems(history, agentCheckpoints.historyItems);

  useLayoutEffect(() => { compileRef.current = compile; }, [compile]);

  // ---- Overleaf bridge -----------------------------------------------------
  // Link discovery, syncing, the realtime channel and everything that rides it
  // (presence, chat, comment threads, tracked changes) live in
  // `src/app/use-overleaf-workspace.ts`. It has to be called here rather than
  // beside the rest of App's state: every sync path goes through save, compile,
  // loadFile and refreshProject, all of which are declared above.
  const wholeFileEditingPaths = useMemo(() => (
    !activePaper && !activeAsset && canvasMode !== "pdf" && isWholeFileEditorPath(activeFile) ? [activeFile] : []
  ), [activeAsset, activeFile, activePaper, canvasMode]);
  const wholeFileDraftPaths = useMemo(() => (
    openSlideContext?.pendingEdits
    && wholeFileEditingPaths.includes(openSlideContext.pagePath)
      ? [openSlideContext.pagePath]
      : []
  ), [openSlideContext, wholeFileEditingPaths]);
  const overleaf = useOverleafWorkspace({
    project, projectRef, projectOperationGenerationRef, activeFile, activeFileRef, activePaper, activeAsset,
    source, sourceRef, savedSourceRef, accept, editorPosition,
    editorPositionRef, build, saveGeneration, savedPathsRef, wholeFileEditingPaths, wholeFileDraftPaths,
    save, compile, loadFile, refreshProject, openProjectFile: openFile,
    overleafSyncingRef, overleafSyncSettledRef, resolveOverleafSyncRef, openOverleafSettingsRef,
  });
  const {
    overleafLink, overleafSyncing, overleafSyncMode, setOverleafPickerOpen, setOverleafReviewOpen, setOverleafCollabOpen,
    overleafSyncRef, runOverleafSync, flushDeferredWholeFileSync, settleRemoteDeletes, overleafRealtime,
  } = overleaf;
  useLayoutEffect(() => {
    flushWholeFilesBeforeProjectTransitionRef.current = flushDeferredWholeFileSync;
  }, [flushDeferredWholeFileSync]);
  useLayoutEffect(() => {
    externalOverleafEditsRef.current = overleafRealtime.suspendPaths;
  }, [overleafRealtime.suspendPaths]);

  const applyOpenSlideMutation = useApplyOpenSlideMutation({
    projectRef, activeFileRef, accept, recordSavedPaths, refreshProject, refreshHistory, loadFile, clearEditor,
  });

  const openSources = useCallback(() => new Map([
    [activeFileRef.current, sourceRef.current],
  ]), [activeFileRef, sourceRef]);
  const editorComments = useEditorComments({
    project, projectRootRef, activeFileRef, openProjectFile: openFile, overleaf,
    author: { id: editorCommentAuthorId, name: authorName },
    openSources,
    agentOptionsRef: agentCommentsOptionsRef,
  });
  const { reset: resetEditorComments, load: loadEditorComments } = editorComments;
  const unresolvedComments = editorComments.all.filter((comment) => !comment.resolved).length;
  const unresolvedCommentsRef = useLatestRef(unresolvedComments);

  useEffect(() => {
    openCompileDiagnosticRef.current = openCompileDiagnostic;
  }, [openCompileDiagnostic]);
  const buildErrorFix = useBuildErrorFix({
    captureProjectScope, openFile, fileRef: activeFileRef, assetRef: activeAssetRef, updateCanvasRequest,
    flush, save, compile: () => compileRef.current(),
  });
  const { settled: settleBuildErrorFix, reset: resetBuildErrorFix } = buildErrorFix;

  const repairWritable = !overleafLink || overleafRealtime.canWrite;
  const compileRepair = useCompileRepair({
    projectRoot: project?.root,
    rootDocument: build?.rootDocument,
    runtimeMode: synara.permissionMode,
    enabled: repairWritable && !building,
    save: async () => {
      if (!flush()) return false;
      return save();
    },
    onComplete: async () => {
      const root = projectRef.current?.root;
      const generation = projectOperationGenerationRef.current;
      if (!root) return;
      const owns = () => projectRef.current?.root === root && projectOperationGenerationRef.current === generation;
      await refreshProject({ expectedRoot: root, generation });
      if (!owns()) return;
      const path = activeFileRef.current;
      const clean = () => activeFileRef.current === path && sourceRef.current === savedSourceRef.current;
      if (!activePaper && !activeAssetRef.current && path && clean()) {
        const content = await invoke<string>("read_project_file", { path, projectRoot: root });
        if (!owns()) return;
        accept(path, content, "clean");
      }
      if (owns()) await compileRef.current();
    },
  });

  const { tour: guidedTour, start: startGuidedTour, end: endGuidedTour, finish: finishGuidedTour } = useGuidedTour();
  const lifecycle = useProjectLifecycle({
    projectState, documents, library, build: buildPipeline, cancelPrewarm: cancelPreviewPrewarm, loadCanvas: loadDocumentCanvas,
    resetCompileTracking: resetAgentCompileTracking,
    overleafSync: {
      syncingRef: overleafSyncingRef, settledRef: overleafSyncSettledRef,
      flushWholeFilesRef: flushWholeFilesBeforeProjectTransitionRef,
    },
    resetProjectUi: () => {
      endGuidedTour();
      resetAgentSelection();
      resetEditorComments();
      annotationRounds.reset();
      resetBuildErrorFix();
      projectSearch.closeReplace();
      tools.resetForProject();
      setDiskTodos([]);
    },
    scanProject: async () => {
      // Independent scans, each as slow as the project is large (a word count
      // runs texcount): side by side, so a restored Paper waits for the
      // slowest, not their sum.
      await Promise.all([refreshUnusedSymbols(), loadHistory(), loadEditorComments(), loadTodos(), loadWordCount()]);
      setPdfPageCount(null);
      tools.close("checklist");
    },
    startTour: startGuidedTour,
    shellRef, browserHosted,
  });
  const {
    launching, busyLabel, recentProjects, unopenedProject, projectMenuOpen, setProjectMenuOpen, createForm, updateCreateForm,
    chooseExisting, createProject, chooseRecentProject,
    openTutorialProject, importOverleafZip, exportProjectZip, moveWorkspace, movingWorkspace,
  } = lifecycle;

  useTrafficLightAlignment(shellRef, !browserHosted && !isFullscreen, appearance.interfaceScale, project?.manifest.name);

  const referenceImport = useReferenceImport({
    project, projectRootRef, refreshProject, refreshHistory, onExternalEdits: externalOverleafEditsRef,
    editor: {
      activeFile,
      source,
      dirty: source !== savedSource,
      save,
      accept,
    },
    onCite: (key) => insertCitation(key, "cite"),
    onMissingPaperTools: (failure) => void texSetup.openForMissingPaperTools(failure),
  });
  const tools = useToolDrawers({
    trellis, synara, comments: editorComments, references: referenceImport,
    commentsKind: overleafLink ? "overleaf" : "comments",
    commentsOpen: editorComments.panelOpen || overleaf.overleafCollabOpen,
    refreshTodos, refreshWordCount,
  });
  useLayoutEffect(() => {
    annotationRounds.attach({
      store: editorComments, projectRootRef, activeFileRef, sourceRef, openProjectFile: openFile,
      author: { id: editorCommentAuthorId, name: authorName }, overleafLinked: overleafLink !== null,
      openPanel: () => tools.open("comments"),
      openHistoryEntry: (historyEntry) => tools.open("history", { historyEntry }),
      save,
      reloadAfterRestore: async () => {
        await refreshProject();
        if (activeFileRef.current) await loadFile(activeFileRef.current);
        await refreshHistory();
      },
    });
  });
  const paperActions = usePaperActions({
    projectState, documents, refreshProject, refreshHistory,
    clearImportStage: referenceImport.clearStage, openForMissingPaperTools: texSetup.openForMissingPaperTools,
  });
  const { readDraggedPaper } = paperActions;

  const referenceImages = useReferenceImages(project?.root, references);

  // The document in the editor, and the same text as of the last pause in
  // typing for the work that reads all of it (useSettledSource): counts,
  // TODOs, outline, labels, macros. A long buffer pays for that once per pause
  // rather than once per keystroke; a short one reads live.
  const { key: editorKey, text: canvasSource } = documents.canvas;
  const settledCanvasSource = useSettledSource(`${project?.root ?? ""}\n${editorKey}`, canvasSource);
  const latex = useLatexStructure({
    project, activeFile, references, diskTodos, editorPosition,
    // With a Paper in front, the primary buffer is not being edited.
    settledSource: activePaper ? source : settledCanvasSource,
    // Go to symbol and the source editor's outline rail list the same
    // outline, so they read the included files too.
    outlineWanted: outlineOpen || searchDialog === "goto-symbol" || activeFile.endsWith(".tex"),
    pdfShown: pdfUrl != null,
    compiledPdf: build?.success ? pdfUrl : null,
  });
  const {
    rootDocumentPath, outlineNodes, liveReferences, todoHits, bodyBoundary, forgetIncludedSources,
  } = latex;
  const tree = useProjectTree({
    projectState, documents, library: { refreshProject, refreshHistory }, setGitStatus,
    overleaf: { link: overleafLink, syncMode: overleafSyncMode, syncRef: overleafSyncRef, settleRemoteDeletes },
    remapDerivedPaths: (remapPath) => {
      latex.remapIncludedSources(remapPath);
      // TexLab resynchronizes the renamed active file rather than retaining
      // diagnostics for its old URI. Build diagnostics still need remapping.
      setBuild((current) => current ? {
        ...current,
        diagnostics: current.diagnostics.map((diagnostic) => diagnostic.file
          ? { ...diagnostic, file: remapPath(diagnostic.file) }
          : diagnostic),
      } : current);
    },
    updateCanvasRequest, postAgentMessage: postSynaraMessage, agentDocumentCreatorRef: agentProjectDocumentCreatorRef,
    trellis, interfaceScale: appearance.interfaceScale,
  });

  const sourceNavigation = useSourceNavigation({
    project, projectRef, papers, documents, library, forgetIncludedSources, updateCanvasRequest, tree,
    openProjectPathRef: openMarkdownProjectPathRef,
  });
  const {
    openMarkdownProjectPath, beginSymbolRename, openSymbolOccurrence, referenceHits, dismissReferenceHits, rename,
  } = sourceNavigation;

  const handleEditorPosition = useCallback((position: EditorPosition) => {
    editorPositionRef.current = position;
    setEditorPosition((current) => (
      current?.path === position.path && current.line === position.line && current.column === position.column ? current : position
    ));
  }, [editorPositionRef, setEditorPosition]);



  useLayoutEffect(() => { openOverleafSettingsRef.current = () => openSettings("overleaf"); }, [openSettings]);


  const settingsDialog = (
    <AppSettingsDialog
      state={settingsWindow} Dialog={SettingsDialog} showTab={showSettingsTab} close={closeSettings}
      project={project} setProject={setProject} synara={synara} overleaf={overleaf} texSetup={texSetup}
      buildPipeline={buildPipeline} author={commentAuthor} appearance={appearanceControls}
      buildPreferences={buildPreferences} setBuildPreferences={setBuildPreferences} livePreview={livePreview}
    />
  );

  const overleafDialogs = (
    <AppOverleafDialogs
      overleaf={overleaf} lifecycle={lifecycle} project={project} activeFile={activeFile} loadFile={loadFile}
      refreshProject={refreshProject} compile={compile} externalEditsRef={externalOverleafEditsRef}
    />
  );

  // Versionless arXiv ids whose full text is already in the library — the
  // Discover panel shows these hits as done instead of importable.
  const importedArxivIds = useMemo(
    () => new Set(papers.filter((paper) => paper.hasFullText && paper.arxivId).map((paper) => baseArxivId(paper.arxivId))),
    [papers],
  );

  const texlabDiagnostics = useTexlabDiagnostics(project?.root, activeFile, source, build);

  // A line jump lands in the text on screen: a Paper's reading file in front
  // of the retained source, never that source underneath it. An asset preview
  // and a Paper's original PDF have no lines to go to.
  const lineTarget = activeAsset || paperPdfOpen ? null : documents.canvas.path || null;
  const checkReferences = () => {
    const root = project?.root;
    if (!root) return;
    setBibliographyAuditRoot(root);
    setBibliographyAuditOpen(true);
  };
  // Manual mode is a review step, not a button that quietly rewrites files:
  // show what would change and let the user decide.
  const syncOverleaf = () => {
    if (overleafSyncMode === "manual") setOverleafReviewOpen(true);
    else void runOverleafSync();
  };
  const saveSlot = useSaveSlot(documents, overleaf, syncOverleaf);
  const commandTable = useCommandTable({
    project, papers, documents, trellis, layout: { focusMode, focusPdf, workspaceDirty }, buildPipeline, compileAndShowPdf,
    syncTex, agentContext, tools, tree, referenceImport, projectSearch, editorComments, lifecycle, overleaf, syncOverleaf,
    todoCount: todoHits.length, updateCanvasRequest, setSearchDialog, setTableGeneratorOpen, setArxivExportOpen,
    checkReferences, requestNewEntry, settingsOpen: settingsWindow.open, openSettings, whatsNew, browserHosted,
    theme: { preference: themePreference, setPreference: setThemePreference }, interfaceZoom,
    knownAuthorName: commentAuthor.knownName,
    prewarmLikelyProjectFile, readDraggedPaper,
  });
  const { commands, openPaletteFromTitlebar, paletteShortcut } = commandTable;
  const commandOverlays = <AppCommandOverlays commands={commands} overlay={commandTable.overlay} />;

  // Trellis workspace: App stays the owner of every document; the
  // workspace reads App through this bridge (at event time) and the store below.
  useTrellisBridge({
    trellis, project, projectRef, papers, documents, lastBuild: buildOutcome, building, buildPipeline,
    synara, tools, referenceImport, referenceImages, projectSearch, compile, compileAndShowPdf, revealSourceInPdf,
    openSettings, setSearchDialog, setProjectSearchOpen, setBibliographyAuditRoot, setBibliographyAuditOpen,
    requestNewEntry, reportPdfSelection: (text, place) => agentContext.reportSelection("pdf", text, place),
    shortcut: (id) => commandShortcutText(commands, id),
  });

  // Shown over the welcome screen and a project alike.
  const appOverlays = <AppOverlays interfaceScale={appearance.interfaceScale} interfaceZoom={interfaceZoom} whatsNew={whatsNew} />;
  if (!project) {
    return (
      <>
        {/* While launch reopens a project, the window's own background, not a flash of the welcome screen. */}
        {!launching && <Welcome
          busyLabel={busyLabel}
          createOpen={createForm.open}
          createError={createForm.error}
          projectName={createForm.name}
          projectVenue={createForm.venue}
          onOpenCreate={() => updateCreateForm({ open: true })}
          onCloseCreate={() => updateCreateForm({ open: false })}
          setProjectName={(name) => updateCreateForm({ name })}
          setProjectVenue={(venue) => updateCreateForm({ venue })}
          onCreate={createProject}
          onOpen={chooseExisting}
          onImportZip={() => void importOverleafZip()}
          onOpenTutorial={() => void openTutorialProject()}
          recentProjects={recentProjects}
          unopenedProject={unopenedProject}
          onRecent={(path) => void chooseRecentProject(path)}
          onSettings={() => openSettings()}
          onInstallTex={() => void texSetup.openWizard()}
          onOpenOverleaf={() => setOverleafPickerOpen(true)}
        />}
        {commandOverlays}
        {settingsDialog}
        {overleafDialogs}
        <TexSetupDialogs setup={texSetup} />
        {appOverlays}
      </>
    );
  }

  const workspaceLoading = <div className="document-canvas-loading" aria-label={t`Preparing workspace`} />;

  return (
    <TrellisControllerContext.Provider value={trellis}>
    <div
      className={`app-shell trellis-layout ${isFullscreen ? "fullscreen" : ""} ${browserHosted ? "browser-hosted" : ""} ${focusMode ? "focus-mode" : ""}`}
      ref={shellRef}
    >
      <Suspense fallback={null}>
        <PaperDropBridge
          library={{ projectRoot: project.root, papers }}
          interfaceScale={appearance.interfaceScale}
          onOpen={readDraggedPaper}
          onError={(reason) => showError(toMessage(reason))}
        />
      </Suspense>
      <AppTitlebar
        project={project}
        projectMenu={{
          open: projectMenuOpen,
          setOpen: setProjectMenuOpen,
          importing: referenceImport.importing,
          building,
          recentProjects,
          busyLabel,
          onRecent: chooseRecentProject,
          onOpen: () => void chooseExisting(),
          onNew: () => updateCreateForm({ open: true }),
          onOpenOverleaf: () => setOverleafPickerOpen(true),
          onOpenTutorial: () => void openTutorialProject(),
          onExportZip: () => void exportProjectZip(),
          onExportArxiv: () => setArxivExportOpen(true),
          onSettings: (returnFocus) => openSettings(undefined, returnFocus),
        }}
        panelControls={<TrellisTitlebar controller={trellis} onSearch={openPaletteFromTitlebar} searchShortcut={paletteShortcut} />}
        focusBar={focusMode ? (
          <FocusModeBar
            controller={trellis}
            title={activePaper ? activePaper.title : documents.activeTab.split("/").pop() ?? ""}
            pdf={focusPdf}
            onPdfChange={(pdf) => trellis.setFocusPdf(pdf)}
            onExit={() => trellis.setFocus(false)}
          />
        ) : undefined}
        canvasToolbar={(
          <AppCanvasToolbar
            documents={documents}
            tools={tools}
            commentCount={unresolvedComments}
            comments={editorComments}
            inBrowserTab={browserHosted}
            onMoveWorkspace={() => void moveWorkspace()}
            hiddenTools={appearance.hiddenTitlebarTools}
            overleaf={overleaf}
            onOverleafSync={syncOverleaf}
          />
        )}
      />

      {referenceHits && (
        <ReferencesPanel
          kind={referenceHits.kind}
          symbol={referenceHits.symbol}
          occurrences={referenceHits.occurrences}
          onSelect={(occurrence) => void openSymbolOccurrence(occurrence)}
          onRename={() => beginSymbolRename(
            referenceHits.kind === "label"
              ? { kind: "label", label: referenceHits.symbol }
              : { kind: "citation", key: referenceHits.symbol },
          )}
          onDismiss={dismissReferenceHits}
        />
      )}

      <main className="workspace trellis-workspace">
        <ChunkGate chunk={loadTrellisWorkspace} fallback={workspaceLoading}>
          <Suspense fallback={workspaceLoading}>
            <TrellisWorkspace key={project.root} controller={trellis} projectRoot={project.root} dark={theme === "dark"} focusMode={focusMode} />
          </Suspense>
        </ChunkGate>
        <AppPanelPortals
          project={project}
          documents={documents}
          trellis={trellis}
          agentPresent={agentPresent}
          theme={theme}
          appLocale={appLocale}
          tree={tree}
          prewarm={{ prewarmLikelyProjectFile, prewarmLikelyPaper }}
          projectSearch={{ open: projectSearchOpen, setOpen: setProjectSearchOpen, openFind: openProjectFind }}
          newEntry={{ request: newEntryRequest, requestNew: requestNewEntry }}
          gitFiles={projectGit.gitFiles}
          rootDocumentPath={rootDocumentPath}
          library={library}
          overleafSyncing={overleafSyncing}
          paperActions={paperActions}
          referenceImport={referenceImport}
          openSymbolOccurrence={openSymbolOccurrence}
          synara={synara}
          tools={tools}
          checkReferences={checkReferences}
        />
        <AppDocumentSurfaces
          surfaces={surfaces}
          project={project}
          projectState={projectState}
          documents={documents}
          settledSource={settledCanvasSource}
          workspaceIndex={workspaceIndex}
          preferences={{
            locale: appLocale,
            theme,
            editorKeymap: appearance.editorKeymap,
            editorSpellcheck: appearance.editorSpellcheck,
            onAddSpellingWord: addProjectSpellingWord,
            interactivePreviewsEnabled: postStartupInteraction,
          }}
          library={library}
          latex={latex}
          texlabDiagnostics={texlabDiagnostics}
          referenceImport={referenceImport}
          referenceImages={referenceImages}
          canvasRequests={{ requests: canvasRequests.requests, settle: settleCanvasRequest }}
          onEditorPosition={handleEditorPosition}
          sourceNavigation={sourceNavigation}
          setSearchDialog={setSearchDialog}
          outline={{ open: outlineOpen, setOpen: setOutlineOpen }}
          tableGenerator={{ open: tableGeneratorOpen, setOpen: setTableGeneratorOpen }}
          tree={tree}
          overleaf={overleaf}
          layout={{ focusMode, editorHibernated, pdfLive }}
          comments={{ store: editorComments, author: { id: editorCommentAuthorId, name: authorName } }}
          tools={tools}
          agentContext={agentContext}
          openSlide={{ applyMutation: applyOpenSlideMutation, setContext: setOpenSlideContext }}
          trellis={trellis}
          synara={synara}
          build={{
            pipeline: buildPipeline, compileAndShowPdf, openCompileDiagnostic, repair: compileRepair, repairWritable,
            errorFix: buildErrorFix, shortcut: commandShortcutText(commands, "build") ?? undefined,
          }}
          texSetup={texSetup}
          saveSlot={saveSlot}
          movingWorkspace={movingWorkspace}
          livePreview={livePreview}
          pdfPage={{ setCount: setPdfPageCount, setNumber: setPdfPageNumber }}
          syncTex={syncTex}
          setPaperPdfOpen={setPaperPdfOpen}
        />
        {guidedTour && (
          <Suspense fallback={null}>
            <GuidedTour
              key={guidedTour.run}
              replay={guidedTour.replay}
              controller={trellis}
              openFile={(path) => void openFile(path)}
              commentCount={() => unresolvedCommentsRef.current}
              onClose={finishGuidedTour}
            />
          </Suspense>
        )}
      </main>


      <TexSetupDialogs setup={texSetup} />


      <AppHistoryDrawers
        tools={tools}
        synara={synara}
        project={project}
        activeFile={activeFile}
        appLocale={appLocale}
        theme={theme}
        compile={compile}
        gitRemoteUrl={projectGit.gitRemoteUrl}
        loadFile={loadFile}
        openProjectFile={openFile}
        overleafLink={overleafLink}
        projectHistory={projectHistory}
        refreshHistory={refreshHistory}
        refreshProject={refreshProject}
        runOverleafSync={runOverleafSync}
      />

      <AppEditorPanels
        openFigureFile={documents.open}
        beforeFigureWrite={save}
        afterFigureWrite={async () => {
          if (activeFileRef.current) await loadFile(activeFileRef.current);
          await refreshProject();
          await refreshHistory();
        }}
        comments={editorComments}
        annotationRounds={annotationRounds}
        renderCommentsSurface={overleafLink ? (localComments) => (
          <AppOverleafCollabDrawer
            key={`${project.root}:${editorComments.panelFocusId ? editorComments.panelFocus?.nonce : "comments"}`}
            localComments={localComments}
            localCommentCount={editorComments.comments.filter((comment) => !comment.resolved).length}
            hasLocalComments={editorComments.comments.length > 0}
            focusLocalComments={!!editorComments.panelFocusId && !overleafThreadOf(editorComments.panelFocusId)}
            focusThreadId={editorComments.panelFocusId ? overleafThreadOf(editorComments.panelFocusId) : null}
            activeFileRef={activeFileRef}
            openProjectFile={openFile}
            overleaf={overleaf}
            onClose={() => {
              setOverleafCollabOpen(false);
              editorComments.setPanelFocus(null);
            }}
            setViewRestore={setViewRestore}
            source={source}
          />
        ) : undefined}
        key={project.root}
        activeFile={activeFile}
        activeSource={settledCanvasSource}
        openTabs={documents.tabs}
        build={build}
        editorCommentAuthorId={editorCommentAuthorId}
        bodyBoundary={bodyBoundary}
        openProjectFile={openFile}
        pdfPageCount={pdfPageCount}
        captureProjectScope={captureProjectScope}
        project={project}
        projectWordCount={projectWordCount}
        setProject={setProject}
        tools={tools}
        todoHits={todoHits}
        unusedSymbols={unusedSymbols}
      />

      {appOverlays}
      <AppSearchDialogs
        open={searchDialog}
        setOpen={setSearchDialog}
        activeFile={activeFile}
        files={project.files}
        citations={citations}
        citationKeys={citationKeys}
        editorPosition={editorPosition}
        liveReferences={liveReferences}
        outlineNodes={outlineNodes}
        source={source}
        openProjectAsset={openAsset}
        openProjectFile={openFile}
        prewarmLikelyProjectFile={prewarmLikelyProjectFile}
        recentPaths={documents.recentPaths}
        insertReference={insertCitation}
        lineTarget={lineTarget}
        goToLine={(line) => {
          if (lineTarget) requestEditorLine(lineTarget, line);
        }}
      />

      <AppSubmissionDialogs
        project={project}
        audit={{ root: bibliographyAuditRoot, open: bibliographyAuditOpen, setOpen: setBibliographyAuditOpen }}
        arxivExport={{ open: arxivExportOpen, setOpen: setArxivExportOpen }}
        documents={documents}
        refreshAfterSave={refreshAfterSave}
        openForMissingPaperTools={texSetup.openForMissingPaperTools}
        projectRootRef={projectRootRef}
        externalEditsRef={externalOverleafEditsRef}
        compile={compile}
      />
      <AppProjectSearchDialogs
        search={projectSearch}
        openMarkdownProjectPath={openMarkdownProjectPath}
        openProjectFile={openFile}
      />

      <AppProjectDialogs
        references={referenceImport}
        papers={papers}
        importedArxivIds={importedArxivIds}
        createForm={createForm}
        updateCreateForm={updateCreateForm}
        createProject={createProject}
        rename={rename}
        importConflict={tree.importConflict}
      />

      {commandOverlays}
      {settingsDialog}
      {overleafDialogs}
    </div>
    </TrellisControllerContext.Provider>
  );
}

export default App;
