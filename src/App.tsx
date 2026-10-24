import {
  Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { citationSourceUrl } from "./papers/paper-source";
import { paperImportStageLabel } from "./papers/paper-import-progress";
import {
  loadAuthorNameSetting, loadEditorCommentAuthorId, persistAuthorNameSetting, resolveAuthorName,
} from "./editor/comments/editor-comment-data";
import { useAppearance } from "./settings/use-appearance";
import { isBrowserHosted } from "./platform/browser-runtime";
import { configureInterfaceSounds } from "./telemetry/interface-sounds";
import { configureToastPosition } from "./telemetry/toast-position";
import { OpeningOverlay } from "./app/opening-overlay";
import { useProjectSearch } from "./app/use-project-search";
import { useReferenceImages } from "./app/use-reference-images";
import { useReferenceImport } from "./app/use-reference-import";
import { overleafThreadOf, useEditorComments } from "./app/use-editor-comments";
import { annotationRounds } from "./app/annotation-rounds";
import { useAgentCheckpoints } from "./app/use-agent-checkpoints";
import { useBuildPipeline } from "./app/use-build-pipeline";
import { useLivePreview } from "./live-preview/use-live-preview";
import { openSlideComposerPrompt } from "./agent/agent-composer-prompt";
import { SynaraLoadingSurface } from "./agent/synara-loading-surface";
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
import { usePaperActions } from "./app/use-paper-actions";
import { useSourceNavigation } from "./app/use-source-navigation";
import { FocusModeBar } from "./app/focus-mode-bar";
import type { SettingsSearchEntry } from "./settings/settings-search-index";
import { useToolDrawers } from "./app/use-tool-drawers";
import { useTrellisBridge } from "./app/use-trellis-bridge";
import { useApplyOpenSlideMutation } from "./app/use-apply-open-slide-mutation";
import { AppOverleafCollabDrawer, AppOverleafMarginReview } from "./app/app-overleaf-drawer";
import { AppEditorPanels } from "./app/app-editor-panels";
import { AppHistoryDrawers } from "./app/app-history-drawers";
import { SettingsLoadingShell } from "./app/tool-loading-shell";
import { useLoadingShell } from "./app/use-loading-shell";
import { AppProjectDialogs, TexSetupDialogs } from "./app/app-project-dialogs";
import { AppProjectSearchDialogs, AppSearchDialogs, type SearchDialog } from "./app/app-search-dialogs";
import { AppTitlebar } from "./app/app-titlebar";
import { saveSourceCopy } from "./app/save-source-copy";
import { InterfaceZoomHud as InterfaceZoomPill } from "./app/interface-zoom-hud";
import { useInterfaceZoom } from "./app/use-interface-zoom";
import { useWhatsNew } from "./app/use-whats-new";
import { overleafSaveState, type SaveSlot } from "./canvas/save-slot";
import { PanelActions } from "./trellis/trellis-panel-actions";
import { TrellisController, TrellisControllerContext, useTrellisUi } from "./trellis/trellis-controller";
import { TrellisTitlebar } from "./trellis/trellis-titlebar";
import { CanvasToolbar } from "./canvas/canvas-toolbar";
import type { OpenSlideContext } from "./editor/presentation/open-slide-bridge";
import { LazyMount } from "./components/lazy-mount";
import { ChunkGate } from "./components/chunk-gate";
import { lazyChunk } from "./lib/lazy-chunk";
import { loadPaperLibrary, loadProjectFileTree, loadTrellisWorkspace } from "./app/workspace-chunks";
import type { AppSurfaces } from "./app/app-surfaces";
import { OverleafPresenceAvatars } from "./overleaf/overleaf-presence";
import { ReferencesPanel, type SymbolOccurrence } from "./project/references-panel";
import { persistSynaraThread } from "./app/app-synara-embed";
import {
  type BuildPreferences,
  BUILD_PREFERENCES_KEY,
  loadBuildPreferences,
  persistOverleafRemoteDelete,
  persistOverleafSyncMode,
  resolveAppLocale,
  loadSettingsTab,
  persistSettingsTab,
  isSynaraSettingsTab,
} from "./settings/app-settings";
import type { AgentProjectDocumentToolRequest } from "./agent/agent-project-document-tools";
import type { BuildAgentCommentsOptions } from "./agent/agent-editor-comments";
import { loadAgentSpreadsheetModel, registerAgentSpreadsheetDocumentResolver } from "./agent/agent-spreadsheet-tools";
import {
  EMPTY_DIAGNOSTICS,
  diagnosticMatchesFile,
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
  ProjectManifest,
  EditorPosition,
  PaperSummary,
  SettingsTab,
  InsertSymbolCommand,
  ViewRestoreRequest,
  OverleafStatus,
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

const OverleafPickerDialog = lazy(() =>
  import("./overleaf/overleaf-connect").then((module) => ({ default: module.OverleafPickerDialog })),
);
const OverleafReviewDialog = lazy(() =>
  import("./overleaf/overleaf-review").then((module) => ({ default: module.OverleafReviewDialog })),
);
const ConflictResolverDialog = lazy(() =>
  import("./history/conflict-resolver").then((module) => ({ default: module.ConflictResolverDialog })),
);
const ArxivExportDialog = lazy(() => import("./project/arxiv-export-dialog"));
// Lazy: the file tree pulls @pierre/trees (~270 KB), and neither sidebar
// panel renders on the Welcome screen, so they must not weigh down first paint.
// Memoized: their callbacks come through stable forwarders (useStableHandlers
// in App), so an editor keystroke does not re-render the file tree or the paper library.
const ProjectFileTree = lazyChunk(loadProjectFileTree, (module) => memo(module.ProjectFileTree));
// Memoized: its props are stable, and App re-renders on every keystroke.
const InterfaceZoomHud = memo(InterfaceZoomPill);
/** Papers' read state while the window's paper list is still another project's. */
const PAPERS_LOADING = { status: "loading" } as const;
const PaperLibrary = lazyChunk(loadPaperLibrary, (module) => memo(module.PaperLibrary));
const PaperDropBridge = lazy(() => import("./papers/paper-drop-bridge"));
const BibliographyAudit = lazy(() =>
  import("./papers/bibliography-audit").then((module) => ({ default: module.BibliographyAudit })),
);
const CompileDiagnosticsPanel = lazy(() =>
  import("./build/compile-diagnostics-panel").then((module) => ({ default: module.CompileDiagnosticsPanel })),
);
// The workspace, the canvas and the project PDF beside it render behind a
// ChunkGate, so a project's first frame shows as soon as their chunks are in,
// with no Suspense reveal to wait out. The file tree and paper library above
// keep their boundaries: their reveal waits, after the editor's. The canvas,
// the project PDF and Settings come with App's surfaces (app/app-surfaces.ts).
// The workspace (and the Trellis library) load after the eager startup chunks.
const TrellisWorkspace = lazyChunk(loadTrellisWorkspace, (module) => module.default);
const TrellisAgentSurface = lazy(() => import("./trellis/trellis-agent-surface"));
const GuidedTour = lazy(() => import("./onboarding/guided-tour"));
const WhatsNewDialog = lazy(() => import("./app/whats-new-dialog").then((module) => ({ default: module.WhatsNewDialog })));

/** Shared empty word list: `?? []` in JSX rebuilds the editor's lint pass. */
const EMPTY_SPELLING_WORDS: string[] = [];

function App({ surfaces }: { surfaces: AppSurfaces }) {
  const {
    documentCanvas: { load: loadDocumentCanvas, Component: DocumentCanvas },
    projectPdfPanel: { load: loadProjectPdfPanel, Component: ProjectPdfPanel },
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
    cancelProjectTransition, captureProjectScope,
  } = projectState;
  const library = useProjectLibrary(projectState);
  const {
    papers, paperLoad, retryPapers, citationKeys, citations, references, bibliographyIndexPending,
    unusedSymbols, history, diskTodos, setDiskTodos, projectWordCount,
    loadHistory, loadTodos, loadWordCount, refreshUnusedSymbols, refreshHistory, refreshTodos, refreshWordCount,
    refreshAfterSave, refreshProject,
  } = library;
  const [buildPreferences, setBuildPreferences] = useState<BuildPreferences>(loadBuildPreferences);
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
    openFile, openAsset, openPaper, flush, save, load: loadFile, accept, reveal, chooseMode, clear: clearEditor,
  } = documents;
  const { file: activeFileRef, text: sourceRef, saved: savedSourceRef, asset: activeAssetRef } = documents.live;
  const { get: getFileViewState, remember: rememberFileViewState } = documents.viewStates;
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
  const editorCommentAuthorId = useMemo(() => loadEditorCommentAuthorId(), []);
  const [authorNameSetting, setAuthorNameSetting] = useState(loadAuthorNameSetting);
  // The writer's name as Git and the Overleaf session know it, which sign
  // comments ahead of the "Your name" setting.
  const [knownAuthorNames, setKnownAuthorNames] = useState<{ git: string | null; overleaf: string | null }>({
    git: null, overleaf: null,
  });
  const authorName = resolveAuthorName({ ...knownAuthorNames, setting: authorNameSetting });
  const [outlineOpen, setOutlineOpen] = useState(false);
  const projectRootRef = useLatestRef(project?.root ?? null);
  const agentProjectDocumentCreatorRef = useRef<((
    request: AgentProjectDocumentToolRequest,
  ) => Promise<string>) | null>(null);
  useEffect(() => registerAgentSpreadsheetDocumentResolver(async (path) => {
    const projectRoot = projectRootRef.current;
    if (!projectRoot) return null;
    const content = await invoke<string>("read_project_file", { path, projectRoot });
    const { openSpreadsheetDoc, spreadsheetDocContent } = await loadAgentSpreadsheetModel();
    const doc = openSpreadsheetDoc(content);
    return {
      doc,
      canWrite: true,
      path,
      commit: async () => {
        await invoke<void>("write_project_file", { path, content: spreadsheetDocContent(doc), projectRoot });
        recordSavedPaths([path]);
      },
      dispose: () => doc.destroy(),
    };
  }), [projectRootRef, recordSavedPaths]);
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
  const { theme, themePreference, setThemePreference, appearance, setAppearance, windowBacking } = useAppearance();
  const interfaceZoom = useInterfaceZoom(setAppearance);
  const whatsNew = useWhatsNew();
  // Where Settings returns focus if not to what held it as Settings opened
  // (the project menu's trigger, when Settings is opened from that menu), the
  // row it opens on when the palette found one, and whether a section was
  // asked for: one state, as each hook is paid on every App render.
  const [settingsEntry, setSettingsEntry] = useState<{ returnFocus: HTMLElement | null; reveal: SettingsSearchEntry | null; page: boolean }>(
    { returnFocus: null, reveal: null, page: false },
  );
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
      openProviderSettings: () => {
        setSettingsTab("agent");
        setSettingsEntry({ returnFocus: null, reveal: null, page: true });
        startSettingsOpen(() => setSettingsOpen(true));
      },
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
  const { origin: synaraOrigin, postMessage: postSynaraMessage, requestRuntime: requestSynaraRuntime } = synara;
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
  const { build, setBuild, building, outcome: buildOutcome, cleaning, pdfUrl, runBuild, cleanProject } = buildPipeline;
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
    showSettingsTab: (tab: SettingsTab) => {
      if (isSynaraSettingsTab(tab)) requestSynaraRuntime();
      setSettingsTab(tab);
      persistSettingsTab(tab);
    },
    /** Opens on `tab`, or without one on the page Settings was last left on; on `reveal`'s row, if given. */
    openSettings: (requested?: SettingsTab, returnFocus: HTMLElement | null = null, reveal: SettingsSearchEntry | null = null) => {
      showSettingsTab(requested ?? loadSettingsTab());
      setSettingsEntry({ returnFocus, reveal, page: requested !== undefined || reveal !== null });
      startSettingsOpen(() => setSettingsOpen(true));
    },
    // An urgent update after the opening transition's: it also withdraws a
    // pending open, so a Settings closed from its loading shell stays closed.
    closeSettings: () => {
      setSettingsOpen(false);
      setSettingsEntry({ returnFocus: null, reveal: null, page: false });
    },
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Opening Settings is a transition for the reason opening a lazy tool
  // drawer is (`useToolDrawers`), with the same loading shell.
  const [settingsOpening, startSettingsOpen] = useTransition();
  const settingsLate = useLoadingShell(settingsOpening, settingsOpening || settingsOpen);
  // Re-read on a project switch (Git config is per repository) and whenever
  // Settings opens, which is where a writer goes after signing in to Overleaf.
  useEffect(() => {
    let cancelled = false;
    const projectOpen = Boolean(project?.root);
    void Promise.all([
      projectOpen ? invoke<string | null>("git_user_name").catch(() => null) : Promise.resolve(null),
      invoke<OverleafStatus>("overleaf_status")
        .then((status) => (status?.connected ? status.name ?? null : null))
        .catch(() => null),
    ]).then(([git, overleaf]) => {
      // Keep the same object when neither name changed, so the lookup that
      // runs at every startup and Settings toggle does not re-render App.
      if (!cancelled) {
        setKnownAuthorNames((prev) => (
          prev.git === (git ?? null) && prev.overleaf === overleaf ? prev : { git: git ?? null, overleaf }
        ));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project?.root, settingsOpen]);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(loadSettingsTab);
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
    overleafLink, overleafProjectLinked, overleafSyncing, overleafSyncMode, setOverleafSyncMode,
    overleafRemoteDelete, setOverleafRemoteDelete, overleafRemoteChanges, setOverleafRemoteChanges,
    overleafPickerOpen, setOverleafPickerOpen, overleafReviewOpen, setOverleafReviewOpen,
    setOverleafCollabOpen, conflictPath, setConflictPath,
    overleafSyncRef, refreshOverleafLink, publishProjectToOverleaf, runOverleafSync, flushDeferredWholeFileSync,
    settleRemoteDeletes, openCurrentOverleafProject, jumpToOverleafPeer, overleafRealtime, overleafPresence,
    overleafChat, overleafComments, overleafTrackChanges, overleafDocPaths,
    overleafActiveCursors,
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
  const replaceDiagnosticToken = (diagnostic: CompileDiagnostic, token: string, replacement: string) => {
    const line = diagnostic.line;
    if (!project || !line) return;
    const path = resolveDiagnosticPath(diagnostic.file, flattenProjectPaths(project.files), activeFile);
    void buildErrorFix.replaceToken(path, line, token, replacement);
  };

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
    startProjectTransition, revealNewProject, chooseExisting, createProject, chooseRecentProject,
    openTutorialProject, importOverleafZip, exportProjectZip, moveWorkspace, movingWorkspace,
  } = lifecycle;

  useEffect(() => {
    try {
      localStorage.setItem(BUILD_PREFERENCES_KEY, JSON.stringify(buildPreferences));
    } catch {
      // Build preferences still apply for the current session without storage.
    }
  }, [buildPreferences]);

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
  const {
    paperFetchStates, fetchAndOpenPaper, cancelPaperFetches, readDraggedPaper, deletePaper,
  } = usePaperActions({
    projectState, documents, refreshProject, refreshHistory,
    clearImportStage: referenceImport.clearStage, openForMissingPaperTools: texSetup.openForMissingPaperTools,
  });

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
    projectPaths, rootDocumentPath, outlineNodes, liveReferences, todoHits, bodyBoundary, forgetIncludedSources,
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
  const { openFileFromClick: openProjectFileFromClick, openAssetFromClick: openProjectAssetFromClick } = tree;

  const {
    openMarkdownProjectPath, gotoDefinition, findSymbolReferences, beginRename, beginSymbolRename, openSymbolOccurrence,
    referenceHits, dismissReferenceHits, rename,
  } = useSourceNavigation({
    project, projectRef, papers, documents, library, forgetIncludedSources, updateCanvasRequest, tree,
    openProjectPathRef: openMarkdownProjectPathRef,
  });

  const handleEditorPosition = useCallback((position: EditorPosition) => {
    editorPositionRef.current = position;
    setEditorPosition((current) => (
      current?.path === position.path && current.line === position.line && current.column === position.column ? current : position
    ));
  }, [editorPositionRef, setEditorPosition]);



  useLayoutEffect(() => { openOverleafSettingsRef.current = () => openSettings("overleaf"); }, [openSettings]);


  const settingsDialog = (<>
    {settingsLate && (
      <SettingsLoadingShell label={t`Settings`} message={t`Loading settings…`} backdrop={!settingsOpen}
        returnFocus={settingsEntry.returnFocus} onClose={closeSettings} />
    )}
    <Suspense fallback={null}>
      {settingsOpen && <SettingsDialog
        covered={settingsLate}
        reveal={settingsEntry.reveal}
        openOnPage={settingsEntry.page}
        synaraRuntime={synara.runtime}
        synaraWorkspaceRoot={project?.root}
        onRetrySynaraRuntime={synara.retry}
        overleafSyncMode={overleafSyncMode}
        overleafRemoteDelete={overleafRemoteDelete}
        onOverleafRemoteDeleteChange={(mode) => {
          setOverleafRemoteDelete(mode);
          persistOverleafRemoteDelete(mode);
        }}
        overleafChannel={overleafSyncMode === "live" ? overleafRealtime.status : "off"}
        overleafChannelDetail={overleafRealtime.detail}
        onOverleafLinkChanged={refreshOverleafLink}
        onOverleafSyncModeChange={(mode) => {
          setOverleafSyncMode(mode);
          persistOverleafSyncMode(mode);
        }}
        tab={settingsTab}
        setTab={(tab) => {
          showSettingsTab(tab);
          if (tab === "doctor") void texSetup.runDoctor();
        }}
        doctorReport={texSetup.doctorReport}
        doctorBusy={texSetup.doctorBusy}
        doctorNotice={texSetup.doctorNotice}
        onRunDoctor={() => { void texSetup.runDoctor(); }}
        onOpenTexSetup={() => void texSetup.openWizard()}
        onCleanProject={() => { void cleanProject(); }}
        cleaning={cleaning}
        building={building}
        authorName={authorNameSetting}
        knownAuthorName={knownAuthorNames.git || knownAuthorNames.overleaf || null}
        onAuthorNameChange={(name) => {
          setAuthorNameSetting(name);
          persistAuthorNameSetting(name);
        }}
        appearance={appearance}
        setAppearance={setAppearance}
        theme={theme}
        themePreference={themePreference}
        setThemePreference={setThemePreference}
        windowBacking={windowBacking}
        buildPreferences={buildPreferences}
        setBuildPreferences={setBuildPreferences}
        hasProject={Boolean(project)}
        project={project}
        livePreview={livePreview}
        onUpdateManifest={(patch) => showingErrors(async () => {
          const manifest = patch.spellingWords != null
            ? await invoke<ProjectManifest>("set_project_spelling_words", { words: patch.spellingWords })
            : await invoke<ProjectManifest>("update_project_manifest", patch);
          setProject((current) => current ? { ...current, manifest } : current);
        })}
        returnFocus={settingsEntry.returnFocus}
        onClose={closeSettings}
      />}
    </Suspense>
  </>);

  const overleafPicker = (
    <LazyMount when={overleafPickerOpen}>
      <OverleafPickerDialog
        open
        onClose={() => setOverleafPickerOpen(false)}
        onBeforeClone={startProjectTransition}
        onCloneCancelled={cancelProjectTransition}
        onCloned={(root) => {
          setOverleafPickerOpen(false);
          void revealNewProject(t`Opening the Overleaf project…`, async () => root);
        }}
        currentProject={!overleafProjectLinked && project ? { name: project.manifest.name } : null}
        onPublish={publishProjectToOverleaf}
        onConnectionChanged={refreshOverleafLink}
      />
    </LazyMount>
  );

  const overleafReview = (<>
    <LazyMount when={overleafReviewOpen}>
      <OverleafReviewDialog
        open
        projectRoot={project?.root ?? null}
        onClose={() => setOverleafReviewOpen(false)}
        onApply={async () => {
          await runOverleafSync();
          setOverleafRemoteChanges(false);
        }}
      />
    </LazyMount>
    <LazyMount when={conflictPath !== null}>
      {conflictPath !== null && (
        <ConflictResolverDialog
          open
          path={conflictPath}
          projectRoot={project?.root ?? ""}
          onClose={() => setConflictPath(null)}
          onResolved={async (path) => {
            // Sync held this file back while it carried markers. Now that it
            // is settled, queue the upload so the choice reaches Overleaf.
            externalOverleafEditsRef.current([path]);
            await refreshProject();
            if (activeFile === path) await loadFile(path);
            await compile();
          }}
        />
      )}
    </LazyMount>
  </>);

  const primaryBibliography = project?.manifest.primaryBibliography ?? "";
  const protectedProjectPaths = useMemo(
    () => [...(rootDocumentPath ? [rootDocumentPath] : []), primaryBibliography],
    [primaryBibliography, rootDocumentPath],
  );
  // Versionless arXiv ids whose full text is already in the library — the
  // Discover panel shows these hits as done instead of importable.
  const importedArxivIds = useMemo(
    () => new Set(papers.filter((paper) => paper.hasFullText && paper.arxivId).map((paper) => baseArxivId(paper.arxivId))),
    [papers],
  );

  const texlabDiagnostics = useTexlabDiagnostics(project?.root, activeFile, source, build);

  // texlab, when installed, reports unused labels/citations itself, so the local
  // check would duplicate its warnings. Suppress the local one when texlab is
  // available (assume it is until the doctor report loads) and fall back to it
  // otherwise. The unused-symbol counts elsewhere still use the full list.
  const texlabActive = texSetup.doctorReport?.checks.some((check) => check.name === "texlab" && check.ok) ?? true;

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
  // The save slot's second layer (S1): whether the saved text has reached Overleaf too.
  const overleafSaveLayerState = overleafLink ? overleafSaveState({
    paused: Boolean(overleafLink.paused), syncing: overleafSyncing, mode: overleafSyncMode,
    channel: overleafRealtime.status, liveFile: overleafRealtime.liveFile,
    unacknowledged: overleafRealtime.unacknowledged, detail: overleafRealtime.detail,
  }) : null;
  const overleafLastSync = overleafLink?.lastSync ?? null;
  const saveSlotHandlers = useStableHandlers({
    onRetry: () => void documents.save(),
    // The copy is of the document whose write failed, as the slot names it:
    // with a Paper in front that is its reading file, not the retained source.
    onSaveCopy: () => {
      const path = documents.saveStatus.path ?? documents.canvas.path;
      const text = documents.bufferText(path);
      if (text !== null) void saveSourceCopy(path, text);
    },
    onSync: syncOverleaf,
  });
  // Memoized, as App re-renders on every keystroke and the slot is a popover.
  const saveStatus = documents.saveStatus;
  const saveSlot = useMemo<SaveSlot>(() => ({
    status: saveStatus,
    overleaf: overleafSaveLayerState ? { state: overleafSaveLayerState, lastSync: overleafLastSync } : null,
    ...saveSlotHandlers,
  }), [overleafLastSync, overleafSaveLayerState, saveSlotHandlers, saveStatus]);
  const { commands, overlays: commandOverlays, openPaletteFromTitlebar, paletteShortcut } = useCommandTable({
    project, papers, documents, trellis, layout: { focusMode, focusPdf, workspaceDirty }, buildPipeline, compileAndShowPdf,
    syncTex, agentContext, tools, tree, referenceImport, projectSearch, editorComments, lifecycle, overleaf, syncOverleaf,
    todoCount: todoHits.length, updateCanvasRequest, setSearchDialog, setTableGeneratorOpen, setArxivExportOpen,
    checkReferences, requestNewEntry, settingsOpen, openSettings, whatsNew, browserHosted,
    theme: { preference: themePreference, setPreference: setThemePreference }, interfaceZoom,
    knownAuthorName: knownAuthorNames.git || knownAuthorNames.overleaf || null,
    prewarmLikelyProjectFile, readDraggedPaper,
  });

  // Trellis workspace: App stays the owner of every document; the
  // workspace reads App through this bridge (at event time) and the store below.
  useTrellisBridge({
    trellis, project, projectRef, papers, documents, lastBuild: buildOutcome, building, buildPipeline,
    synara, tools, referenceImport, referenceImages, projectSearch, compile, compileAndShowPdf, revealSourceInPdf,
    openSettings, setSearchDialog, setProjectSearchOpen, setBibliographyAuditRoot, setBibliographyAuditOpen,
    requestNewEntry, reportPdfSelection: (text, place) => agentContext.reportSelection("pdf", text, place),
    shortcut: (id) => commandShortcutText(commands, id),
  });
  // Panel action rows (Trellis tab-bar accessories): memoized, because App
  // re-renders on every keystroke and each row is a set of tooltip buttons.
  const { permissionMode, autoModeAvailable, changePermissionMode } = synara;
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
    onFile: openProjectFileFromClick,
    onLikelyFile: prewarmLikelyProjectFile,
    onAsset: openProjectAssetFromClick,
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
    onPaper: (paper: PaperSummary) => void openPaper(paper),
    onLikelyPaper: prewarmLikelyPaper,
    onFetchFullText: (paper: PaperSummary) => void fetchAndOpenPaper(paper),
    onCancelFetch: cancelPaperFetches,
    onDeletePaper: deletePaper,
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

  // Shown over the welcome screen and a project alike.
  const appOverlays = (
    <>
      <InterfaceZoomHud scale={appearance.interfaceScale} revealKey={interfaceZoom.revealKey} onChange={interfaceZoom.zoom} />
      {whatsNew.open && (
        <Suspense fallback={null}>
          <WhatsNewDialog
            open
            onClose={() => whatsNew.setOpen(false)}
            onOpenUrl={(url) => void openUrl(url).catch((reason: unknown) => showError(toMessage(reason)))}
          />
        </Suspense>
      )}
    </>
  );
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
        {overleafPicker}
        {overleafReview}
        <TexSetupDialogs setup={texSetup} />
        {appOverlays}
      </>
    );
  }

  const editorEditableForPath = (path: string, ignoreOverleaf = false) => (
    !compileRepair.busy
    && !movingWorkspace
    && (
      ignoreOverleaf
      || overleafLink === null
      || overleafRealtime.canWrite
      || (
        overleafRealtime.permission !== "unknown"
        && overleafRealtime.entities.get(path)?.kind !== "doc"
        && !Array.from(overleafDocPaths.values()).includes(path)
      )
    )
  );
  // A citation opens its readable Paper when the library has one, else the source it cites.
  const sameKey = (key: string | undefined, other: string) => key?.toLocaleLowerCase() === other.toLocaleLowerCase();
  const readablePaperCited = (key: string) => papers.find((item) => sameKey(item.citationKey, key) && (item.hasFullText || item.hasBlog));
  const citationUrl = (key: string) => citationSourceUrl(citations.find((item) => sameKey(item.key, key)));


  // The outline, from the source's rail and status bar or the PDF's toolbar: its menu closes as the jump starts.
  const navigateOutline = (path: string, line: number) => {
    setOutlineOpen(false);
    void syncTex.navigateOutline(path, line);
  };

  const workspaceLoading = <div className="document-canvas-loading" aria-label={t`Preparing workspace`} />;
  const documentCanvas = (
    <DocumentCanvas
      document={{
        mode: canvasMode,
        workspaceIndex,
        source: canvasSource,
        settledSource: settledCanvasSource,
        markdownPreviewSource: documents.canvas.previewText,
        activeFile: documents.canvas.path,
        setSource: documents.canvas.setText,
        onSave: save,
        onVisualMarkdownFlushChange: documents.canvas.registerFlush,
        onMarkdownModeViewportCaptureChange: documents.canvas.registerViewportCapture,
        onCompletionCloseChange: documents.canvas.registerCompletionClose,
        onViewMarkdownSource: () => chooseMode("split"),
        activePaper,
        activeAsset,
        onActiveAssetChanged: documents.canvas.onAssetChanged,
        onPaperPdfOpenChange: setPaperPdfOpen,
        activeAssetMissing: documents.assetMissing,
        onEditorLeave: documents.canvas.onLeave,
        onCompletionActiveChange: documents.canvas.onCompletionActiveChange,
        onOpenMarkdownPath: openMarkdownProjectPath,
        // Papers live under .research/, which Overleaf deliberately
        // excludes from sync.
        editorEditable: editorEditableForPath(activeFile, activePaper !== null),
        editorKey,
        openPaths: documents.tabs,
      }}
      preferences={{
        projectRoot: project.root,
        locale: appLocale,
        theme,
        editorKeymap: appearance.editorKeymap,
        editorSpellcheck: appearance.editorSpellcheck,
        spellingWords: project.manifest.spellingWords ?? EMPTY_SPELLING_WORDS,
        onAddSpellingWord: addProjectSpellingWord,
        interactivePreviewsEnabled: postStartupInteraction,
      }}
      bibliography={{
        papers,
        onOpenPaper: (paper) => void openPaper(paper),
        onOpenUrl: (url) => void openUrl(url).catch((reason) => showError(toMessage(reason))),
        onResolveCitation: referenceImport.resolveBibQuery,
        citationUsageRevision: unusedSymbols,
        citationKeys,
        citations,
        references: liveReferences,
        indexPending: bibliographyIndexPending,
        unusedLabels: texlabActive ? [] : unusedSymbols.labels,
        unusedCitations: texlabActive ? [] : unusedSymbols.citations,
        onLoadReferenceImage: referenceImages.load,
        referenceImageGeneration: referenceImages.generation,
        localMacros: latex.macros,
        katexMacros: latex.katexMacros,
        projectPaths,
        graphicsRoots: latex.graphicsRoots,
      }}
      navigation={{
        requests: canvasRequests.requests,
        onRequestHandled: settleCanvasRequest,
        onEditorPosition: handleEditorPosition,
        onViewState: (path, state) => rememberFileViewState(path, { text: state }),
        getFileViewState,
        onFileViewState: rememberFileViewState,
        onGotoDefinition: (target) => void gotoDefinition(target),
        onTexlabGoto: (path, line) => { void openFile(path, { line }); },
        onFindReferences: (target) => void findSymbolReferences(target),
        onRenameSymbol: beginSymbolRename,
        onRenameEnvironment: (name) => beginRename({ kind: "environment", name }),
        onWrapEnvironment: () => beginRename({ kind: "wrap-environment" }),
        onGotoLineRequest: () => setSearchDialog("goto-line"),
        outlineNodes,
        outlineRootPath: rootDocumentPath,
        onOutlineNavigate: navigateOutline,
        tableGeneratorOpen,
        onTableGeneratorOpenChange: setTableGeneratorOpen,
        onCreateMissingFile: (path) => {
          void tree.createEntry(path, "file");
        },
      }}
      pdf={{ pdfUrl }}
      review={{
        editorComments: editorComments.all,
        overleafPresenceCursors: overleafActiveCursors,
        overleafChanges: overleafRealtime.changes,
        sourceMargin: overleafLink ? (view) => (
          <AppOverleafMarginReview overleaf={overleaf} view={view} path={documents.canvas.path} focusMode={focusMode} />
        ) : undefined,
        overleafTrackChangeActions: {
          authorName: overleafTrackChanges.authorName,
          canAct: () => overleafRealtime.canWrite,
          onAccept: (change) => void overleafTrackChanges.accept([change.id]),
          onReject: (change) => void overleafTrackChanges.reject([change]),
        },
        activeEditorCommentId: editorComments.activeId,
        // eslint-disable-next-line lingui/no-unlocalized-strings -- stored sentinel; editorCommentAuthorDisplayName translates it
        commentAuthorName: authorName.trim() || "Anonymous",
        commentAuthorId: editorCommentAuthorId,
        onCreateEditorComment: editorComments.create,
        annotationRounds,
        onOpenEditorComments: () => tools.open("comments"),
        onResolveEditorComment: editorComments.resolve,
        onReplyEditorComment: (commentId) => tools.open("comments", { replyTo: commentId }),
        onPostEditorCommentReply: editorComments.reply,
        commentFocusRequest: editorComments.focusRequest,
        onCommentFocusHandled: editorComments.focusHandled,
      }}
      selection={{
        setSelection: (value, lines) => agentContext.reportSelection(activePaper ? "paper" : "editor", value, undefined, lines),
        onPdfTextSelect: (value, place) => agentContext.reportSelection("pdf", value, place),
        onPaperTextSelect: (value) => agentContext.reportSelection("paper", value),
        onContextSurfaceActivate: agentContext.activateSurface,
      }}
      assets={{
        onImportAsset: tree.importClipboardImageFile,
        onOpenSlideMutation: applyOpenSlideMutation,
        onOpenSlideContext: setOpenSlideContext,
        onOpenSlideError: showError,
        onOpenSlideAgentRequest: (request) => {
          const root = projectRef.current?.root;
          if (!root) return;
          trellis.showPanel("agent");
          synara.sendComposerPrompt(openSlideComposerPrompt(request, root));
        },
        onPrepareFigure: tree.prepareLatexFigure,
        onPasteImageFile: tree.pasteImageFile,
        nativeFigureDropActive: tree.drops.editor,
        fileDropTargetActive: tree.drops.fileTarget,
      }}
      status={{
        buildDiagnostics: buildPipeline.compiledSources.get(activeFile) === source
          ? build?.diagnostics ?? EMPTY_DIAGNOSTICS
          : EMPTY_DIAGNOSTICS,
        texlabDiagnostics,
        todoCount: todoHits.length,
        onOpenTodos: () => tools.open("todos"),
        projectWordCount,
        saveSlot,
      }}
      hosts={{
        editorHost: trellis.hosts.editor,
        editorHibernated,
        hibernatedPlaceholder: null,
        decks: trellis.decks,
        switchState: trellis.switchState,
      }}
    />
  );

  // The build panel's engine actions: write the engine, then build with it.
  // `keepEngine` is the undo of an automatic switch, which must not recur.
  // Declared below the canvas: the compiler takes the canvas's
  // `buildPipeline.compiledSources.get` for a write to the pipeline and
  // memoizes no function made from it above that read, so the diagnostics
  // panel handed this one rendered again with every render of App.
  const switchEngineAndBuild = (engine: string, keepEngine?: boolean) => void showingErrors(async () => {
    const manifest = await invoke<ProjectManifest>("update_project_manifest", { engine, keepEngine });
    setProject((current) => current ? { ...current, manifest } : current);
    await buildPipeline.runBuild(false, { requested: true, sound: true });
  });

  // The diagnostics' excerpts quote the open buffer, and only an expanded list
  // naming its file shows one: handed the buffer otherwise, the panel above
  // the PDF re-rendered on every keystroke for nothing on screen.
  const diagnosticSourceOf = buildPipeline.diagnosticsExpanded
    && build?.diagnostics.some((diagnostic) => diagnosticMatchesFile(diagnostic.file, activeFile))
    ? (file: string | undefined) => (diagnosticMatchesFile(file, activeFile) ? source : null)
    : undefined;

  // The compiled PDF in its own panel, beside the canvas: it takes the open
  // document's path, not its text, so only what it shows changing renders it.
  const projectPdfPanel = (
    <ProjectPdfPanel
      host={pdfLive ? trellis.hosts.pdf : null}
      projectRoot={project.root}
      activeFile={documents.canvas.path}
      livePreview={livePreview}
      pdf={{
        pdfUrl,
        pdfBytes: buildPipeline.displayedPdfBytesRef.current,
        onBuildProject: () => void compileAndShowPdf(false, true),
        building,
        buildShortcut: commandShortcutText(commands, "build") ?? undefined,
        pdfTop: (!buildPipeline.diagnosticsDismissed || compileRepair.busy) && build && (!build.success || build.diagnostics.length > 0 || compileRepair.state) ? (
          <Suspense fallback={null}>
            <CompileDiagnosticsPanel
              diagnostics={build.diagnostics}
              log={build.log}
              success={build.success}
              wrotePdf={buildOutcome?.status === "failed" && buildOutcome.wrotePdf}
              expanded={buildPipeline.diagnosticsExpanded}
              onExpandedChange={buildPipeline.setDiagnosticsExpanded}
              onSelect={(diagnostic) => void openCompileDiagnostic(diagnostic)}
              onInstallDependency={texSetup.installDependency}
              onSwitchToPdfLatex={(project.manifest.engine ?? "pdf") === "pdf" ? undefined : () => switchEngineAndBuild("pdf")}
              onUndoEngineSwitch={(engine) => switchEngineAndBuild(engine, true)}
              onFixAll={() => { synara.requestRuntime(); void compileRepair.start(build.diagnostics); }}
              fixDisabled={!repairWritable || building || compileRepair.busy}
              repair={compileRepair.state}
              onCancelRepair={() => void compileRepair.cancel()}
              onOpenRepair={() => {
                const threadId = compileRepair.state?.threadId;
                if (!threadId) return;
                persistSynaraThread(project.root, threadId);
                synara.mountFrame();
                trellis.showPanel("agent");
                synara.showThread(threadId);
              }}
              onDismiss={() => buildPipeline.dismissDiagnostics(build.diagnostics)}
              sourceOf={diagnosticSourceOf}
              onReplaceToken={replaceDiagnosticToken}
              onAskAgent={(diagnostic) => { synara.requestRuntime(); void compileRepair.start([diagnostic]); }}
            />
          </Suspense>
        ) : null,
        pdfSyncTarget: syncTex.pdfSyncTarget,
        canForwardSync: syncTex.canForwardSync,
        locatingPdf: syncTex.locatingPdf,
        onForwardSync: () => void revealSourceInPdf(),
        onPdfSource: syncTex.revealPdfSource,
        onPdfPageCount: setPdfPageCount,
        onPdfPageChange: setPdfPageNumber,
      }}
      citations={{
        citations,
        canOpenCitation: (key) => Boolean(readablePaperCited(key) || citationUrl(key)),
        onOpenCitation: (key) => {
          const paper = readablePaperCited(key);
          const url = citationUrl(key);
          if (paper) void openPaper(paper);
          else if (url) void openUrl(url).catch((reason) => showError(toMessage(reason)));
        },
      }}
      outline={{
        nodes: outlineNodes,
        activeId: latex.activeOutlineId,
        open: outlineOpen,
        onOpenChange: setOutlineOpen,
        onNavigate: navigateOutline,
      }}
      review={{ annotations: editorComments.all, annotationRounds }}
      selection={{
        onPdfTextSelect: (value, place) => agentContext.reportSelection("pdf", value, place),
        onContextSurfaceActivate: agentContext.activateSurface,
      }}
      viewState={{ getFileViewState, onFileViewState: rememberFileViewState }}
      onLeaveEditor={documents.canvas.onLeaveForPdf}
    />
  );

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
        <CanvasToolbar
          activePath={activePaper ? activePaper.title : documents.activeTab}
          activeKind={activeAsset ? "asset" : activePaper ? "paper" : "document"}
          dirty={documents.dirty}
          onHistory={() => tools.open("history")}
          onGit={() => tools.open("git")}
          commentCount={unresolvedComments}
          onComments={() => tools.open("comments")}
          inBrowserTab={browserHosted}
          onMoveWorkspace={() => void moveWorkspace()}
          hiddenTools={appearance.hiddenTitlebarTools}
          overleafLinked={overleafLink !== null}
          overleafSyncing={overleafSyncing}
          overleafPending={overleafRemoteChanges}
          overleafLiveEditing={overleafRealtime.liveFile}
          overleafChannel={overleafSyncMode === "live" ? overleafRealtime.status : "off"}
          overleafChannelDetail={overleafRealtime.detail}
          overleafProjectName={overleafLink?.projectName}
          overleafPresence={overleafPresence.peers.length ? (
            <OverleafPresenceAvatars
              peers={overleafPresence.peers}
              reconnecting={overleafPresence.reconnecting}
              pathForDoc={(id) => overleafDocPaths.get(id) ?? null}
              onJump={jumpToOverleafPeer}
              onMessageEveryone={() => {
                overleaf.setOverleafCollabTab("chat");
                tools.open("comments");
                void overleafChat.refresh();
              }}
            />
          ) : null}
          onOverleafSync={syncOverleaf}
          onOverleafOpenCurrent={overleafLink ? openCurrentOverleafProject : undefined}
          onOverleafOpen={() => setOverleafPickerOpen(true)}
          overleafUnreadChat={
            overleafChat.unread + overleafComments.threads.filter((thread) => !thread.resolved).length + overleafRealtime.changes.length
            + editorComments.comments.filter((comment) => !comment.resolved).length
          }
          onOverleafChat={() => {
            tools.open("comments");
            void overleafChat.refresh();
          }}
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
        {createPortal(
          <Suspense fallback={null}>
            <ProjectFileTree
              key={project.root}
              projectKey={project.root}
              searchOpen={projectSearchOpen}
              newEntryRequest={newEntryRequest}
              revealRequest={tree.revealRequest}
              onSearchOpenChange={setProjectSearchOpen}
              files={project.files}
              gitStatus={projectGit.gitFiles}
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
          </Suspense>,
          trellis.hosts.project,
        )}
        {createPortal(
          <Suspense fallback={null}>
            <PaperLibrary
              projectKey={project.root}
              papers={papers}
              // Another project's read state says nothing about this one's.
              load={paperLoad.root === project.root ? paperLoad : PAPERS_LOADING}
              syncing={overleafSyncing && !papers.length}
              onRetryLoad={retryPapers}
              citations={citations}
              // Refreshed after every save, so the counts follow the manuscript.
              citationUsageRevision={unusedSymbols}
              activePaper={activePaper}
              paperFetchStates={paperFetchStates}
              importInput={referenceImport.input}
              recentImport={referenceImport.recentImport?.projectRoot === project.root ? referenceImport.recentImport : null}
              importStage={referenceImport.stage ? paperImportStageLabel(referenceImport.stage) : null}
              importStageId={referenceImport.stage}
              importLabel={referenceImport.importLabel}
              justAdded={referenceImport.justAdded?.projectRoot === project.root ? referenceImport.justAdded.keys : undefined}
              importing={referenceImport.importing}
              {...paperLibraryHandlers}
            />
          </Suspense>,
          trellis.hosts.papers,
        )}
        {createPortal(trellisActions.project, trellis.hosts.projectActions)}
        {createPortal(trellisActions.papers, trellis.hosts.papersActions)}
        {createPortal(trellisActions.agent, trellis.hosts.agentActions)}
        {agentPresent && createPortal(
          <Suspense fallback={<div className="synara-frame-shell"><SynaraLoadingSurface thread waiting={synara.frameMounted} runtime={synara.runtime} onRetry={synara.retryAgent} /></div>}>
            <TrellisAgentSurface
              synara={synara}
              projectRoot={project.root}
              theme={theme}
              appLocale={appLocale}
              dropActive={tree.drops.agentPanel}
            />
          </Suspense>,
          trellis.hosts.agent,
        )}
        {documents.opening && createPortal(
          <OpeningOverlay name={documents.opening} />,
          trellis.hosts.editor,
        )}
        <ChunkGate chunk={loadDocumentCanvas}>
          <Suspense fallback={null}>
            {documentCanvas}
          </Suspense>
        </ChunkGate>
        <ChunkGate chunk={loadProjectPdfPanel}>
          <Suspense fallback={null}>
            {projectPdfPanel}
          </Suspense>
        </ChunkGate>
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

      <LazyMount when={bibliographyAuditRoot === project.root}>
        <BibliographyAudit
          key={project.root}
          open={bibliographyAuditOpen}
          projectRoot={project.root}
          onClose={() => setBibliographyAuditOpen(false)}
          onPrepare={save}
          onApplied={() => refreshAfterSave(project.root, false, true)}
          onMissingPaperTools={(failure) => void texSetup.openForMissingPaperTools(failure)}
          onOpenSource={(path, line) => {
            // The report stays as it was behind the editor; reopening it resumes the queue.
            setBibliographyAuditOpen(false);
            void showingErrors(() => openFile(path, { line }));
          }}
          onApply={async (entry, result) => {
            const root = project.root;
            if (!result.after) throw new Error(t`This reference cannot be updated.`);
            if (!await save()) throw new Error(t`Save pending edits before updating references.`);
            if (projectRootRef.current !== root) throw new Error(t`The project or its permissions changed. Check references again.`);
            await invoke("bibliography_audit_apply", { projectRoot: root, path: entry.path, key: entry.key, before: result.before, after: result.after });
            // The update was written straight to disk, not through a save, so
            // nothing would otherwise schedule its Overleaf upload. Left
            // unsynced, it meets the next unrelated sync as a local edit and
            // any Overleaf change to the bibliography in between turns into a
            // conflict.
            if (projectRootRef.current !== root) return;
            externalOverleafEditsRef.current([entry.path]);
            const content = await invoke<string>("read_project_file", { projectRoot: root, path: entry.path });
            if (projectRootRef.current !== root) return;
            accept(entry.path, content, "clean");
            // The drawer refreshes derived citation/history data once per
            // apply action (including bulk), outside the durable-write path.
          }}
        />
      </LazyMount>
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
      {overleafPicker}
      {overleafReview}
      <LazyMount when={arxivExportOpen}>
        <ArxivExportDialog
          key={project.root}
          projectRoot={project.root}
          projectName={project.manifest.name}
          save={save}
          build={() => compile()}
          onClose={() => setArxivExportOpen(false)}
        />
      </LazyMount>

    </div>
    </TrellisControllerContext.Provider>
  );
}

export default App;
