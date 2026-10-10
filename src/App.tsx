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
import { configureInterfaceSounds } from "./telemetry/interface-sounds";
import { configureToastPosition } from "./telemetry/toast-position";
import { useProjectSearch } from "./app/use-project-search";
import { useReferenceImages } from "./app/use-reference-images";
import { useReferenceImport } from "./app/use-reference-import";
import { overleafThreadOf, useEditorComments } from "./app/use-editor-comments";
import { useAgentCheckpoints } from "./app/use-agent-checkpoints";
import { useBuildPipeline } from "./app/use-build-pipeline";
import { SynaraLoadingSurface } from "./agent/synara-loading-surface";
import { useTexSetup } from "./app/use-tex-setup";
import { isMissingPaperToolsError } from "./build/tex-setup";
import { useCanvasRequests } from "./app/use-canvas-requests";
import { useOpenDocuments } from "./app/use-open-documents";
import { useProjectLifecycle } from "./app/use-project-lifecycle";
import { useProjectTree } from "./app/use-project-tree";
import { useLatexStructure } from "./app/use-latex-structure";
import { useSyncTexNavigation } from "./app/use-synctex-navigation";
import { useSynaraHost } from "./app/use-synara-host";
import { useAgentContext } from "./app/use-agent-context";
import { useProjectState, useProjectTreeWatch } from "./app/use-project-state";
import { loadBibliographyIndex, useProjectLibrary } from "./app/use-project-library";
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
import { AppOverleafCollabDrawer } from "./app/app-overleaf-drawer";
import { AppEditorPanels } from "./app/app-editor-panels";
import { AppHistoryDrawers } from "./app/app-history-drawers";
import { SettingsLoadingShell } from "./app/tool-loading-shell";
import { useLoadingShell } from "./app/use-loading-shell";
import { AppProjectDialogs, TexSetupDialogs } from "./app/app-project-dialogs";
import { AppProjectSearchDialogs, AppSearchDialogs, type SearchDialog } from "./app/app-search-dialogs";
import { AppTitlebar } from "./app/app-titlebar";
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
  flattenProjectPaths,
  resolveDiagnosticPath,
  type CompileDiagnostic,
} from "./build/compile-diagnostics";
import { useTexlabDiagnostics } from "./build/use-texlab-diagnostics";
import { useCompileRepair } from "./build/use-compile-repair";
import { Welcome } from "./project/project-dialogs";
import { NEW_ENTRIES, type NewEntryRequest, type NewEntryType } from "./project/project-new-entries";
import { baseArxivId } from "./papers/arxiv-id";
import type {
  ProjectManifest,
  EditorPosition,
  PaperSummary,
  RenameTarget,
  RenameSymbolResult,
  SettingsTab,
  InsertSymbolCommand,
  ViewRestoreRequest,
  OverleafStatus,
} from "./app-types";
import {
  chooseAction,
  confirmAction,
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

type RemoveReferenceResult = {
  key: string;
  removed: boolean;
  blockers: SymbolOccurrence[];
  changedFiles: string[];
  removedCitations: number;
  transactionId?: string | null;
  changes?: Array<{
    path: string;
    before: string;
    after: string;
  }>;
};

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
// Lazy: the file tree pulls @pierre/trees (~270 KB), and neither sidebar
// panel renders on the Welcome screen, so they must not weigh down first paint.
// Memoized: their callbacks come through stable forwarders (useStableHandlers
// in App), so an editor keystroke does not re-render the file tree or the paper library.
const ProjectFileTree = lazy(() =>
  import("./project/project-file-tree").then((module) => ({ default: memo(module.ProjectFileTree) })),
);
const PaperLibrary = lazy(() =>
  import("./project/paper-library").then((module) => ({ default: memo(module.PaperLibrary) })),
);
const PaperDropBridge = lazy(() => import("./papers/paper-drop-bridge"));
const BibliographyAudit = lazy(() =>
  import("./papers/bibliography-audit").then((module) => ({ default: module.BibliographyAudit })),
);
const CompileDiagnosticsPanel = lazy(() =>
  import("./build/compile-diagnostics-panel").then((module) => ({ default: module.CompileDiagnosticsPanel })),
);
const DocumentCanvas = lazy(() =>
  loadDocumentCanvas().then((module) => ({ default: module.DocumentCanvas })),
);
// The workspace (and the Trellis library) load after the eager startup chunks.
const TrellisWorkspace = lazy(() => import("./trellis/trellis-workspace"));
const TrellisAgentSurface = lazy(() => import("./trellis/trellis-agent-surface"));
const GuidedTour = lazy(() => import("./onboarding/guided-tour"));
const ShortcutSheet = lazy(() => import("./app/shortcut-sheet"));
const SINGLETON_PANELS = ["project", "papers", "agent", "pdf", "history", "comments", "literature", "todos", "checklist", "git", "overleaf"] as const;

/** Shared empty word list: `?? []` in JSX rebuilds the editor's lint pass. */
const EMPTY_SPELLING_WORDS: string[] = [];

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
    papers, citationKeys, citations, references, bibliographyIndexPending,
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
  const { update: updateCanvasRequest } = canvasRequests;
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
  const addProjectSpellingWord = useCallback(async (word: string) => {
    const current = projectRef.current;
    const normalized = word.trim();
    if (!current || !normalized) return false;
    const words = current.manifest.spellingWords ?? [];
    if (words.some((existing) => existing.toLocaleLowerCase() === normalized.toLocaleLowerCase())) return true;
    try {
      const manifest = await invoke<ProjectManifest>("set_project_spelling_words", {
        words: [...words, normalized],
      });
      if (projectRef.current?.root === current.root) {
        setProject((snapshot) => snapshot ? { ...snapshot, manifest } : snapshot);
      }
      return true;
    } catch (reason) {
      showError(toMessage(reason));
      return false;
    }
  }, [projectRef, setProject]);
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
  const { openFind: openProjectFind, openReplace: openProjectReplace } = projectSearch;
  const [searchDialog, setSearchDialog] = useState<SearchDialog | null>(null);
  const openCompileDiagnosticRef = useRef<(diagnostic: CompileDiagnostic) => Promise<void>>(async () => undefined);
  const openMarkdownProjectPathRef = useRef<(path: string) => void>(() => undefined);
  const requestEditorLine = useCallback((path: string, line: number) => {
    updateCanvasRequest("navigation", { path, line, id: crypto.randomUUID() });
  }, [updateCanvasRequest]);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [paperFetchStates, setPaperFetchStates] = useState<Record<string, "loading" | "success">>({});
  const paperFetchTimers = useRef<Record<string, number>>({});
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
  // The command palette or the shortcut sheet: one at a time, and one state
  // (each hook is paid on every App render). The palette carries what it
  // leads with, read at each opening: another window may have run commands since.
  const [commandOverlay, setCommandOverlay] = useState<
    { kind: "palette"; recentCommands: string[]; recentFiles: string[] } | { kind: "shortcuts" } | null
  >(null);
  const [referenceHits, setReferenceHits] = useState<{
    kind: "label" | "citation";
    symbol: string;
    occurrences: SymbolOccurrence[];
  } | null>(null);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [newEntryRequest, setNewEntryRequest] = useState<NewEntryRequest | null>(null);
  const requestNewEntry = useCallback((type: NewEntryType) => {
    setNewEntryRequest((previous) => ({ type, serial: (previous?.serial ?? 0) + 1 }));
  }, []);
  const [openSlideContext, setOpenSlideContext] = useState<OpenSlideContext | null>(null);
  const { theme, themePreference, setThemePreference, appearance, setAppearance, windowBacking } = useAppearance();
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
  const resetAgentCompileTracking = useCallback((cancelQueuedBuild = false) => {
    resetAgentCheckpoints();
    resetBuildQueue(cancelQueuedBuild);
  }, [resetAgentCheckpoints, resetBuildQueue]);
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

  const projectHistory = useMemo(() => [...history, ...agentCheckpoints.historyItems].sort((left, right) => (
    right.timestamp.localeCompare(left.timestamp)
  )), [agentCheckpoints.historyItems, history]);

  const compile = useCallback(async (
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
  }, [project, runBuild]);
  useLayoutEffect(() => { compileRef.current = compile; }, [compile]);
  /**
   * An explicit build (button, palette) also brings a closed or hidden PDF
   * panel back under Trellis; in focus mode the PDF stays as the writer set it.
   */
  const compileAndShowPdf = useCallback<typeof compile>((...args) => {
    if (!trellis.ui.get().focus) trellis.showPanel("pdf", { focus: false });
    return compile(...args);
  }, [compile, trellis]);

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
    overleafSyncingRef, overleafSyncSettledRef, resolveOverleafSyncRef,
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

  const openCompileDiagnostic = useCallback(async (diagnostic: CompileDiagnostic) => {
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
  }, [activeFile, openFile, project, setDiagnosticsExpanded]);
  useEffect(() => {
    openCompileDiagnosticRef.current = openCompileDiagnostic;
  }, [openCompileDiagnostic]);

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
    busyLabel, recentProjects, unopenedProject, projectMenuOpen, setProjectMenuOpen, createForm, updateCreateForm,
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
      tools.resetForProject();
      setDiskTodos([]);
    },
    scanProject: async () => {
      await refreshUnusedSymbols();
      await loadHistory();
      await loadEditorComments();
      await loadTodos();
      await loadWordCount();
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
        arxiv ? { arxivId: paper.arxivId } : { url: paper.url },
      );
      await refreshProject();
      const fetched = (await invoke<PaperSummary[]>("list_papers"))
        .find((item) => item.arxivId === result.arxivId) ?? { ...paper, hasFullText: true };
      setPaperFetchStates((current) => ({ ...current, [key]: "success" }));
      if (paperFetchTimers.current[key]) window.clearTimeout(paperFetchTimers.current[key]);
      paperFetchTimers.current[key] = window.setTimeout(() => {
        clearFetchState();
        delete paperFetchTimers.current[key];
      }, 1100);
      if (!opening.isCurrent()) return;
      await openPaper(fetched, { claim: opening });
    };
    await fetchAndOpen().catch((reason: unknown) => {
      clearFetchState();
      const message = toMessage(reason);
      if (isMissingPaperToolsError(message)) void openForMissingPaperTools(message);
      else if (opening.isCurrent()) showError(message);
    }).finally(clearImportStage);
  }, [claim, clearImportStage, openForMissingPaperTools, openPaper, refreshProject]);

  const readDraggedPaper = (paper: PaperSummary) => {
    if (paper.hasFullText || paper.hasBlog) void openPaper(paper);
    else if (paper.arxivId || paper.url) void fetchAndOpenPaper(paper);
    else showError(t`This paper has no local reading or downloadable source.`);
  };

  useEffect(() => () => {
    Object.values(paperFetchTimers.current).forEach((timer) => window.clearTimeout(timer));
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
    // Go to symbol lists the same outline, so it reads the included files too.
    outlineWanted: outlineOpen || searchDialog === "goto-symbol",
    pdfShown: pdfUrl != null,
    compiledPdf: build?.success ? pdfUrl : null,
  });
  const {
    projectPaths, rootDocumentPath, outlineNodes, liveReferences, todoHits, appendixBoundary, forgetIncludedSources,
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
    try {
      if (renameTarget.kind === "label" || renameTarget.kind === "citation") {
        const result = await invoke<RenameSymbolResult>("rename_symbol", {
          kind: renameTarget.kind,
          oldName: renameTarget.kind === "label" ? renameTarget.label : renameTarget.key,
          newName: name,
        });
        applyBibliographyIndex(await loadBibliographyIndex());
        await refreshUnusedSymbols();
        await refreshHistory();
        if (result.changedFiles.includes(activeFile)) await loadFile(activeFile);
        forgetIncludedSources();
        setReferenceHits((current) => current && { kind: renameTarget.kind, symbol: name, occurrences: [] });
        await showSymbolReferences(renameTarget.kind, name);
      } else if (renameTarget.kind === "environment") {
        updateCanvasRequest("rename", { newName: name, id: crypto.randomUUID() });
      } else if (renameTarget.kind === "wrap-environment") {
        updateCanvasRequest("wrap", { name, id: crypto.randomUUID() });
      }
      setRenameError(null);
      setRenameTarget(null);
    } catch (reason) {
      setRenameError(toMessage(reason));
    }
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

  const deletePaper = useCallback(async (paper: PaperSummary) => {
    if (!paper.citationKey) {
      showError(t`This bibliography entry has no citation key to remove.`);
      return;
    }
    const projectRoot = project?.root;
    if (!projectRoot) return;
    const operationIsCurrent = captureProjectScope();
    try {
      // The blocker scan runs in Rust against durable project files. Flush the
      // editor first so a citation removed moments ago does not survive only
      // on disk and produce a blocker the visible document cannot find.
      if (!flush()) return;
      if (!await save()) return;
      const bibliographyPath = project?.manifest.primaryBibliography;
      const preview = await invoke<RemoveReferenceResult>("remove_reference", {
        key: paper.citationKey,
        citationMode: "preview",
        projectRoot,
      });
      if (!operationIsCurrent()) return;
      let citationMode: "keep" | "remove" | undefined;
      const confirmationTitle = t({ message: `Remove “${{ title: paper.title }}” from the bibliography?` });
      if (preview.blockers.length) {
        const count = preview.blockers.length;
        const first = preview.blockers[0];
        const citationCount = count === 1
          ? t`This entry is cited in 1 place.`
          : t({ message: `This entry is cited in ${{ count }} places.` });
        const location = first
          ? t({ message: `The first is at ${{ path: first.path }}:${{ line: first.line }}.` })
          : "";
        const choice = await chooseAction({
          title: confirmationTitle,
          message: [
            citationCount,
            location,
            t`Keeping the citation commands will leave them unresolved.`,
            t`Downloaded paper files will be kept.`,
          ].filter(Boolean).join(" "),
          confirmLabel: t`Remove citations too`,
          alternativeLabel: t`Keep citations`,
          alternativeDestructive: true,
          destructive: true,
        });
        if (choice === "cancel") return;
        citationMode = choice === "confirm" ? "remove" : "keep";
      } else {
        const confirmed = await confirmAction({
          title: confirmationTitle,
          message: t`Downloaded paper files will be kept.`,
          confirmLabel: t`Remove entry`,
          destructive: true,
        });
        if (!confirmed) return;
      }
      if (!operationIsCurrent()) return;
      const result = await invoke<RemoveReferenceResult>("remove_reference", {
        key: paper.citationKey,
        ...(citationMode ? { citationMode } : {}),
        projectRoot,
      });
      if (!operationIsCurrent()) return;
      if (!result.removed) {
        const first = result.blockers[0];
        const citationCommand = `\\cite{${paper.citationKey}}`;
        const blocker = first ? `${first.path}:${first.line}` : "";
        showError(first
          ? t`The bibliography changed while removing ${citationCommand} (${blocker}). Try again.`
          : t`Could not remove ${citationCommand}.`);
        return;
      }

      // The user can keep editing while the confirmation is
      // open. Rust returns the exact input/output pair for every file so the UI
      // can refuse to merge a stale whole-file result into a newer buffer.
      let conflictPath: string | null = null;
      for (const change of result.changes ?? []) {
        const diverged = (text: string) => text !== change.before && text !== change.after;
        if (activeFileRef.current === change.path && diverged(sourceRef.current)) {
          conflictPath = change.path;
          break;
        }
      }
      if (conflictPath) {
        // Revert itself is compare-and-swap guarded. If disk also changed,
        // leave both versions intact and direct the user to History.
        const reverted = Boolean(result.transactionId) && await invoke("revert_transaction", {
          transactionId: result.transactionId, projectRoot,
        }).then(() => true, () => false);
        if (operationIsCurrent()) {
          showError(reverted
            ? t`${conflictPath} changed while the reference was being removed. Nothing was removed; try again.`
            : t`${conflictPath} changed while the reference was being removed. The newer text was preserved; review the removal in History.`);
          await refreshProject();
          await refreshHistory();
        }
        return;
      }

      const changedFiles = result.changedFiles?.length ? result.changedFiles : bibliographyPath ? [bibliographyPath] : [];
      const returnedChanges = new Map((result.changes ?? []).map((change) => [change.path, change.after]));
      for (const path of changedFiles) {
        const content = returnedChanges.get(path) ?? await invoke<string>("read_project_file", { path, projectRoot });
        if (path === activeFile && accept(path, content)) await markDiskVersion();
      }
      if (activePaper && paperKey(activePaper) === paperKey(paper)) leavePaper();
      await refreshProject();
      await refreshHistory();
    } catch (reason) {
      showError(toMessage(reason));
    }
  }, [
    accept, activeFile, activeFileRef, activePaper, flush, leavePaper, markDiskVersion, project,
    refreshHistory, refreshProject, save, sourceRef, t, captureProjectScope,
  ]);

  const showSettingsTab = useCallback((tab: SettingsTab) => {
    if (isSynaraSettingsTab(tab)) requestSynaraRuntime();
    setSettingsTab(tab);
    persistSettingsTab(tab);
  }, [requestSynaraRuntime]);

  // Where Settings returns focus if not to what held it as Settings opened
  // (the project menu's trigger, when Settings is opened from that menu), and
  // the row it opens on when the palette found one: one state, as each hook
  // is paid on every App render.
  const [settingsEntry, setSettingsEntry] = useState<{ returnFocus: HTMLElement | null; reveal: SettingsSearchEntry | null }>(
    { returnFocus: null, reveal: null },
  );
  /** Opens on `tab`, or without one on the page Settings was last left on; on `reveal`'s row, if given. */
  const openSettings = useCallback((requested?: SettingsTab, returnFocus: HTMLElement | null = null, reveal: SettingsSearchEntry | null = null) => {
    showSettingsTab(requested ?? loadSettingsTab());
    setSettingsEntry({ returnFocus, reveal });
    startSettingsOpen(() => setSettingsOpen(true));
  }, [showSettingsTab]);

  // An urgent update after the opening transition's: it also withdraws a
  // pending open, so a Settings closed from its loading shell stays closed.
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    setSettingsEntry({ returnFocus: null, reveal: null });
  }, []);

  const settingsDialog = (<>
    {settingsLate && (
      <SettingsLoadingShell label={t`Settings`} message={t`Loading settings…`} backdrop={!settingsOpen}
        returnFocus={settingsEntry.returnFocus} onClose={closeSettings} />
    )}
    <Suspense fallback={null}>
      {settingsOpen && <SettingsDialog
        covered={settingsLate}
        reveal={settingsEntry.reveal}
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

  const overleafPicker = overleafPickerOpen ? (
    <Suspense fallback={null}>
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
    </Suspense>
  ) : null;

  const overleafReview = overleafReviewOpen || conflictPath !== null ? (
    <Suspense fallback={null}>
      {overleafReviewOpen && (
        <OverleafReviewDialog
          open
          projectRoot={project?.root ?? null}
          onClose={() => setOverleafReviewOpen(false)}
          onApply={async () => {
            await runOverleafSync();
            setOverleafRemoteChanges(false);
          }}
        />
      )}
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
    </Suspense>
  ) : null;

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
    // Trellis binds ⌘⇧↩ itself; the label follows what it would do now, as the titlebar's button does.
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
    // Writing and Reading, the layout switch's two presets; the one in use is not offered again.
    ...(["writing", "reading"] as const).filter((preset) => trellisUi.preset !== preset).map((preset): AppCommand => ({
      id: `preset-${preset}`, when: inProject, group: "layout",
      label: preset === "writing" ? t`Switch to the Writing layout` : t`Switch to the Reading layout`,
      run: () => trellis.setPreset(preset),
    })),
    // Project, Papers and the Agent toggle, as their titlebar buttons do; every other panel and tool is shown.
    ...SINGLETON_PANELS.map((kind): AppCommand => {
      const name = i18n._(PANEL_TITLES[kind]);
      const toggled = kind === "project" || kind === "papers" || kind === "agent";
      const hide = toggled && trellis.panelState(kind) === "shown";
      return {
        id: `panel-${kind}`, when: inProject, group: "layout",
        label: spaceMixedScript(hide ? t({ message: `Hide ${name} panel` }) : t({ message: `Show ${name} panel` })),
        run: () => (toggled ? trellis.togglePanel(kind) : trellis.showPanel(kind)),
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
    { id: "bib", when: inProject, label: t`Add bibliography entry`, group: "research", run: () => referenceImport.openBibEntry() },
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
    { id: "export-zip", when: inProject, label: t`Export project ZIP`, detail: t`Overleaf / arXiv source pack`, group: "project", run: () => void exportProjectZip() },
    { id: "new-project", label: t`New project`, group: "project", run: () => updateCreateForm({ open: true }) },
    { id: "open-folder", label: t`Open another folder`, group: "project", key: "o", run: () => void chooseExisting() },
    ...otherRecentProjects.map(({ name, path }, index): AppCommand => ({
      id: `recent-project-${index}`, label: spaceMixedScript(t`Open ${name}`), detail: path, group: "project",
      // Ids by position, so no path is remembered; and never in Recent, where a position may name another project.
      recent: false,
      run: () => void chooseRecentProject(path),
    })),
    { id: "import-zip", label: t`Import Overleaf ZIP`, group: "overleaf", run: () => void importOverleafZip() },
    { id: "overleaf-open", label: t`Open an Overleaf project`, group: "overleaf", run: () => setOverleafPickerOpen(true) },
    { id: "overleaf-sync", when: inProject && overleafLink !== null && !overleafSyncing, label: t`Sync with Overleaf`, group: "overleaf", run: syncOverleaf },
    { id: "overleaf-web", when: inProject && overleafLink !== null, label: t`Open this project on Overleaf`, group: "overleaf", run: () => void openCurrentOverleafProject() },
    {
      id: "tutorial", label: t`Open guided tutorial`, group: "project", run: () => void openTutorialProject(),
      detail: t`Learn Lattice with the Understanding Attention sample project`,
    },
    { id: "doctor", label: t`Run TeX doctor`, group: "project", run: () => openSettings("doctor") },
    {
      id: "browser", group: "project", run: () => void moveWorkspace(),
      ...(browserHosted
        ? { label: t`Open in Lattice app` }
        : { label: t`Open in browser`, detail: "http://127.0.0.1:18452" }),
    },
    // Light, dark or the system's: the two not in use.
    ...(["light", "dark", "system"] as const).filter((preference) => preference !== themePreference).map((preference): AppCommand => ({
      id: `theme-${preference}`, group: "appearance", keywords: t({ message: "theme appearance", comment: "Search words for the theme commands, space-separated" }),
      label: { light: t`Use the light theme`, dark: t`Use the dark theme`, system: t`Match the system theme` }[preference],
      run: () => setThemePreference(preference),
    })),
    { id: "settings", label: t`Open settings`, group: "project", key: ",", run: () => openSettings() },
  ];
  const runCommand = useAppCommands(commands);
  // The welcome screen's shortcuts are listed too.
  const shortcutSheet = commandOverlay?.kind === "shortcuts" && (
    <Suspense fallback={null}>
      <ShortcutSheet commands={commands} onClose={() => setCommandOverlay(null)} />
    </Suspense>
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
        openBibEntryDialog={referenceImport.openBibEntry}
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
    referenceImport.openBibEntry, requestNewEntry, setProjectSearchOpen, synaraOrigin,
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
    onPasteImage: (targetDirectory: string) => void tree.importSystemClipboardImage(targetDirectory),
  });
  const paperLibraryHandlers = useStableHandlers({
    onReveal: tree.revealItem,
    onPaper: (paper: PaperSummary) => void openPaper(paper),
    onLikelyPaper: prewarmLikelyPaper,
    onFetchFullText: (paper: PaperSummary) => void fetchAndOpenPaper(paper),
    onDeletePaper: deletePaper,
    onEditBibEntry: (paper: PaperSummary) => void referenceImport.editBibEntry(paper),
    setImportInput: referenceImport.setInput,
    onImport: referenceImport.importFromInput,
    onCancelImport: referenceImport.cancelImport,
  });

  if (!project) {
    return (
      <>
        <Welcome
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
        />
        {renderCommandPalette()}
        {shortcutSheet}
        {settingsDialog}
        {overleafPicker}
        {overleafReview}
        <TexSetupDialogs setup={texSetup} />
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


  const documentCanvas = (
    <DocumentCanvas
      projectRoot={project.root}
      locale={appLocale}
      theme={theme}
      mode={canvasMode}
      workspaceIndex={workspaceIndex}
      papers={papers}
      source={canvasSource}
      settledSource={settledCanvasSource}
      markdownPreviewSource={documents.canvas.previewText}
      activeFile={documents.canvas.path}
      setSource={documents.canvas.setText}
      onSave={save}
      onVisualMarkdownFlushChange={documents.canvas.registerFlush}
      onMarkdownModeViewportCaptureChange={documents.canvas.registerViewportCapture}
      setSelection={(value) => agentContext.reportSelection(activePaper ? "paper" : "editor", value)}
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
          />
        </Suspense>
      ) : null}
      activePaper={activePaper}
      activeAsset={activeAsset}
      onActiveAssetChanged={documents.canvas.onAssetChanged}
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
      onRequestHandled={canvasRequests.settle}
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
      onOpenEditorComments={() => tools.open("comments")}
      onResolveEditorComment={editorComments.toggleResolved}
      onReplyEditorComment={(commentId) => tools.open("comments", { replyTo: commentId })}
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
          onSettings: (returnFocus) => openSettings(undefined, returnFocus),
        }}
        panelControls={<TrellisTitlebar controller={trellis} />}
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
        <Suspense fallback={<div className="document-canvas-loading" aria-label={t`Preparing workspace`} />}>
          <TrellisWorkspace key={project.root} controller={trellis} projectRoot={project.root} dark={theme === "dark"} focusMode={focusMode} />
        </Suspense>
        {createPortal(
          <Suspense fallback={null}>
            <ProjectFileTree
              key={project.root}
              projectKey={project.root}
              searchOpen={projectSearchOpen}
              newEntryRequest={newEntryRequest}
              onSearchOpenChange={setProjectSearchOpen}
              files={project.files}
              gitStatus={projectGit.gitFiles}
              activeFile={activeAsset || activePaper ? "" : activeFile}
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
              activePaper={activePaper}
              paperFetchStates={paperFetchStates}
              importInput={referenceImport.input}
              recentImport={referenceImport.recentImport?.projectRoot === project.root ? referenceImport.recentImport : null}
              importStage={referenceImport.stage ? paperImportStageLabel(referenceImport.stage) : null}
              importStageId={referenceImport.stage}
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
          <Suspense fallback={<div className="synara-frame-shell"><SynaraLoadingSurface runtime={synara.runtime} onRetry={synara.retry} /></div>}>
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
        <Suspense fallback={null}>
          {documentCanvas}
        </Suspense>
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
        openTabs={documents.tabs}
        build={build}
        editorCommentAuthorId={editorCommentAuthorId}
        appendixBoundary={appendixBoundary}
        openProjectFile={openFile}
        pdfPageCount={pdfPageCount}
        project={project}
        projectWordCount={projectWordCount}
        setProject={setProject}
        tools={tools}
        todoHits={todoHits}
        unusedSymbols={unusedSymbols}
      />

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
        insertReference={insertCitation}
        goToLine={(line) => {
          if (activeFile) requestEditorLine(activeFile, line);
        }}
      />

      {bibliographyAuditRoot === project.root && <Suspense fallback={null}>
        <BibliographyAudit
          key={project.root}
          open={bibliographyAuditOpen}
          projectRoot={project.root}
          onClose={() => setBibliographyAuditOpen(false)}
          onPrepare={save}
          onApplied={() => refreshAfterSave(project.root, false, true)}
          onMissingPaperTools={(failure) => void texSetup.openForMissingPaperTools(failure)}
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
      </Suspense>}
      <AppProjectSearchDialogs
        search={projectSearch}
        openMarkdownProjectPath={openMarkdownProjectPath}
        openProjectFile={openFile}
      />

      <AppProjectDialogs
        references={referenceImport}
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
      />

      {renderCommandPalette()}
      {shortcutSheet}
      {settingsDialog}
      {overleafPicker}
      {overleafReview}

    </div>
    </TrellisControllerContext.Provider>
  );
}

export default App;
