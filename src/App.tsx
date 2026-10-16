import {
  Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition,
  type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as Y from "yjs";
import { bibliographyEntryLine, type DefinitionTarget, type SymbolTarget } from "./editor/latex/latex-text";
import { parsePaperLinkPath } from "./papers/paper-link";
import { canDownloadPaper, citationSourceUrl } from "./papers/paper-source";
import { paperImportStageLabel } from "./papers/paper-import-progress";
import {
  loadAuthorNameSetting, loadEditorCommentAuthorId, persistAuthorNameSetting, resolveAuthorName,
} from "./editor/comments/editor-comment-data";
import { useAppearance } from "./settings/use-appearance";
import { isBrowserHosted } from "./platform/browser-runtime";
import { BROWSER_ENTRY_PORT } from "./platform/flavor";
import { configureInterfaceSounds } from "./telemetry/interface-sounds";
import { configureToastPosition } from "./telemetry/toast-position";
import { useProjectSearch } from "./app/use-project-search";
import { useReferenceImages } from "./app/use-reference-images";
import { useReferenceImport } from "./app/use-reference-import";
import { overleafThreadOf, useEditorComments } from "./app/use-editor-comments";
import { annotationRounds, revisable } from "./app/annotation-rounds";
import { paperReview } from "./app/paper-review";
import { claimSupport } from "./app/claim-support";
import { useAgentCheckpoints } from "./app/use-agent-checkpoints";
import { useBuildPipeline } from "./app/use-build-pipeline";
import { SynaraLoadingSurface } from "./agent/synara-loading-surface";
import { useTexSetup } from "./app/use-tex-setup";
import { isMissingPaperToolsError } from "./build/tex-setup";
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
import { submitSymbolRename, type ReferenceHits } from "./app/symbol-rename-action";
import { removeReference } from "./app/remove-reference-action";
import { loadDocumentCanvas, usePreviewPrewarm } from "./app/use-preview-prewarm";
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
import { commandCombo, commandShortcutText, paletteEntries, useAppCommands, type AppCommand } from "./app/use-app-commands";
import { FocusModeBar } from "./app/focus-mode-bar";
import { paletteLeading, paletteSurface } from "./app/command-palette-leading";
import { CommandPalette } from "./app/command-palette";
import type { SettingsSearchEntry } from "./settings/settings-search-index";
import { collectFilePaths } from "./app/workspace-restore";
import { useToolDrawers } from "./app/use-tool-drawers";
import { useTrellisBridge } from "./app/use-trellis-bridge";
import { writeOpenSlideMutation } from "./app/open-slide-writes";
import { AppOverleafCollabDrawer, AppOverleafMarginReview } from "./app/app-overleaf-drawer";
import { requestMarginReviewHere, setMarginReviewMode } from "./overleaf/margin-review-mode";
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
import { RUNNING_VERSION } from "./app/whats-new";
import { overleafSaveState, type SaveSlot } from "./canvas/save-slot";
import { PanelActions } from "./trellis/trellis-panel-actions";
import { TrellisController, TrellisControllerContext, useTrellisUi } from "./trellis/trellis-controller";
import { TrellisTitlebar } from "./trellis/trellis-titlebar";
import { WORKSPACE_SHORTCUTS } from "./trellis/trellis-workspaces";
import { FOCUS_MODE_KEY, FRAME_TOGGLE_KEY } from "./trellis/trellis-keymap";
import { REVEAL_IN_PDF_KEY } from "./pdf/pdf-keys";
import { PANEL_TITLES, spaceMixedScript } from "./trellis/trellis-titles";
import { CanvasToolbar } from "./canvas/canvas-toolbar";
import type {
  OpenSlideContext,
  OpenSlideMutation,
  OpenSlideSyncOperation,
} from "./editor/presentation/open-slide-bridge";
import { InfinityLoader } from "./components/ui/activity-icons";
import { LazyMount } from "./components/lazy-mount";
import { ChunkGate } from "./components/chunk-gate";
import { lazyChunk } from "./lib/lazy-chunk";
import { loadPaperLibrary, loadProjectFileTree, loadTrellisWorkspace } from "./app/workspace-chunks";
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
  loadRecentCommands,
  rememberRecentCommand,
} from "./settings/app-settings";
import type { AgentProjectDocumentToolRequest } from "./agent/agent-project-document-tools";
import type { BuildAgentCommentsOptions } from "./agent/agent-editor-comments";
import { registerAgentSpreadsheetDocumentResolver } from "./agent/agent-spreadsheet-tools";
import { seedSpreadsheetDoc, spreadsheetDocContent } from "./editor/spreadsheet/spreadsheet-yjs";
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
import { welcomeDeskProjects } from "./project/first-pages";
import { NEW_ENTRIES, type NewEntryRequest, type NewEntryType } from "./project/project-new-entries";
import { baseArxivId } from "./papers/arxiv-id";
import type {
  ProjectManifest,
  EditorPosition,
  PaperSummary,
  RenameTarget,
  SettingsTab,
  InsertSymbolCommand,
  ViewRestoreRequest,
  OverleafStatus,
} from "./app-types";
import {
  isOpenSlideDeckPath,
  isProjectAssetFilePath,
  isProjectSourceFilePath,
  isWholeFileEditorPath,
  paperKey,
  resolveKnownWholeFileProjectPath,
  toMessage,
} from "./app-utils";
import { logAction } from "./telemetry/app-notify";
// setError / setWarning / setNotice are the toast shims; they
// live beside the hooks extracted out of this file so both can use them.
import { showError, showWarning, showingErrors } from "./app/notify";
import "./App.css";

const loadTexlabLanguage = () => import("./build/texlab-language");
const SettingsDialog = lazy(() =>
  import("./settings/settings-dialog").then((module) => ({ default: module.SettingsDialog })),
);
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
// The workspace and the canvas (and the PDF preview inside it) render behind a
// ChunkGate, so a project's first frame shows as soon as their chunks are in,
// with no Suspense reveal to wait out. The file tree and paper library above
// keep their boundaries: their reveal waits, after the editor's.
const DocumentCanvas = lazyChunk(loadDocumentCanvas, (module) => module.DocumentCanvas);
// The workspace (and the Trellis library) load after the eager startup chunks.
const TrellisWorkspace = lazyChunk(loadTrellisWorkspace, (module) => module.default);
const TrellisAgentSurface = lazy(() => import("./trellis/trellis-agent-surface"));
const GuidedTour = lazy(() => import("./onboarding/guided-tour"));
const ShortcutSheet = lazy(() => import("./app/shortcut-sheet"));
const WhatsNewDialog = lazy(() => import("./app/whats-new-dialog").then((module) => ({ default: module.WhatsNewDialog })));
const SINGLETON_PANELS = ["project", "papers", "agent", "pdf", "history", "comments", "literature", "todos", "checklist", "review", "support", "git", "overleaf"] as const;
/** The titlebar's toggled panels' keys, with ⌘⌥; their tooltips read them back from the command table. */
const PANEL_TOGGLE_KEYS: Partial<Record<(typeof SINGLETON_PANELS)[number], string>> = { project: "1", papers: "2", agent: "3" };

/** Shared empty word list: `?? []` in JSX rebuilds the editor's lint pass. */
const EMPTY_SPELLING_WORDS: string[] = [];
/** No revision in flight, for counting what the palette's Revise would ask about. */
const NO_RUNNING_REVISIONS: ReadonlySet<string> = new Set();

function isSynaraSettingsTab(tab: SettingsTab): boolean {
  return tab === "agent" || tab === "mcp" || tab === "api";
}

function App() {
  const { t, i18n } = useLingui();
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
    applyBibliographyIndex,
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
  const compileRef = useRef<(
    force?: boolean,
    sound?: boolean,
    options?: { consumeAgentAssociations?: boolean },
  ) => Promise<void>>(async () => undefined);
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
      afterSave: () => void buildPipeline.runBuild(false, { immediatePreview: false }),
      afterDiskEdit: () => void compileRef.current(),
    },
  });
  const {
    file: activeFile, text: source, savedText: savedSource, paper: activePaper, paperView, asset: activeAsset,
    mode: canvasMode,
  } = documents;
  const {
    openFile, openAsset, openPaper, flush, save, load: loadFile, accept, reveal, chooseMode, claim,
    markDiskVersion, leavePaper, edit: editFile, clear: clearEditor,
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
  } = usePreviewPrewarm(project, projectRef, { activeFile, activePaperId: activePaper?.arxivId, paperView });
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
  const { openFind: openProjectFind, openFindFor: openProjectFindFor, openReplace: openProjectReplace } = projectSearch;
  const [searchDialog, setSearchDialog] = useState<SearchDialog | null>(null);
  const openCompileDiagnosticRef = useRef<(diagnostic: CompileDiagnostic) => Promise<void>>(async () => undefined);
  const openMarkdownProjectPathRef = useRef<(path: string) => void>(() => undefined);
  const requestEditorLine = useCallback((path: string, line: number) => {
    updateCanvasRequest("navigation", { path, line, id: crypto.randomUUID() });
  }, [updateCanvasRequest]);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [paperFetchStates, setPaperFetchStates] = useState<Record<string, "loading" | "success">>({});
  // Each paper's download under way (its request id, which Cancel stops) and
  // the timer that clears its "success" glyph, by paper key.
  const paperFetches = useRef<{ requests: Record<string, string>; timers: Record<string, number> }>({ requests: {}, timers: {} });
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
    const doc = new Y.Doc();
    if (content) doc.getText("content").insert(0, content);
    seedSpreadsheetDoc(doc);
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
  // The command palette or the shortcut sheet: one at a time, and one state
  // (each hook is paid on every App render). The palette carries what it
  // leads with, read at each opening: another window may have run commands since.
  const [commandOverlay, setCommandOverlay] = useState<
    { kind: "palette"; recentCommands: string[]; recentFiles: string[] } | { kind: "shortcuts" } | null
  >(null);
  const [referenceHits, setReferenceHits] = useState<ReferenceHits | null>(null);
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
  });
  const { build, setBuild, building, outcome: buildOutcome, cleaning, pdfUrl, runBuild, abortBuild, cleanProject, cleanAndRebuild } = buildPipeline;
  const { reset: resetAgentCheckpoints } = agentCheckpoints;
  const { resetQueue: resetBuildQueue, cycleDiagnostic, setDiagnosticsExpanded } = buildPipeline;
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
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
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

  const applyOpenSlideMutation = useCallback(async (
    mutation: OpenSlideMutation,
  ): Promise<OpenSlideSyncOperation[]> => {
    const projectRoot = projectRef.current?.root;
    if (!projectRoot) throw new Error(t`The project closed before the Open Slide edit could be saved.`);
    const written = await writeOpenSlideMutation(mutation, projectRoot, () => projectRef.current?.root === projectRoot);
    if (written.text !== undefined) accept(mutation.path, written.text);
    if (written.hadConflicts) {
      const path = mutation.path;
      showWarning(t`Open Slide and another editor changed the same lines in ${path}; Lattice kept both with conflict markers.`);
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
  }, [accept, activeFileRef, clearEditor, loadFile, projectRef, recordSavedPaths, refreshHistory, refreshProject, t]);

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
  const {
    launching, busyLabel, recentProjects, unopenedProject, projectMenuOpen, setProjectMenuOpen, createForm, updateCreateForm,
    startProjectTransition, revealNewProject, chooseExisting, createProject, chooseRecentProject,
    openTutorialProject, importOverleafZip, exportProjectZip, moveWorkspace, movingWorkspace,
  } = useProjectLifecycle({
    projectState, documents, library, build: buildPipeline, cancelPrewarm: cancelPreviewPrewarm,
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
      paperReview.reset();
      claimSupport.reset();
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
    paperReview.attach({
      store: editorComments, projectRootRef, openProjectFile: openFile,
      author: { id: editorCommentAuthorId, name: authorName },
      manuscript: () => {
        const current = projectRef.current;
        const roots = current?.manifest.rootDocuments ?? [];
        const venue = current?.manifest.venue;
        return {
          root: (roots.find((document) => document.isDefault) ?? roots[0])?.path ?? null,
          paths: flattenProjectPaths(current?.files ?? []),
          venue: typeof venue === "string" && venue ? venue : null,
        };
      },
      findSupport: (claim) => void claimSupport.find(claim),
    });
    claimSupport.attach({
      projectRootRef, openProjectFile: openFile,
      openPanel: () => tools.open("support"),
      library: () => papers,
      addCitation: referenceImport.addCitation,
      addToPapers: async (query) => {
        const result = await referenceImport.importReference(query, { notices: "problems" }).catch(() => undefined);
        return result?.citationKey ?? null;
      },
      // The claim's file comes up first; the canvas places the citation once it shows it.
      citeAfter: (claim, key, signal) => new Promise((settled) => {
        const id = crypto.randomUUID();
        signal.addEventListener("abort", () => updateCanvasRequest("cite", (current) => current?.id === id ? null : current), { once: true });
        void openFile(claim.path, { line: claim.line });
        updateCanvasRequest("cite", { key, command: "citep", id, at: { ...claim, settled } });
        reveal("editor");
      }),
      searchLiterature: (query) => {
        referenceImport.searchLiterature(query);
        tools.open("literature");
      },
    });
  });
  const { clearStage: clearImportStage } = referenceImport;
  const { openForMissingPaperTools } = texSetup;

  const fetchAndOpenPaper = useCallback(async (paper: PaperSummary) => {
    if (!canDownloadPaper(paper)) {
      if (paper.url) await openUrl(paper.url).catch((reason: unknown) => showError(toMessage(reason)));
      return;
    }
    // Reserve the navigation when the user asks, not after a potentially slow
    // network fetch. Any later file/Paper/asset click invalidates this claim.
    const opening = claim();
    const key = paperKey(paper);
    const requestId = crypto.randomUUID();
    const fetches = paperFetches.current;
    fetches.requests[key] = requestId;
    // Cancel forgets the request at once; whatever the backend answers later is then ignored.
    const live = () => fetches.requests[key] === requestId;
    const clearFetchState = () => setPaperFetchStates((current) => (
      Object.fromEntries(Object.entries(current).filter(([fetching]) => fetching !== key))
    ));
    setPaperFetchStates((current) => ({ ...current, [key]: "loading" }));
    const fetchAndOpen = async () => {
      // Two fetchable shapes: an arXiv id (HTML or PDF route) and a cited
      // webpage (Firecrawl capture). Both return the same bundle contract, so
      // everything after this line treats them identically.
      const arxiv = paper.arxivId && !paper.arxivId.startsWith("web-");
      const result = await invoke<{ arxivId: string; paperPath: string; blogPath?: string | null }>(
        arxiv ? "fetch_paper" : "fetch_web_reference",
        arxiv ? { arxivId: paper.arxivId, requestId } : { url: paper.url, requestId },
      );
      if (!live()) return;
      delete fetches.requests[key];
      await refreshProject();
      const fetched = (await invoke<PaperSummary[]>("list_papers"))
        .find((item) => item.arxivId === result.arxivId) ?? { ...paper, hasFullText: true };
      setPaperFetchStates((current) => ({ ...current, [key]: "success" }));
      if (fetches.timers[key]) window.clearTimeout(fetches.timers[key]);
      fetches.timers[key] = window.setTimeout(() => {
        clearFetchState();
        delete fetches.timers[key];
      }, 1100);
      if (!opening.isCurrent()) return;
      await openPaper(fetched, { claim: opening });
    };
    await fetchAndOpen().catch((reason: unknown) => {
      if (!live()) return;
      delete fetches.requests[key];
      clearFetchState();
      const message = toMessage(reason);
      if (isMissingPaperToolsError(message)) void openForMissingPaperTools(message);
      else if (opening.isCurrent()) showError(message);
    }).finally(() => {
      if (!Object.keys(fetches.requests).length) clearImportStage();
    });
  }, [claim, clearImportStage, openForMissingPaperTools, openPaper, refreshProject]);

  // Stops the downloads under way: the backend kills the converter and keeps
  // nothing, and each paper is back where it was, ready to download again.
  const cancelPaperFetches = () => {
    const { requests } = paperFetches.current;
    const keys = Object.keys(requests);
    for (const key of keys) {
      void invoke("cancel_paper_fetch", { requestId: requests[key] }).catch(() => undefined);
      delete requests[key];
    }
    setPaperFetchStates((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !keys.includes(key))));
    clearImportStage();
  };

  const readDraggedPaper = (paper: PaperSummary) => {
    if (paper.hasFullText || paper.hasBlog) void openPaper(paper);
    else if (paper.arxivId || paper.url) void fetchAndOpenPaper(paper);
    else showError(t`This paper has no local reading or downloadable source.`);
  };

  useEffect(() => () => {
    Object.values(paperFetches.current.timers).forEach((timer) => window.clearTimeout(timer));
  }, []);

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

  const openMarkdownProjectPath = useCallback((path: string) => {
    const resolvedPath = resolveKnownWholeFileProjectPath(
      path,
      flattenProjectPaths(projectRef.current?.files ?? []),
    );
    // A link into a paper's cached markdown opens the Papers reading view,
    // not a plain editor tab: the plain tab loses the blog/full-text switch
    // and the paper selection context the agent reads. Falls through for a
    // paper that is no longer in the library.
    const paperLink = parsePaperLinkPath(resolvedPath);
    if (paperLink) {
      const paper = papers.find((item) => item.arxivId === paperLink.arxivId
        && (item.hasFullText || item.hasBlog));
      if (paper) {
        // The view the link named, when it is locally readable.
        void openPaper(paper, { view: paperLink.view });
        return;
      }
    }
    if (isProjectAssetFilePath(resolvedPath)) openProjectAssetFromClick(resolvedPath);
    else openProjectFileFromClick(resolvedPath);
  }, [openPaper, openProjectAssetFromClick, openProjectFileFromClick, papers, projectRef]);
  useEffect(() => {
    openMarkdownProjectPathRef.current = openMarkdownProjectPath;
  }, [openMarkdownProjectPath]);

  const handleEditorPosition = useCallback((position: EditorPosition) => {
    editorPositionRef.current = position;
    setEditorPosition((current) => (
      current?.path === position.path && current.line === position.line && current.column === position.column ? current : position
    ));
  }, [editorPositionRef, setEditorPosition]);

  const gotoDefinition = useCallback(async (target: DefinitionTarget) => {
    if (!project) return;
    await showingErrors(async () => {
      if (target.kind === "reference") return openFile(target.path, { line: target.line });
      if (target.kind === "include" || target.kind === "asset") {
        // A relative \input or \includegraphics path may name a file below a
        // search directory rather than the project root.
        const paths = flattenProjectPaths(project.files);
        const resolved = paths.includes(target.path)
          ? target.path
          : paths.find((path) => path.endsWith(`/${target.path}`));
        if (!resolved) {
          const path = target.path;
          throw new Error(target.kind === "include"
            ? t`Could not find included file “${path}”.`
            : t`Could not find figure “${path}”.`);
        }
        return target.kind === "include" ? openFile(resolved, { line: 1 }) : openAsset(resolved);
      }
      const bibliography = project.manifest.primaryBibliography;
      if (!bibliography) throw new Error(t`This project has no primary bibliography.`);
      const content = bibliography === activeFile
        ? source
        : await invoke<string>("read_project_file", { path: bibliography });
      await openFile(bibliography, { line: bibliographyEntryLine(content, target.key) ?? 1 });
    });
  }, [activeFile, openAsset, openFile, project, source, t]);

  /** List every occurrence of a label or citation key in the references panel. */
  const showSymbolReferences = useCallback(async (kind: "label" | "citation", symbol: string) => {
    const occurrences = await invoke<SymbolOccurrence[]>("find_symbol_occurrences", { kind, name: symbol });
    setReferenceHits({ kind, symbol, occurrences });
  }, []);

  const submitRename = useCallback(async (name: string) => {
    if (!renameTarget) return;
    await submitSymbolRename(renameTarget, name, {
      activeFile, loadFile, applyBibliographyIndex, refreshUnusedSymbols, refreshHistory, forgetIncludedSources,
      setReferenceHits, showSymbolReferences, updateCanvasRequest, setRenameError, setRenameTarget,
    });
  }, [
    activeFile, forgetIncludedSources, loadFile, refreshHistory, refreshUnusedSymbols, renameTarget, showSymbolReferences,
    updateCanvasRequest, applyBibliographyIndex,
  ]);

  const findSymbolReferences = useCallback((target: SymbolTarget) => showingErrors(
    () => showSymbolReferences(target.kind, target.kind === "label" ? target.label : target.key),
  ), [showSymbolReferences]);

  const beginRename = useCallback((target: RenameTarget) => {
    setRenameError(null);
    setRenameTarget(target);
  }, []);
  const beginSymbolRename = useCallback((target: SymbolTarget) => beginRename(target.kind === "label"
    ? { kind: "label", label: target.label }
    : { kind: "citation", key: target.key }), [beginRename]);

  const openSymbolOccurrence = useCallback((occurrence: SymbolOccurrence) => showingErrors(
    () => openFile(occurrence.path, { line: occurrence.line }),
  ), [openFile]);

  const deletePaper = useCallback((paper: PaperSummary) => removeReference(paper, {
    project, captureProjectScope, flush, save, activeFile, activeFileRef, sourceRef, accept, markDiskVersion,
    activePaper, leavePaper, refreshProject, refreshHistory,
  }), [
    accept, activeFile, activeFileRef, activePaper, flush, leavePaper, markDiskVersion, project,
    refreshHistory, refreshProject, save, sourceRef, captureProjectScope,
  ]);


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

  const formatFocusedDocument = () => {
    const path = activeFile;
    const text = source;
    if (!path.endsWith(".tex")) {
      showError(t`Open a .tex file before formatting.`, t`Format`);
      return;
    }
    const trace = logAction(t`Format`, t`Format document`, path);
    void loadTexlabLanguage()
      .then(({ formatLatexDocument }) => formatLatexDocument(path, text))
      .then((formatted) => {
        if (formatted === text) {
          trace.ok(t`Document is already formatted.`);
          return;
        }
        editFile(formatted);
        trace.ok(t`Formatted with latexindent.`);
      })
      .catch((reason) => trace.fail(reason));
  };
  const todoCount = todoHits.length;
  // A line jump lands in the text on screen: a Paper's reading file in front
  // of the retained source, never that source underneath it. An asset preview
  // and a Paper's original PDF have no lines to go to.
  const lineTarget = activeAsset || paperPdfOpen ? null : documents.canvas.path || null;
  const commandSurface = paletteSurface({ file: activeFile, paper: activePaper !== null, asset: Boolean(activeAsset) });
  // The welcome screen keeps the shortcuts listening, so a command that needs
  // a project, a text editor or LaTeX source says so and is neither listed
  // nor run without one.
  const inProject = project !== null;
  const textEditor = inProject && !activePaper && !activeAsset && Boolean(activeFile);
  const latexSource = inProject && commandSurface === "source";
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
  const editorSelected = agentContext.selectionSource === "editor" && agentContext.selection.trim() !== "";
  /** ⌘K (or ⌘⇧P) opens the palette, and closes it again. */
  const openCommandPalette = () => {
    if (commandOverlay?.kind === "palette") {
      setCommandOverlay(null);
      return;
    }
    const present = new Set(project ? collectFilePaths(project.files, (node) => Boolean(node.path)) : []);
    const shown = activeAsset?.path ?? (activePaper ? "" : activeFile);
    setCommandOverlay({
      kind: "palette",
      recentCommands: loadRecentCommands(),
      recentFiles: documents.recentPaths().filter((path) => path !== shown && present.has(path)),
    });
  };
  const trellisUi = trellis.ui.get();
  const docTools = trellis.docTools.get();
  const otherRecentProjects = recentProjects.filter((recent) => recent.path !== project?.root);
  // ⌘S saves, then builds what it saved; on a Paper there is nothing to build.
  const saveCommand: AppCommand = {
    id: "save", when: inProject, label: t`Save and build`, group: "build", key: "s", palette: false,
    run: () => void save().then((saved) => {
      if (!saved) return;
      void flushDeferredWholeFileSync();
      if (!activePaper) void compileAndShowPdf();
    }),
  };
  /** Every app-level action: the palette entries, the window's shortcuts and the shortcut sheet (see AppCommand). */
  const revisableAnnotations = editorComments.comments.filter((annotation) => revisable(annotation, NO_RUNNING_REVISIONS)).length;
  const commands: AppCommand[] = [
    // ⌘S reaches it through Save, which builds what it saved.
    { id: "build", when: inProject, label: t`Build project`, shortcut: commandCombo(saveCommand) ?? undefined, group: "build", run: () => void compileAndShowPdf(false, true) },
    saveCommand,
    { id: "rebuild", when: inProject, label: t`Clean rebuild`, detail: t`latexmk -c then -g`, group: "build", recent: false, run: () => void cleanAndRebuild() },
    { id: "clean", when: inProject, label: t`Clean aux files`, group: "build", recent: false, run: () => void cleanProject() },
    // Only ever wanted while a build runs, so never worth remembering.
    { id: "stop-build", when: building, label: t`Stop build`, group: "build", recent: false, run: () => void abortBuild() },
    { id: "sync-pdf", when: latexSource && syncTex.canForwardSync, label: t`Jump to PDF`, group: "navigate", ...REVEAL_IN_PDF_KEY, run: () => void revealSourceInPdf() },
    { id: "quick-open", when: inProject, label: t`Quick open file`, group: "navigate", key: "p", run: () => setSearchDialog("quick-open") },
    { id: "goto-line", when: textEditor, label: t`Go to line`, group: "navigate", key: "g", run: () => setSearchDialog("goto-line") },
    { id: "goto-symbol", when: textEditor, label: t`Go to symbol`, group: "navigate", key: "o", shift: true, run: () => setSearchDialog("goto-symbol") },
    { id: "back", when: inProject, label: t({ message: "Back", context: "Document history" }), group: "navigate", key: "[", palette: false, run: () => void documents.go(-1) },
    { id: "forward", when: inProject, label: t({ message: "Forward", context: "Document history" }), group: "navigate", key: "]", palette: false, run: () => void documents.go(1) },
    { id: "next-problem", label: t`Next build problem`, group: "navigate", key: "f8", mod: false, palette: false, run: () => cycleDiagnostic(1) },
    { id: "previous-problem", label: t`Previous build problem`, group: "navigate", key: "f8", shift: true, mod: false, palette: false, run: () => cycleDiagnostic(-1) },
    { id: "reopen-tab", when: inProject, label: t`Reopen the closed tab`, group: "navigate", key: "t", shift: true, palette: false, run: documents.reopenClosed },
    // ⌘K everywhere, the welcome screen included, and ⌘⇧P where it always was: one row in the sheet.
    { id: "palette", label: t`Command palette`, group: "project", key: "k", palette: false, run: openCommandPalette },
    { id: "palette-shift-p", label: t`Command palette`, group: "project", key: "p", shift: true, palette: false, run: openCommandPalette },
    // The window's ⌘?, the Mac's Help key: every shortcut, from these commands and the keymaps.
    { id: "shortcuts", label: t`Keyboard shortcuts`, group: "project", key: "?", shift: true, run: () => setCommandOverlay({ kind: "shortcuts" }) },
    // Reset the panel layout, and bring back any panel that was hidden or closed.
    { id: "layout-reset", when: inProject, label: t`Reset panel layout`, group: "layout", recent: false, run: () => void trellis.resetLayout() },
    // Trellis binds ⌘⇧↩ itself; the label follows what it would do now, as the Panels menu's entry does.
    trellisUi.framed
      ? { id: "frame", when: inProject, label: t`Restore the layout`, shortcut: FRAME_TOGGLE_KEY, group: "layout", run: () => trellis.ws?.navigation.frame("all") }
      : { id: "frame", when: inProject, label: t`Maximize focused panel`, shortcut: FRAME_TOGGLE_KEY, group: "layout", run: () => trellis.ws?.navigation.toggle() },
    // The named workspaces: each by name here, and ⌘1 to ⌘9 by position (read when pressed, so a reorder counts at once).
    ...trellis.workspaces.list().map(({ id, name }, index): AppCommand => ({
      id: `workspace-${id}`, when: inProject, label: spaceMixedScript(t`Switch to ${name}`), group: "layout",
      shortcut: index < WORKSPACE_SHORTCUTS ? { key: String(index + 1), mod: true } : undefined,
      run: () => trellis.switchWorkspace(id),
    })),
    ...Array.from({ length: WORKSPACE_SHORTCUTS }, (_, index): AppCommand => ({
      id: `workspace-${index + 1}`, when: inProject, label: t`Switch to a workspace by its place`, group: "layout", key: String(index + 1), palette: false,
      run: () => trellis.switchWorkspaceAt(index),
    })),
    {
      id: "focus-mode", when: inProject, label: focusMode ? t`Leave focus mode` : t`Focus mode`, detail: focusMode ? undefined : t`only the editor`,
      group: "layout", ...FOCUS_MODE_KEY, run: () => trellis.setFocus(!focusMode),
    },
    ...(focusMode ? [{
      id: "focus-pdf", label: focusPdf ? t`Hide the PDF` : t`Show the PDF beside the editor`, group: "layout" as const, run: () => trellis.setFocusPdf(!focusPdf),
    }] : []),
    { id: "workspace-new", when: inProject, label: t`New workspace`, group: "layout", run: () => void trellis.createWorkspace(t`Workspace`) },
    // While the project's layout differs from its workspace's saved arrangement.
    ...(workspaceDirty ? [
      { id: "workspace-save", when: inProject, label: t`Save to workspace`, group: "layout" as const, run: () => trellis.saveWorkspace() },
      { id: "workspace-revert", when: inProject, label: t`Revert to saved`, group: "layout" as const, recent: false as const, run: () => trellis.revertWorkspace() },
    ] : []),
    // Writing and Reading, the layout presets (also in the Panels menu); the one in use is not offered again.
    ...(["writing", "reading"] as const).filter((preset) => trellisUi.preset !== preset).map((preset): AppCommand => ({
      id: `preset-${preset}`, when: inProject, group: "layout",
      label: preset === "writing" ? t`Switch to the Writing layout` : t`Switch to the Reading layout`,
      run: () => trellis.setPreset(preset),
    })),
    // Project, Papers and the Agent toggle, as their Panels menu entries do, on ⌘⌥1 to ⌘⌥3 in the
    // menu's order (⌘1 to ⌘9 are the workspaces); every other panel and tool is shown.
    ...SINGLETON_PANELS.map((kind): AppCommand => {
      const name = i18n._(PANEL_TITLES[kind]);
      const toggleKey = PANEL_TOGGLE_KEYS[kind];
      const hide = toggleKey !== undefined && trellis.panelState(kind) === "shown";
      return {
        id: `panel-${kind}`, when: inProject, group: "layout",
        label: spaceMixedScript(hide ? t({ message: `Hide ${name} panel` }) : t({ message: `Show ${name} panel` })),
        ...(toggleKey ? { key: toggleKey, alt: true } : {}),
        run: () => (toggleKey ? trellis.togglePanel(kind) : trellis.showPanel(kind)),
      };
    }),
    // A Markdown or HTML file's or a Paper's Edit, Split and Preview, under the names their switch gives them.
    ...(docTools.viewModes ? (["source", "split", "pdf"] as const).filter((mode) => mode !== docTools.viewMode).map((mode): AppCommand => ({
      id: `view-${mode}`, when: inProject, group: "view",
      label: (docTools.viewModes === "html"
        ? { source: t`Edit HTML`, split: t`Edit and preview HTML`, pdf: t`Preview HTML` }
        : { source: t`Edit Markdown`, split: t`Edit and preview Markdown`, pdf: t`Preview Markdown` })[mode],
      run: () => documents.chooseMode(mode),
    })) : []),
    { id: "table", when: latexSource, label: t`Insert table`, detail: t`Grid generator`, group: "edit", run: () => setTableGeneratorOpen(true) },
    { id: "cite", when: latexSource, label: t`Insert citation`, group: "edit", key: "k", shift: true, run: () => setSearchDialog("cite") },
    { id: "ref", when: latexSource, label: t`Insert reference`, group: "edit", key: "l", shift: true, run: () => setSearchDialog("ref") },
    // The editor's own ⌘⌥P proofreads a selection; from here, the one the editor still holds.
    ...(["proofread", "polish"] as const).map((mode): AppCommand => ({
      id: mode, when: latexSource && editorSelected, group: "edit",
      label: mode === "proofread" ? t`Proofread selection` : t`Polish selection`,
      shortcut: mode === "proofread" ? { key: "p", mod: true, alt: true } : undefined,
      run: () => updateCanvasRequest("proofread", { mode, id: crypto.randomUUID() }),
    })),
    { id: "bib", when: inProject, label: t`Add papers`, detail: t`DOIs, arXiv IDs, links, titles or BibTeX`, group: "research", run: () => referenceImport.openAddSheet() },
    { id: "discover", when: inProject, label: t`Discover literature`, detail: t`OpenAlex search`, group: "research", run: () => tools.open("literature") },
    { id: "check-references", when: inProject, label: t`Check references`, group: "research", run: checkReferences },
    { id: "find", when: inProject, label: t`Find in project`, detail: t`source files and papers`, group: "edit", key: "f", shift: true, run: openProjectFind },
    { id: "replace", when: inProject, label: t`Replace in project`, detail: t`all source files`, group: "edit", key: "h", shift: true, run: openProjectReplace },
    {
      id: "todos", when: inProject, label: t`Manuscript TODOs`, detail: todoCount === 0 ? t`No markers` : todoCount === 1 ? t`${todoCount} marker` : t`${todoCount} markers`, group: "edit",
      run: () => tools.open("todos"),
    },
    {
      id: "checklist", when: inProject, label: t`Submission checklist`, detail: t`Words / pages / TODOs`, group: "edit",
      run: () => tools.open("checklist"),
    },
    {
      // Opens on the last review; with none yet, the command is the ask for one.
      id: "review-paper", when: inProject, label: t`Review the paper`, detail: t`As a reviewer would, each point anchored`, group: "research",
      run: () => {
        tools.open("review");
        void paperReview.startIfNone();
      },
    },
    { id: "annotations", when: inProject, label: t`Show annotations`, group: "edit", run: () => tools.open("comments") },
    {
      id: "annotations-revise", when: inProject && revisableAnnotations > 0, label: t`Revise from annotations`,
      detail: revisableAnnotations === 1 ? t`1 annotation` : t`${revisableAnnotations} annotations`, group: "edit",
      run: () => annotationRounds.revise(),
    },
    { id: "paste-image", when: inProject, label: t`Paste clipboard image as figure`, group: "edit", run: () => void tree.pasteClipboardImage() },
    { id: "format", when: latexSource, label: t`Format document`, detail: "latexindent", group: "edit", run: formatFocusedDocument },
    // The Project panel's + menu, which the tree answers with an inline field.
    // A panel already on screen keeps focus out of the way; one brought back
    // takes focus a frame later, so the field opens after that.
    ...NEW_ENTRIES.map(({ type, label }): AppCommand => ({
      id: `new-${type}`, when: inProject, label: i18n._(label), group: "project",
      run: () => {
        const shown = trellis.panelState("project") === "shown";
        trellis.showPanel("project", { focus: false });
        if (shown) requestNewEntry(type);
        else requestAnimationFrame(() => requestAnimationFrame(() => requestNewEntry(type)));
      },
    })),
    { id: "history", when: inProject, label: t`Open project history`, group: "project", run: () => tools.open("history") },
    { id: "export-zip", when: inProject, label: t`Export project ZIP`, detail: t`Overleaf source pack`, group: "project", run: () => void exportProjectZip() },
    { id: "export-arxiv", when: inProject, label: t`Export for arXiv…`, detail: t`Checked, comments removed, builds alone`, group: "project", run: () => setArxivExportOpen(true) },
    { id: "new-project", label: t`New project`, group: "project", run: () => updateCreateForm({ open: true }) },
    { id: "open-folder", label: t`Open another folder`, group: "project", key: "o", run: () => void chooseExisting() },
    ...otherRecentProjects.map(({ name, path }, index): AppCommand => ({
      id: `recent-project-${index}`, label: spaceMixedScript(t`Open ${name}`), detail: path, group: "project",
      // Ids by position, so no path is remembered; and never in Recent, where a position may name another project.
      recent: false,
      run: () => void chooseRecentProject(path),
    })),
    // ⌘1 to ⌘3 on the welcome screen: the projects on its desk, by place. In a
    // project the same keys switch workspaces, so these are only listed here.
    ...(inProject ? [] : welcomeDeskProjects(recentProjects, unopenedProject?.path).map(({ path }, index): AppCommand => ({
      id: `desk-project-${index + 1}`, label: t`Open a recent project by its place`, group: "project", key: String(index + 1), palette: false,
      when: !createForm.open && !busyLabel && !settingsOpen && !overleafPickerOpen,
      run: () => void chooseRecentProject(path),
    }))),
    { id: "import-zip", label: t`Import Overleaf ZIP`, group: "overleaf", run: () => void importOverleafZip() },
    { id: "overleaf-open", label: t`Open an Overleaf project`, group: "overleaf", run: () => setOverleafPickerOpen(true) },
    { id: "overleaf-sync", when: inProject && overleafLink !== null && !overleafSyncing, label: t`Sync with Overleaf`, group: "overleaf", run: syncOverleaf },
    { id: "overleaf-web", when: inProject && overleafLink !== null, label: t`Open this project on Overleaf`, group: "overleaf", run: () => void openCurrentOverleafProject() },
    // Margin review, as the View menu offers it (overleaf-margin-review.tsx); kept per window.
    { id: "margin-review-auto", when: inProject && overleafLink !== null, label: t`Margin review: Auto`, detail: t`cards beside the text when there is room`, group: "view", run: () => setMarginReviewMode("auto") },
    { id: "margin-review-markers", when: inProject && overleafLink !== null, label: t`Margin review: Markers only`, detail: t`full-width text, cards on demand`, group: "view", run: () => setMarginReviewMode("markers") },
    { id: "margin-review-off", when: inProject && overleafLink !== null, label: t`Margin review: Off`, group: "view", run: () => setMarginReviewMode("off") },
    { id: "margin-review-here", when: inProject && overleafLink !== null, label: t`Review here`, detail: t`the comment or suggestion by the caret`, group: "view", run: requestMarginReviewHere },
    { id: "whats-new", label: t`What’s new in Lattice`, detail: RUNNING_VERSION, group: "project", run: () => whatsNew.setOpen(true) },
    {
      id: "tutorial", label: t`Open guided tutorial`, group: "project", run: () => void openTutorialProject(),
      detail: t`Learn Lattice with the Understanding Attention sample project`,
    },
    { id: "doctor", label: t`Run TeX doctor`, group: "project", run: () => openSettings("doctor") },
    {
      id: "browser", group: "project", run: () => void moveWorkspace(),
      ...(browserHosted
        ? { label: t`Open in Lattice app` }
        : { label: t`Open in browser`, detail: `http://127.0.0.1:${BROWSER_ENTRY_PORT}` }),
    },
    // Light, dark or the system's: the two not in use.
    ...(["light", "dark", "system"] as const).filter((preference) => preference !== themePreference).map((preference): AppCommand => ({
      id: `theme-${preference}`, group: "appearance", keywords: t({ message: "theme appearance", comment: "Search words for the theme commands, space-separated" }),
      label: { light: t`Use the light theme`, dark: t`Use the dark theme`, system: t`Match the system theme` }[preference],
      run: () => setThemePreference(preference),
    })),
    // The interface size, as every Mac app binds it; ⌘= is ⌘+ without Shift.
    { id: "interface-bigger", label: t`Larger interface`, group: "appearance", key: "+", shift: true, run: () => interfaceZoom.zoom("in") },
    { id: "interface-bigger-unshifted", key: "=", palette: false, run: () => interfaceZoom.zoom("in") },
    { id: "interface-smaller", label: t`Smaller interface`, group: "appearance", key: "-", run: () => interfaceZoom.zoom("out") },
    { id: "interface-actual-size", label: t`Reset interface size`, group: "appearance", key: "0", run: () => interfaceZoom.zoom("reset") },
    { id: "settings", label: t`Open settings`, group: "project", key: ",", run: () => openSettings() },
  ];
  const runCommand = useAppCommands(commands);
  // The titlebar's search field is the palette's visible home. The titlebar
  // only re-renders with the workspace, so it gets one stable opener.
  const openCommandPaletteRef = useLatestRef(openCommandPalette);
  const openPaletteFromTitlebar = useCallback(() => openCommandPaletteRef.current(), [openCommandPaletteRef]);
  const paletteShortcut = commandShortcutText(commands, "palette") ?? undefined;
  // The welcome screen's shortcuts are listed too.
  const shortcutSheet = (
    <LazyMount when={commandOverlay?.kind === "shortcuts"}>
      <ShortcutSheet commands={commands} onClose={() => setCommandOverlay(null)} />
    </LazyMount>
  );
  const palette = commandOverlay?.kind === "palette" ? commandOverlay : null;
  const paletteCommands = palette ? paletteEntries(commands) : [];
  // A render function rather than an element: built ahead of the welcome
  // screen's early return, an element made the React Compiler give up on
  // six more of App's memoized callbacks (react-compiler-guard.test.ts).
  const renderCommandPalette = () => palette && (
    <CommandPalette
      commands={paletteCommands}
      leading={paletteLeading(paletteCommands, palette.recentCommands, commandSurface, {
        recent: t`Recent`,
        surface: commandSurface === "paper" ? t`In this paper` : t`In this document`,
      })}
      // Listed only while open, from the tree as it is now.
      files={project ? collectFilePaths(project.files, (node) => Boolean(node.path)) : []}
      recentFiles={palette.recentFiles}
      papers={project ? papers : []}
      hasProject={inProject}
      knownAuthorName={knownAuthorNames.git || knownAuthorNames.overleaf || null}
      onFileIntent={prewarmLikelyProjectFile}
      onClose={() => setCommandOverlay(null)}
      onChoose={(choice) => {
        setCommandOverlay(null);
        if (choice.kind === "command") rememberRecentCommand(choice.id);
        // Only once the palette has handed focus back to where it was, so a
        // command that moves focus itself (the tree's inline New file field)
        // keeps it. The dialog returns focus in a microtask as it unmounts,
        // and Radix's FocusScope again on a zero-delay timer it starts then;
        // this timer, started before that unmount, starts one more after it.
        window.setTimeout(() => window.setTimeout(() => {
          if (choice.kind === "command") runCommand(choice.id);
          else if (choice.kind === "file") {
            if (isProjectAssetFilePath(choice.path)) void openAsset(choice.path);
            else void openFile(choice.path);
          } else if (choice.kind === "paper") readDraggedPaper(choice.paper);
          else if (choice.kind === "find") openProjectFindFor(choice.query);
          else openSettings(choice.entry.tab, null, choice.entry);
        }, 0), 0);
      }}
    />
  );

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
        {renderCommandPalette()}
        {shortcutSheet}
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


  // The build panel's engine actions: write the engine, then build with it.
  // `keepEngine` is the undo of an automatic switch, which must not recur.
  const switchEngineAndBuild = (engine: string, keepEngine?: boolean) => void showingErrors(async () => {
    const manifest = await invoke<ProjectManifest>("update_project_manifest", { engine, keepEngine });
    setProject((current) => current ? { ...current, manifest } : current);
    await buildPipeline.runBuild(false, { requested: true, sound: true });
  });

  const workspaceLoading = <div className="document-canvas-loading" aria-label={t`Preparing workspace`} />;
  const documentCanvas = (
    <DocumentCanvas
      projectRoot={project.root}
      locale={appLocale}
      theme={theme}
      mode={canvasMode}
      workspaceIndex={workspaceIndex}
      papers={papers}
      onOpenPaper={(paper) => void openPaper(paper)}
      onOpenUrl={(url) => void openUrl(url).catch((reason) => showError(toMessage(reason)))}
      onResolveCitation={referenceImport.resolveBibQuery}
      citationUsageRevision={unusedSymbols}
      source={canvasSource}
      settledSource={settledCanvasSource}
      markdownPreviewSource={documents.canvas.previewText}
      activeFile={documents.canvas.path}
      setSource={documents.canvas.setText}
      onSave={save}
      onVisualMarkdownFlushChange={documents.canvas.registerFlush}
      onMarkdownModeViewportCaptureChange={documents.canvas.registerViewportCapture}
      setSelection={(value, lines) => agentContext.reportSelection(activePaper ? "paper" : "editor", value, undefined, lines)}
      onPdfTextSelect={(value, place) => agentContext.reportSelection("pdf", value, place)}
      onPaperTextSelect={(value) => agentContext.reportSelection("paper", value)}
      onImportAsset={tree.importClipboardImageFile}
      onContextSurfaceActivate={agentContext.activateSurface}
      onViewMarkdownSource={() => chooseMode("split")}
      onOpenSlideMutation={applyOpenSlideMutation}
      onOpenSlideContext={setOpenSlideContext}
      onOpenSlideError={showError}
      pdfUrl={pdfUrl}
      pdfBytes={buildPipeline.displayedPdfBytesRef.current}
      onBuildProject={() => void compileAndShowPdf(false, true)}
      building={building}
      buildShortcut={commandShortcutText(commands, "build") ?? undefined}
      pdfTop={(!buildPipeline.diagnosticsDismissed || compileRepair.busy) && build && (!build.success || build.diagnostics.length > 0 || compileRepair.state) ? (
        <Suspense fallback={null}>
          <CompileDiagnosticsPanel
            diagnostics={build.diagnostics}
            log={build.log}
            success={build.success}
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
            sourceOf={(file) => (diagnosticMatchesFile(file, activeFile) ? source : null)}
            onReplaceToken={replaceDiagnosticToken}
            onAskAgent={(diagnostic) => { synara.requestRuntime(); void compileRepair.start([diagnostic]); }}
          />
        </Suspense>
      ) : null}
      activePaper={activePaper}
      activeAsset={activeAsset}
      onActiveAssetChanged={documents.canvas.onAssetChanged}
      onPaperPdfOpenChange={setPaperPdfOpen}
      activeAssetMissing={documents.assetMissing}
      canOpenCitation={(key) => Boolean(readablePaperCited(key) || citationUrl(key))}
      onOpenCitation={(key) => {
        const paper = readablePaperCited(key);
        const url = citationUrl(key);
        if (paper) void openPaper(paper);
        else if (url) void openUrl(url).catch((reason) => showError(toMessage(reason)));
      }}
      citationKeys={citationKeys}
      citations={citations}
      references={liveReferences}
      indexPending={bibliographyIndexPending}
      unusedLabels={texlabActive ? [] : unusedSymbols.labels}
      unusedCitations={texlabActive ? [] : unusedSymbols.citations}
      onLoadReferenceImage={referenceImages.load}
      referenceImageGeneration={referenceImages.generation}
      onEditorLeave={documents.canvas.onLeave}
      onPrepareFigure={tree.prepareLatexFigure}
      onPasteImageFile={tree.pasteImageFile}
      nativeFigureDropActive={tree.drops.editor}
      fileDropTargetActive={tree.drops.fileTarget}
      requests={canvasRequests.requests}
      onRequestHandled={settleCanvasRequest}
      onEditorPosition={handleEditorPosition}
      onCompletionActiveChange={documents.canvas.onCompletionActiveChange}
      onViewState={(path, state) => rememberFileViewState(path, { text: state })}
      getFileViewState={getFileViewState}
      onFileViewState={rememberFileViewState}
      onGotoDefinition={(target) => void gotoDefinition(target)}
      onTexlabGoto={(path, line) => { void openFile(path, { line }); }}
      onFindReferences={(target) => void findSymbolReferences(target)}
      onRenameSymbol={beginSymbolRename}
      onRenameEnvironment={(name) => beginRename({ kind: "environment", name })}
      onWrapEnvironment={() => beginRename({ kind: "wrap-environment" })}
      localMacros={latex.macros}
      katexMacros={latex.katexMacros}
      onGotoLineRequest={() => setSearchDialog("goto-line")}
      outlineOpen={outlineOpen}
      onOutlineOpenChange={setOutlineOpen}
      outlineNodes={outlineNodes}
      activeOutlineId={latex.activeOutlineId}
      outlineRootPath={rootDocumentPath}
      onOutlineNavigate={(path, line) => {
        setOutlineOpen(false);
        void syncTex.navigateOutline(path, line);
      }}
      tableGeneratorOpen={tableGeneratorOpen}
      onTableGeneratorOpenChange={setTableGeneratorOpen}
      editorKeymap={appearance.editorKeymap}
      editorSpellcheck={appearance.editorSpellcheck}
      spellingWords={project.manifest.spellingWords ?? EMPTY_SPELLING_WORDS}
      onAddSpellingWord={addProjectSpellingWord}
      projectPaths={projectPaths}
      graphicsRoots={latex.graphicsRoots}
      buildDiagnostics={
        buildPipeline.compiledSources.get(activeFile) === source
          ? build?.diagnostics ?? EMPTY_DIAGNOSTICS
          : EMPTY_DIAGNOSTICS
      }
      texlabDiagnostics={texlabDiagnostics}
      pdfSyncTarget={syncTex.pdfSyncTarget}
      canForwardSync={syncTex.canForwardSync}
      locatingPdf={syncTex.locatingPdf}
      onForwardSync={() => void revealSourceInPdf()}
      onPdfSource={syncTex.revealPdfSource}
      editorComments={editorComments.all}
      overleafPresenceCursors={overleafActiveCursors}
      overleafChanges={overleafRealtime.changes}
      sourceMargin={overleafLink ? (view) => (
        <AppOverleafMarginReview overleaf={overleaf} view={view} path={documents.canvas.path} focusMode={focusMode} />
      ) : undefined}
      overleafTrackChangeActions={{
        authorName: overleafTrackChanges.authorName,
        canAct: () => overleafRealtime.canWrite,
        onAccept: (change) => void overleafTrackChanges.accept([change.id]),
        onReject: (change) => void overleafTrackChanges.reject([change]),
      }}
      activeEditorCommentId={editorComments.activeId}
      // eslint-disable-next-line lingui/no-unlocalized-strings -- stored sentinel; editorCommentAuthorDisplayName translates it
      commentAuthorName={authorName.trim() || "Anonymous"}
      commentAuthorId={editorCommentAuthorId}
      onCreateEditorComment={editorComments.create}
      annotationRounds={annotationRounds}
      onOpenEditorComments={() => tools.open("comments")}
      onResolveEditorComment={editorComments.resolve}
      onReplyEditorComment={(commentId) => tools.open("comments", { replyTo: commentId })}
      onPostEditorCommentReply={editorComments.reply}
      commentFocusRequest={editorComments.focusRequest}
      onCommentFocusHandled={editorComments.focusHandled}
      todoCount={todoHits.length}
      onOpenTodos={() => tools.open("todos")}
      projectWordCount={projectWordCount}
      onPdfPageCount={setPdfPageCount}
      onPdfPageChange={setPdfPageNumber}
      onCreateMissingFile={(path) => {
        void tree.createEntry(path, "file");
      }}
      onOpenMarkdownPath={openMarkdownProjectPath}
      interactivePreviewsEnabled={postStartupInteraction}
      // Papers live under .research/, which Overleaf deliberately
      // excludes from sync.
      editorEditable={editorEditableForPath(activeFile, activePaper !== null)}
      saveSlot={saveSlot}
      editorKey={editorKey}
      trellis={{
        editorHost: trellis.hosts.editor,
        pdfHost: pdfLive ? trellis.hosts.pdf : null,
        editorHibernated,
        hibernatedPlaceholder: null,
        decks: trellis.decks,
        switchState: trellis.switchState,
      }}
      openPaths={documents.tabs}
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
          onDismiss={() => setReferenceHits(null)}
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
              bibliographyName={project.manifest.primaryBibliography?.split("/").pop()}
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
          <div className="primary-opening-overlay" role="status" aria-live="polite">
            <InfinityLoader size={16} />
            <span>{t({ message: `Opening ${documents.opening}…` })}</span>
          </div>,
          trellis.hosts.editor,
        )}
        <ChunkGate chunk={loadDocumentCanvas}>
          <Suspense fallback={null}>
            {documentCanvas}
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
        rename={{
          target: renameTarget,
          error: renameError,
          submit: submitRename,
          close: () => {
            setRenameError(null);
            setRenameTarget(null);
          },
        }}
        importConflict={tree.importConflict}
      />

      {renderCommandPalette()}
      {shortcutSheet}
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
