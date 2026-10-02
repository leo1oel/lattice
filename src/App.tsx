import {
  Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ComponentProps, type SetStateAction,
} from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import * as Y from "yjs";
import {
  bibliographyEntryLine,
  findAppendixMarker,
  katexMacrosFromSources,
  mergeReferences,
  parseGraphicsPaths,
  parseLocalLabels,
  parseLocalMacros,
  type DefinitionTarget,
  type SymbolTarget,
} from "./editor/latex/latex-text";
import { clipboardImageFileName, fileToBase64, rgbaImageToPngBase64 } from "./editor/insert/clipboard-image";
import { SearchPickerDialog } from "./components/ui/search-picker-dialog";
import { parsePaperLinkPath } from "./papers/paper-link";
import { canDownloadPaper, citationSourceUrl } from "./papers/paper-source";
import { paperImportStageLabel } from "./papers/paper-import-progress";
import {
  loadAuthorNameSetting, loadEditorCommentAuthorId, persistAuthorNameSetting, resolveAuthorName,
} from "./editor/comments/editor-comment-data";
import { useAppearance } from "./settings/use-appearance";
import {
  browserRuntimeDetached, isBrowserHosted, isBundledChromium, setWorkspaceYieldHandler,
} from "./platform/browser-runtime";
import { configureInterfaceSounds } from "./telemetry/interface-sounds";
import { useProjectSearch } from "./app/use-project-search";
import { useReferenceImages } from "./app/use-reference-images";
import { useReferenceImport } from "./app/use-reference-import";
import { overleafThreadOf, useEditorComments } from "./app/use-editor-comments";
import { useAgentCheckpoints } from "./app/use-agent-checkpoints";
import { useBuildPipeline } from "./app/use-build-pipeline";
import { useTexSetup } from "./app/use-tex-setup";
import { useCanvasRequests } from "./app/use-canvas-requests";
import { useOpenDocuments } from "./app/use-open-documents";
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
import { disposeWhenSettled, useLatest } from "./app/effect-helpers";
import { useOverleafWorkspace } from "./app/use-overleaf-workspace";
import { useAppCommands, type AppCommand } from "./app/use-app-commands";
import { useTrellisBridge } from "./app/use-trellis-bridge";
import { writeOpenSlideMutation } from "./app/open-slide-writes";
import { AppOverleafCollabDrawer } from "./app/app-overleaf-drawer";
import { AppEditorPanels } from "./app/app-editor-panels";
import { AppHistoryDrawers } from "./app/app-history-drawers";
import { AppProjectDialogs, TexSetupDialogs, type CreateProjectForm } from "./app/app-project-dialogs";
import { AppProjectSearchDialogs, AppSearchDialogs, type SearchDialog } from "./app/app-search-dialogs";
import { AppTitlebar } from "./app/app-titlebar";
import { PanelActions } from "./trellis/trellis-panel-actions";
import { TrellisController, TrellisControllerContext, useTrellisUi, type TrellisToolKind } from "./trellis/trellis-controller";
import { TrellisTitlebar } from "./trellis/trellis-titlebar";
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
import { persistSynaraThread, type AgentTurnReview } from "./app/app-synara-embed";
import {
  type RecentProject,
  type BuildPreferences,
  BUILD_PREFERENCES_KEY,
  loadRecentProjects,
  forgetRecentProject,
  rememberRecentProject,
  loadBuildPreferences,
  persistOverleafRemoteDelete,
  persistOverleafSyncMode,
  hasSeenTutorial,
  markTutorialSeen,
  resolveAppLocale,
  loadSettingsTab,
  persistSettingsTab,
} from "./settings/app-settings";
import { waitForAgentCanvasAdapter } from "./agent/agent-canvas-tools";
import type { AgentProjectDocumentToolRequest } from "./agent/agent-project-document-tools";
import type { BuildAgentCommentsOptions } from "./agent/agent-editor-comments";
import {
  registerAgentSpreadsheetDocumentResolver,
  waitForAgentSpreadsheetDocument,
} from "./agent/agent-spreadsheet-tools";
import { seedSpreadsheetDoc, spreadsheetDocContent } from "./editor/spreadsheet/spreadsheet-yjs";
import { rewriteMovedDocumentAssetPaths } from "./editor/insert/figure-insertion";
import {
  EMPTY_DIAGNOSTICS,
  flattenProjectPaths,
  resolveDiagnosticPath,
  type CompileDiagnostic,
} from "./build/compile-diagnostics";
import { useTexlabDiagnostics } from "./build/use-texlab-diagnostics";
import { useCompileRepair } from "./build/use-compile-repair";
import { Welcome } from "./project/project-dialogs";
import { activeOutlineNode, includedPathsIn, parseProjectOutline } from "./editor/latex/latex-outline";
import { baseArxivId } from "./papers/arxiv-id";
import { type PdfSyncTarget } from "./pdf/pdf-viewer";
import { mergeTodosWithBuffer } from "./project/todo-scavenger";
import type {
  ProjectManifest,
  ProjectSnapshot,
  SyncTexTarget,
  EditorPosition,
  PdfSyncResponse,
  PaperSummary,
  RenameTarget,
  RenameSymbolResult,
  SettingsTab,
  InsertSymbolCommand,
  ViewRestoreRequest,
  OverleafStatus,
} from "./app-types";
import {
  absoluteProjectPath,
  applyProjectPathChanges,
  chooseAction,
  confirmAction,
  classifyExternalProjectDrop,
  dropAgentPanelAt,
  dropCanvasAt,
  dropDirectoryAt,
  dropEditorAt,
  isOpenSlideDeckPath,
  isProjectAssetFilePath,
  isProjectSourceFilePath,
  isWholeFileEditorPath,
  paperKey,
  projectItemPath,
  remapProjectPath,
  resolveKnownWholeFileProjectPath,
  toMessage,
  type ProjectPathChange,
} from "./app-utils";
import {
  type AgentGitWorkspaceView,
} from "./agent/synara-runtime";
import {
  buildAgentComposerFilesMessage,
  type AgentComposerFilePayload,
} from "./agent/agent-composer-files";
import { logAction } from "./telemetry/app-notify";
// setError / setWarning / setNotice are the ~170-call-site toast shims; they
// live beside the hooks extracted out of this file so both can use them.
import { setError, setNotice, setWarning } from "./app/notify";
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
// Lazy: the navigator pulls @pierre/trees (~270 KB) and never renders on the
// Welcome screen, so it must not weigh down first paint.
// Memoized: its callbacks come through stable forwarders (navigatorHandlers in
// App), so an editor keystroke does not re-render the file tree and paper library.
const Navigator = lazy(() =>
  import("./project/navigator").then((module) => ({ default: memo(module.Navigator) })),
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
const SINGLETON_PANELS = ["project", "papers", "agent", "pdf", "history", "comments", "literature", "todos", "checklist", "git", "overleaf"] as const;
const ignoreSearchOpenChange = () => {};

const NAVIGATOR_HANDLER_KEYS = [
  "onFile", "onLikelyFile", "onAsset", "onBeginFigureDrag", "onBeginFileDrag", "onCreateEntry", "onDeleteEntries",
  "onRenameEntry", "onMoveEntries", "onCopyEntries", "onError", "onReveal", "onImportAssets", "onPasteImage", "onPaper",
  "onLikelyPaper", "onFetchFullText", "onDeletePaper", "onEditBibEntry", "setImportInput", "onImport", "onCancelImport",
] as const;
type NavigatorHandlers = Pick<ComponentProps<typeof Navigator>, typeof NAVIGATOR_HANDLER_KEYS[number]>;

/** Shared empty word list: `?? []` in JSX rebuilds the editor's lint pass. */
const EMPTY_SPELLING_WORDS: string[] = [];

/** How long a project switch waits for an in-flight Overleaf sync before giving up on it. */
const PROJECT_SWITCH_SYNC_WAIT_MS = 15_000;

// Must match the prefix `open_project_window` puts on a window-creation
// failure. Everything else it can fail with is the project itself.
// eslint-disable-next-line lingui/no-unlocalized-strings -- matched against the backend's error text
const NEW_WINDOW_FAILURE_PREFIX = "Could not open a new window";

function isSynaraSettingsTab(tab: SettingsTab): boolean {
  return tab === "agent" || tab === "mcp" || tab === "api";
}

/** Run `action`: success clears the error banner, a failure shows its message there. */
async function showingErrors(action: () => Promise<unknown>) {
  try {
    await action();
    setError(null);
  } catch (reason) {
    setError(toMessage(reason));
  }
}

/**
 * Follow a pointer drag of a project-tree row. Past a 5px threshold,
 * `handOff` gets each pointer position until it takes the drag over (the
 * Trellis workspace, once the pointer leaves the Project panel); the click
 * that ends a handed-off drag is swallowed through `suppressClick`. A drag
 * that never leaves the panel belongs to the tree, which moves files.
 */
function trackProjectItemDrag(
  path: string,
  event: React.PointerEvent,
  suppressClick: { current: string | null },
  handOff: (pointer: PointerEvent) => boolean,
) {
  if (event.button !== 0) return;
  const { clientX: startX, clientY: startY, pointerId } = event;
  let dragging = false;
  const listening = new AbortController();
  const end = () => {
    listening.abort();
    document.body.classList.remove("dragging-project-item");
  };
  const onMove = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    if (!dragging && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 5) return;
    if (!dragging) document.body.classList.add("dragging-project-item");
    dragging = true;
    if (!handOff(pointer)) return;
    end();
    suppressClick.current = path;
    window.setTimeout(() => {
      if (suppressClick.current === path) suppressClick.current = null;
    }, 400);
  };
  window.addEventListener("pointermove", onMove, { passive: false, signal: listening.signal });
  window.addEventListener("pointerup", end, { signal: listening.signal });
  window.addEventListener("pointercancel", end, { signal: listening.signal });
  window.addEventListener("blur", end, { signal: listening.signal });
}

/**
 * Once a tree drag leaves the Project panel, cancel the tree's own drag (it
 * moves files between folders) and let Trellis drag the file as a panel.
 */
function trellisTakesProjectDrag(trellis: TrellisController, path: string, pointer: PointerEvent) {
  const panel = trellis.panelRect("project");
  if (!panel) return false;
  const inside = pointer.clientX >= panel.left && pointer.clientX <= panel.right
    && pointer.clientY >= panel.top && pointer.clientY <= panel.bottom;
  if (inside) return false;
  window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: pointer.pointerId, pointerType: pointer.pointerType }));
  return trellis.beginFileDrag(path, pointer);
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
  const trellisFlags = useTrellisUi(trellis, (ui) => [ui.present.agent, ui.visible.agent, ui.pdfLive, ui.editorHibernated].map((flag) => (flag ? "1" : "0")).join(""));
  const [agentPresent, agentVisible, pdfLive, editorHibernated] = [...trellisFlags].map((flag) => flag === "1");
  const browserHosted = isBrowserHosted();
  const projectState = useProjectState();
  const {
    project, setProject, projectRef, projectBeforeTransitionRef,
    projectOperationGenerationRef,
    cancelProjectTransition, captureProjectScope, reconcileProjectTree, withTreeMutation,
  } = projectState;
  const library = useProjectLibrary(projectState);
  const {
    claimBibliographyRefresh, applyBibliographyIndex,
    papers, citationKeys, citations, references, setReferences,
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
    mode: canvasMode, assetPaths: projectAssetPaths,
  } = documents;
  const {
    openFile, openAsset, openPaper, flush, save, load: loadFile, accept, reveal, chooseMode, claim, scope,
    hasUnsavedEdits, markDiskVersion, leavePaper, edit: editFile, clear: clearEditor, enter: enterDocuments,
    remove: removeDocuments, move: moveDocuments,
  } = documents;
  const { file: activeFileRef, text: sourceRef, saved: savedSourceRef, asset: activeAssetRef } = documents.live;
  const {
    get: getFileViewState, remember: rememberFileViewState, allow: allowViewState, statesRef: viewStateRef,
  } = documents.viewStates;
  const autoTutorialAttemptedRef = useRef(false);
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
  const [editorPosition, setEditorPosition] = useState<EditorPosition | null>(null);
  // Read by the presence hook, which must not re-subscribe on every keystroke.
  const editorPositionRef = useRef<EditorPosition | null>(null);
  editorPositionRef.current = editorPosition;
  const forwardSyncGenerationRef = useRef(0);
  const outlineSyncGenerationRef = useRef(0);
  const [pdfSyncTarget, setPdfSyncTarget] = useState<PdfSyncTarget | null>(null);
  const [locatingPdf, setLocatingPdf] = useState(false);
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
      setError(null);
      return true;
    } catch (reason) {
      setError(toMessage(reason));
      return false;
    }
  }, [projectRef, setProject]);
  const setViewRestore = useCallback((update: SetStateAction<ViewRestoreRequest | null>) => {
    updateCanvasRequest("restore", update);
  }, [updateCanvasRequest]);
  const [tableGeneratorOpen, setTableGeneratorOpen] = useState(false);
  const projectSearch = useProjectSearch();
  const { openFind: openProjectFind, openReplace: openProjectReplace } = projectSearch;
  const [searchDialog, setSearchDialog] = useState<SearchDialog | null>(null);
  const openCompileDiagnosticRef = useRef<(diagnostic: CompileDiagnostic) => Promise<void>>(async () => undefined);
  const [nativeEditorDropActive, setNativeEditorDropActive] = useState(false);
  const [fileDropTargetActive, setFileDropTargetActive] = useState(false);
  const [agentPanelDropActive, setAgentPanelDropActive] = useState(false);
  const nativeDragPathsRef = useRef<string[]>([]);
  const suppressedFigureClick = useRef<string | null>(null);
  const suppressedProjectFileClick = useRef<string | null>(null);
  const openMarkdownProjectPathRef = useRef<(path: string) => void>(() => undefined);
  const requestEditorLine = useCallback((path: string, line: number) => {
    updateCanvasRequest("navigation", { path, line, id: crypto.randomUUID() });
  }, [updateCanvasRequest]);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [mainBodyPages, setMainBodyPages] = useState<number | null>(null);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [paperFetchStates, setPaperFetchStates] = useState<Record<string, "loading" | "success">>({});
  const paperFetchTimers = useRef<Record<string, number>>({});
  const [assetImporting, setAssetImporting] = useState(false);
  const [assetDropTarget, setAssetDropTarget] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitWorkspaceView, setGitWorkspaceView] =
    useState<AgentGitWorkspaceView>("changes");
  // Pinned turn review: see HistoryDrawersState.
  const [agentTurnReview, setAgentTurnReview] = useState<AgentTurnReview | null>(null);
  const [todosOpen, setTodosOpen] = useState(false);
  const editorCommentAuthorId = useMemo(() => loadEditorCommentAuthorId(), []);
  const [authorNameSetting, setAuthorNameSetting] = useState(loadAuthorNameSetting);
  // The writer's name as Git and the Overleaf session know it, which sign
  // comments ahead of the "Your name" setting.
  const [knownAuthorNames, setKnownAuthorNames] = useState<{ git: string | null; overleaf: string | null }>({
    git: null, overleaf: null,
  });
  const authorName = resolveAuthorName({ ...knownAuthorNames, setting: authorNameSetting });
  const [outlineOpen, setOutlineOpen] = useState(false);
  const projectRootRef = useRef<string | null>(null);
  const agentProjectDocumentCreatorRef = useRef<((
    request: AgentProjectDocumentToolRequest,
  ) => Promise<string>) | null>(null);
  const enterProjectRef = useRef<((
    snapshot: ProjectSnapshot,
    options?: { deferInitialBuild?: boolean },
  ) => Promise<void>) | null>(null);
  projectRootRef.current = project?.root ?? null;
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
  }), [recordSavedPaths]);
  /** Insert `\cite{key}`/`\ref{key}` at the caret, bringing an editor on screen first. */
  const insertCitation = useCallback((key: string, command: InsertSymbolCommand) => {
    updateCanvasRequest("cite", { key, command, id: crypto.randomUUID() });
    reveal("editor");
  }, [reveal, updateCanvasRequest]);
  const [bibliographyAuditRoot, setBibliographyAuditRoot] = useState<string | null>(null);
  const [bibliographyAuditOpen, setBibliographyAuditOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [outlineSources, setOutlineSources] = useState<Record<string, string>>({});
  const [referenceHits, setReferenceHits] = useState<{
    kind: "label" | "citation";
    symbol: string;
    occurrences: SymbolOccurrence[];
  } | null>(null);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [boardCreateRequest, setBoardCreateRequest] = useState(0);
  const [spreadsheetCreateRequest, setSpreadsheetCreateRequest] = useState(0);
  const [presentationCreateRequest, setPresentationCreateRequest] = useState(0);
  const [openSlideContext, setOpenSlideContext] = useState<OpenSlideContext | null>(null);
  const synara = useSynaraHost({
    project,
    projectRef,
    agentVisible,
    bridge: {
      openProviderSettings: () => {
        setSettingsTab("agent");
        setSettingsOpen(true);
      },
      openProjectPath: (path) => openMarkdownProjectPathRef.current(path),
      openReview: (turn) => {
        if (turn) setAgentTurnReview({ ...turn, filePath: null });
        else setGitWorkspaceView("changes");
        setGitOpen(true);
        trellis.revealOpenTool("git");
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
  const {
    origin: synaraOrigin, sourceControlFrameRef: synaraSourceControlFrameRef, postMessage: postSynaraMessage,
    requestRuntime: requestSynaraRuntime,
  } = synara;
  const autoBuildModeRef = useLatest(buildPreferences.autoBuildMode);
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
  const { build, setBuild, building, outcome: buildOutcome, cleaning, pdfUrl, runBuild, abortBuild, cleanProject, cleanAndRebuild, resetForProject } = buildPipeline;
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
  const beginProjectTransition = useCallback((force = false) => {
    // Let sync finish its disk refresh before attempting a switch. Cancelling
    // only its UI phase after a failed switch could leave newly pulled bytes
    // hidden behind an old editor buffer that later overwrites them.
    if (overleafSyncingRef.current && !force) return false;
    projectState.beginTransition();
    claim();
    resetAgentCompileTracking(true);
    cancelPreviewPrewarm();
    return true;
  }, [cancelPreviewPrewarm, claim, projectState, resetAgentCompileTracking]);
  // Forward SyncTeX starts from a .tex caret in the editor, not a preview or an asset.
  const forwardSyncPosition = editorPosition && pdfUrl && editorPosition.path.toLocaleLowerCase().endsWith(".tex")
    && (canvasMode === "split" || canvasMode === "pdf") && !activeAsset && editorPosition.path === activeFile
    ? editorPosition : null;
  const agentContext = useAgentContext({
    synara, project, papers, agentVisible,
    workspace: {
      activeFile, activePaper, activePaperPath: documents.paperPath, canvasMode, paperView, editorPosition,
      pdfPage: pdfPageNumber, pdfPageCount, presentation: openSlideContext,
    },
  });
  const { resetSelection: resetAgentSelection } = agentContext;
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  useEffect(() => {
    if (!synaraOrigin || !gitOpen) return;
    const closeSourceControl = (event: MessageEvent) => {
      if (
        event.source !== synaraSourceControlFrameRef.current?.contentWindow ||
        event.origin !== synaraOrigin ||
        event.data?.type !== "lattice:close-source-control"
      ) {
        return;
      }
      setGitOpen(false);
    };
    window.addEventListener("message", closeSourceControl);
    return () => window.removeEventListener("message", closeSourceControl);
  }, [gitOpen, synaraOrigin, synaraSourceControlFrameRef]);

  const projectGit = useProjectTreeWatch(projectState, true);
  const { setGitStatus } = projectGit;
  const { theme, themePreference, setThemePreference, appearance, setAppearance } = useAppearance();
  const appLocale = resolveAppLocale(appearance.interfaceLanguage);
  useEffect(() => {
    configureInterfaceSounds(appearance.interfaceSounds);
  }, [appearance.interfaceSounds]);
  useWindowMinimumSize(appearance.interfaceScale, trellis.layoutMinWidth);
  /**
   * Claim the right to switch projects, waiting out an Overleaf sync rather
   * than refusing.
   *
   * A sync must finish its disk refresh before a switch — cancelling only its
   * UI phase could leave newly pulled bytes hidden behind an old editor buffer
   * that later overwrites them. But a linked project auto-syncs on open and
   * live mode re-syncs every few seconds, so simply rejecting the click meant
   * "open that project" often did nothing at all and had to be clicked again
   * with no way to tell when. Queueing behind the sync honors the same
   * constraint while making one click enough. The timeout is the escape hatch
   * for a sync that never settles: fall back to the old refusal rather than
   * leaving the window wedged.
   */
  const startProjectTransition = useCallback(async () => {
    if (overleafSyncingRef.current) {
      const settled = overleafSyncSettledRef.current;
      if (settled) {
        setNotice(t`Finishing Overleaf sync, then switching…`, "Overleaf");
        await Promise.race([
          settled,
          new Promise<void>((resolve) => window.setTimeout(resolve, PROJECT_SWITCH_SYNC_WAIT_MS)),
        ]);
      }
    }
    // The editor stayed live while Overleaf settled, so publish and durably
    // save any edit (including a just-finished IME composition) made during
    // that wait before invalidating the outgoing project's ownership.
    if (!flush()) {
      setNotice(t`Finish the current text composition, then switch projects again.`);
      return false;
    }
    if (!(await save())) return false;
    await Promise.race([
      flushWholeFilesBeforeProjectTransitionRef.current(),
      new Promise<void>((resolve) => window.setTimeout(resolve, PROJECT_SWITCH_SYNC_WAIT_MS)),
    ]);
    if (hasUnsavedEdits()) {
      setNotice(t`The document changed while saving. Save it, then switch projects again.`);
      return false;
    }
    if (beginProjectTransition()) return true;
    setNotice(t`Overleaf sync is finishing. Try switching projects again in a moment.`, "Overleaf");
    return false;
  }, [beginProjectTransition, flush, hasUnsavedEdits, save, t]);

  // `name: null` is the untouched default, resolved per render so it follows the interface language.
  const [createFormState, setCreateForm] = useState<Omit<CreateProjectForm, "name"> & { name: string | null }>({
    open: false, error: null, name: null, venue: "neurips",
  });
  const defaultProjectName = t`Untitled research`;
  const createForm = useMemo<CreateProjectForm>(
    () => ({ ...createFormState, name: createFormState.name ?? defaultProjectName }),
    [createFormState, defaultProjectName],
  );
  const updateCreateForm = useCallback((update: Partial<CreateProjectForm>) => {
    setCreateForm((form) => ({ ...form, error: null, ...update }));
  }, []);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(loadRecentProjects);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const isFullscreen = useFullscreen();
  const shellRef = useRef<HTMLDivElement | null>(null);

  const rememberProject = useCallback((snapshot: ProjectSnapshot) => {
    setRecentProjects(rememberRecentProject({ name: snapshot.manifest.name, path: snapshot.root }));
  }, []);

  const projectHistory = useMemo(() => [...history, ...agentCheckpoints.historyItems].sort((left, right) => (
    right.timestamp.localeCompare(left.timestamp)
  )), [agentCheckpoints.historyItems, history]);

  useEffect(() => {
    if (!browserHosted) return;
    const saveBrowserPage = (event?: BeforeUnloadEvent) => {
      flush();
      if (!hasUnsavedEdits()) return;
      // Sending the invoke begins synchronously before the tab is discarded.
      // The confirmation keeps a just-typed buffer alive long enough for the
      // loopback write to finish instead of losing the last autosave interval.
      void save();
      if (event) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const pageHide = () => saveBrowserPage();
    window.addEventListener("beforeunload", saveBrowserPage);
    window.addEventListener("pagehide", pageHide);
    return () => {
      window.removeEventListener("beforeunload", saveBrowserPage);
      window.removeEventListener("pagehide", pageHide);
    };
  }, [browserHosted, flush, hasUnsavedEdits, save]);

  // Before another surface takes this workspace (the default browser, or the
  // Lattice window coming back), publish and save every edit. The bridge asks
  // for this too when a bookmarked tab takes over unannounced.
  const saveForHandoff = useCallback(async () => {
    flush();
    const saved = await save();
    await Promise.race([
      flushWholeFilesBeforeProjectTransitionRef.current(),
      new Promise<void>((resolve) => window.setTimeout(resolve, PROJECT_SWITCH_SYNC_WAIT_MS)),
    ]);
    return saved;
  }, [flush, save]);
  useEffect(() => {
    if (!browserHosted) return;
    setWorkspaceYieldHandler(saveForHandoff);
    return () => setWorkspaceYieldHandler(null);
  }, [browserHosted, saveForHandoff]);

  /** A tab in the default browser, as opposed to a Lattice window. */
  const inBrowserTab = browserHosted && !isBundledChromium();
  /** "Open in browser" from a Lattice window, "Open in Lattice app" from a browser tab. */
  const moveWorkspace = useCallback(async () => {
    if (inBrowserTab) {
      if (!await saveForHandoff()) return;
      await invoke("return_to_desktop").catch((reason) => {
        // Once the window has taken over, this page is detached and the
        // reply never arrives: that is the success case.
        if (!browserRuntimeDetached()) setError(toMessage(reason));
      });
      return;
    }
    if (browserHosted) {
      // The Chromium window: the new tab asks it to yield, then it hides
      // until the tab gives the workspace back or closes.
      if (!await saveForHandoff()) return;
      await invoke("open_in_browser").catch((reason) => setError(toMessage(reason)));
      return;
    }
    // A native WebKit window closes, and the tab starts relaying only once it
    // has, so the two never edit together. Claim the switch meanwhile.
    if (!await startProjectTransition()) return;
    try {
      await invoke("open_in_browser");
    } catch (reason) {
      cancelProjectTransition();
      setError(toMessage(reason));
      return;
    }
    await getCurrentWindow().close();
  }, [browserHosted, cancelProjectTransition, inBrowserTab, saveForHandoff, startProjectTransition]);
  const openProjectFileFromClick = useCallback((path: string, line?: number) => {
    if (suppressedProjectFileClick.current === path) {
      suppressedProjectFileClick.current = null;
      return;
    }
    void openFile(path, { line });
  }, [openFile]);

  const revealPdfSource = useCallback(async (page: number, x: number, y: number) => {
    await showingErrors(async () => {
      const target = await invoke<SyncTexTarget>("synctex_edit", { page, x, y });
      // A citation resolves into the bibliography, a macro into a .sty. Those
      // files own the whole editor area when opened deliberately, but a jump
      // out of the PDF must keep the preview it was made from on screen.
      await openFile(target.path, { line: target.line, revealSource: false });
      reveal("editor");
    });
  }, [openFile, reveal]);

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
  compileRef.current = compile;
  /** An explicit build (button, palette) also brings a closed or hidden PDF panel back under Trellis. */
  const compileAndShowPdf = useCallback<typeof compile>((...args) => {
    trellis.showPanel("pdf", { focus: false });
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
    source, sourceRef, savedSourceRef, accept, setViewRestore, viewStateRef, editorPosition,
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
      setWarning(t`Open Slide and another editor changed the same lines in ${path}; Lattice kept both with conflict markers.`);
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
    project, projectRootRef, overleaf,
    author: { id: editorCommentAuthorId, name: authorName },
    openSources,
    agentOptionsRef: agentCommentsOptionsRef,
  });
  const { reset: resetEditorComments, load: loadEditorComments } = editorComments;
  // Under Trellis an open drawer is a panel: asking for it again brings that
  // panel forward (un-hidden, its tab selected, zoomed to) instead of doing nothing.
  const revealOpenTool = (kind: TrellisToolKind) => trellis.revealOpenTool(kind);
  const commentsToolKind: TrellisToolKind = overleafLink ? "overleaf" : "comments";
  const openEditorComments = () => {
    editorComments.openPanel();
    revealOpenTool(commentsToolKind);
  };

  const revealSourceInPdf = useCallback(async () => {
    if (!forwardSyncPosition || locatingPdf) return;
    const position = forwardSyncPosition;
    const requestGeneration = forwardSyncGenerationRef.current + 1;
    forwardSyncGenerationRef.current = requestGeneration;
    const ownsDocuments = scope();
    const isCurrentRequest = () => (
      forwardSyncGenerationRef.current === requestGeneration
      && ownsDocuments()
      && editorPositionRef.current?.path === position.path
      && editorPositionRef.current?.line === position.line
      && editorPositionRef.current?.column === position.column
    );
    /** A jump SyncTeX cannot make is a warning, replacing any error or notice. */
    const warnOnly = (message: string) => {
      setError(null);
      setNotice(null);
      setWarning(message);
    };
    setWarning(null);
    setLocatingPdf(true);
    try {
      if (!(await save())) return;
      if (!isCurrentRequest()) return;
      if (source !== savedSource || !pdfUrl) await runBuild();
      if (!isCurrentRequest()) return;
      const target = await invoke<PdfSyncResponse | null>("synctex_view", {
        path: position.path,
        line: position.line,
        column: position.column,
      });
      if (!isCurrentRequest()) return;
      if (!target) {
        warnOnly(t`This source line has no matching position in the PDF.`);
        return;
      }
      setWarning(null);
      setPdfSyncTarget({ ...target, id: crypto.randomUUID() });
      reveal("pdf");
      setError(null);
    } catch (reason) {
      if (!isCurrentRequest()) return;
      const message = toMessage(reason);
      if (message === "This bibliography entry is not included in the compiled PDF.") {
        warnOnly(message);
      } else {
        setWarning(null);
        setError(message);
      }
    } finally {
      if (forwardSyncGenerationRef.current === requestGeneration) setLocatingPdf(false);
    }
  }, [
    forwardSyncPosition, locatingPdf, pdfUrl, reveal, runBuild, save, savedSource, scope, source, t,
  ]);

  const navigateOutline = useCallback(async (path: string, line: number) => {
    const requestGeneration = outlineSyncGenerationRef.current + 1;
    outlineSyncGenerationRef.current = requestGeneration;
    const ownsProject = captureProjectScope();
    const isCurrentRequest = (checkPosition = true) => (
      outlineSyncGenerationRef.current === requestGeneration
      && ownsProject()
      && activeFileRef.current === path
      && (!checkPosition || (
        editorPositionRef.current?.path === path
        && editorPositionRef.current?.line === line
      ))
    );
    setOutlineOpen(false);
    await openFile(path, { line });
    if (!isCurrentRequest(false)) return;
    try {
      const target = await invoke<PdfSyncResponse | null>("synctex_view", { path, line, column: 0 });
      if (!isCurrentRequest()) return;
      if (target) setPdfSyncTarget({ ...target, id: crypto.randomUUID() });
      reveal("pdf");
      setError(null);
    } catch {
      // The source jump is still useful when this PDF has no SyncTeX map.
    }
  }, [activeFileRef, openFile, captureProjectScope, reveal]);

  const openCompileDiagnostic = useCallback(async (diagnostic: CompileDiagnostic) => {
    if (!project) return;
    const path = resolveDiagnosticPath(
      diagnostic.file,
      flattenProjectPaths(project.files),
      activeFile,
    );
    if (!path) {
      setError(diagnostic.message);
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

  const enterProject = useCallback(
    async (
      snapshot: ProjectSnapshot,
      options?: { deferInitialBuild?: boolean },
    ) => {
      void loadDocumentCanvas();
      beginProjectTransition(true);
      // The backend already owns the incoming root. The outgoing documents go
      // before that root is exposed to effects (see enter).
      const entry = enterDocuments(snapshot);
      projectRef.current = snapshot;
      projectBeforeTransitionRef.current = null;
      setProject(snapshot);
      const ownsProject = captureProjectScope();
      rememberProject(snapshot);
      setProjectMenuOpen(false);
      resetAgentSelection();
      resetEditorComments();
      // A pinned turn review belongs to the outgoing project's thread; keeping
      // it would bind the drawer to a foreign thread after the switch.
      setAgentTurnReview(null);
      setDiskTodos([]);
      setTodosOpen(false);
      resetForProject(snapshot.root);
      // The startup reopen defers this build and starts its own once the
      // project is fully entered (see the recent-project auto-reopen below).
      if (!options?.deferInitialBuild) {
        void runBuild(false, { immediatePreview: true });
      }
      const isLatestBibliography = claimBibliographyRefresh();
      const bibliographyIndex = await loadBibliographyIndex();
      const [nextPapers, , , nextReferences] = bibliographyIndex;
      if (!ownsProject()) return;
      // Opening a file cancels workspace restoration, not the project's paper
      // scan. Apply metadata before the restore's own guards, but do not
      // overwrite a newer bibliography refresh triggered by a save.
      if (isLatestBibliography()) applyBibliographyIndex(bibliographyIndex);
      else setReferences(nextReferences ?? []);
      if (!(await entry.restore(nextPapers))) return;
      await refreshUnusedSymbols();
      await loadHistory();
      await loadEditorComments();
      await loadTodos();
      await loadWordCount();
      setPdfPageCount(null);
      setChecklistOpen(false);
      entry.finish();
      // Never animate shell opacity from 0 — a cancelled/interrupted tween leaves the
      // whole window blank white with the UI still "mounted".
      if (shellRef.current) shellRef.current.style.opacity = "1";
    },
    [
      applyBibliographyIndex, beginProjectTransition, captureProjectScope, claimBibliographyRefresh, enterDocuments,
      loadEditorComments, loadHistory, loadTodos, loadWordCount, projectBeforeTransitionRef, projectRef,
      refreshUnusedSymbols, rememberProject, resetAgentSelection, resetEditorComments, resetForProject, runBuild,
      setDiskTodos, setProject, setReferences,
    ],
  );
  enterProjectRef.current = enterProject;

  // On launch, honor a project explicitly assigned to this window, otherwise
  // reopen the project the writer used last. A genuinely empty first launch
  // enters the tutorial directly; the welcome screen remains the fallback for
  // returning writers whose last folder was moved or deleted.
  //
  // Resolved by the boot effect below with whether the backend designated an
  // initial project. The auto-reopen must wait for that answer: both flows
  // funnel through enterProject, and whichever claims a project generation
  // last wins — since startProjectTransition became async, the recent-project
  // reopen could land after the backend's choice and silently clobber it.
  const [initialProjectProbe] = useState(() => {
    let resolve!: (result: "project" | "empty" | "failed") => void;
    const promise = new Promise<"project" | "empty" | "failed">((r) => { resolve = r; });
    return { promise, resolve };
  });
  const didRouteStartupRef = useRef(false);

  /// Hand a project to a window of its own, or raise the window already
  /// showing it. Returns the failure message so a caller that keeps a list of
  /// projects can decide whether the project is worth forgetting.
  const openProjectWindow = useCallback(async (path: string): Promise<string | null> => {
    setBusyLabel(t`Opening window…`);
    try {
      await invoke("open_project_window", { path });
      return null;
    } catch (reason) {
      const message = toMessage(reason);
      setError(message);
      return message;
    } finally {
      setBusyLabel(null);
    }
  }, [t]);

  /// Show a project that was just created, imported or cloned. A window in use
  /// keeps what it has and the project gets one of its own; an empty window
  /// takes it in place, claiming the switch first. The backend deliberately
  /// does not bind these on creation, so this is the only thing that decides
  /// where they land. `create` resolves the new project's root.
  const revealNewProject = useCallback(async (
    busyLabel: string,
    create: () => Promise<string>,
    onError = (reason: unknown) => setError(toMessage(reason)),
  ) => {
    setBusyLabel(busyLabel);
    const openHere = !project?.root;
    try {
      if (openHere && !await startProjectTransition()) return;
      const root = await create();
      if (openHere) await enterProject(await invoke<ProjectSnapshot>("open_project", { path: root }));
      else await openProjectWindow(root);
      return true;
    } catch (reason) {
      if (openHere) cancelProjectTransition();
      onError(reason);
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, enterProject, openProjectWindow, project?.root, startProjectTransition]);

  /// Replace this window's project with the one at `path`: save, claim the
  /// switch, enter; roll the claim back on failure.
  const switchProject = useCallback(async (busyLabel: string, path: string, onError?: () => void) => {
    setBusyLabel(busyLabel);
    try {
      if (!(await save()) || !await startProjectTransition()) return;
      await enterProject(await invoke<ProjectSnapshot>("open_project", { path }));
    } catch (reason) {
      cancelProjectTransition();
      onError?.();
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, enterProject, save, startProjectTransition]);


  const chooseExisting = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: t`Open a LaTeX project` });
    if (!selected) return;
    // Same rule as the recent-projects list: a window in use keeps the project
    // it has, and the chosen one gets a window of its own.
    if (project?.root) await openProjectWindow(String(selected));
    else await switchProject(t`Opening project…`, String(selected));
  }, [openProjectWindow, project?.root, switchProject, t]);

  const createProject = useCallback(async () => {
    if (!createForm.name.trim()) {
      updateCreateForm({ error: t`Enter a project name.` });
      return;
    }
    const parent = await open({ directory: true, multiple: false, title: t`Choose where to create the project` });
    if (!parent) return;
    await revealNewProject(t`Creating project…`, async () => {
      const snapshot = await invoke<ProjectSnapshot>("create_project", {
        parent, name: createForm.name, venue: createForm.venue,
      });
      updateCreateForm({ open: false });
      return snapshot.root;
    }, (reason) => updateCreateForm({ error: toMessage(reason) }));
  }, [createForm.name, createForm.venue, revealNewProject, updateCreateForm, t]);

  const openTutorialProject = useCallback(async () => {
    autoTutorialAttemptedRef.current = true;
    setBusyLabel(t`Preparing tutorial…`);
    try {
      if (!(await save()) || !await startProjectTransition()) {
        autoTutorialAttemptedRef.current = false;
        return false;
      }
      const snapshot = await invoke<ProjectSnapshot>("open_tutorial_project");
      await enterProject(snapshot);
      chooseMode("source");
      markTutorialSeen();
      return true;
    } catch (reason) {
      autoTutorialAttemptedRef.current = false;
      cancelProjectTransition();
      setError(toMessage(reason));
      return false;
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, chooseMode, enterProject, save, startProjectTransition, t]);
  useEffect(() => {
    if (didRouteStartupRef.current) return;
    didRouteStartupRef.current = true;
    void (async () => {
      const initialProject = await initialProjectProbe.promise;
      if (initialProject !== "empty") return;
      const mostRecent = loadRecentProjects()[0]?.path;
      if (!mostRecent) {
        if (!hasSeenTutorial() && !autoTutorialAttemptedRef.current) {
          void openTutorialProject();
        }
        return;
      }
      try {
        if (!await startProjectTransition()) return;
        const snapshot = await invoke<ProjectSnapshot>("open_project", { path: mostRecent });
        // Defer enterProject's own initial build (it races cold-start init and
        // the PDF never appears), then kick one explicitly once the project is
        // fully entered.
        await enterProject(snapshot, { deferInitialBuild: true });
        void runBuild(false, { immediatePreview: true });
      } catch {
        cancelProjectTransition();
        // Folder gone — stay on the welcome screen.
      }
    })();
  }, [
    cancelProjectTransition, enterProject, initialProjectProbe, openTutorialProject, runBuild,
    startProjectTransition,
  ]);

  const importOverleafZip = useCallback(async () => {
    const zipPath = await open({
      multiple: false,
      title: t`Import Overleaf ZIP`,
      filters: [{ name: t`ZIP archive`, extensions: ["zip"] }],
    });
    if (!zipPath) return;
    const parent = await open({
      directory: true,
      multiple: false,
      title: t`Choose where to extract the project`,
    });
    if (!parent) return;
    await revealNewProject(t`Importing ZIP…`, async () => (
      (await invoke<ProjectSnapshot>("import_project_zip", { zipPath, parent })).root
    ));
  }, [revealNewProject, t]);

  const exportProjectZip = useCallback(async () => {
    if (!project) return;
    const zipPath = await saveDialog({
      title: t`Export project ZIP`,
      defaultPath: `${project.manifest.name.replace(/[\\/:*?"<>|]+/g, "-") || t`project`}.zip`,
      filters: [{ name: t`ZIP archive`, extensions: ["zip"] }],
    });
    if (!zipPath) return;
    setBusyLabel(t`Exporting ZIP…`);
    try {
      if (!(await save())) return;
      await invoke("export_project_zip", { zipPath });
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [project, save, t]);

  const chooseRecentProject = useCallback(async (path: string) => {
    if (path === project?.root) {
      setProjectMenuOpen(false);
      return;
    }
    // Another project gets its own window once this one is in use. Replacing
    // the project in place would close editors, cancel a build and reset the
    // agent for work the writer never asked to put away. With nothing open yet
    // the window is empty, so it takes the project itself rather than leaving
    // a blank window behind.
    if (project?.root) {
      setProjectMenuOpen(false);
      const failure = await openProjectWindow(path);
      // Only the project itself failing means the entry is worth dropping; a
      // window that could not be created says nothing about the project.
      if (failure && !failure.startsWith(NEW_WINDOW_FAILURE_PREFIX)) {
        setRecentProjects(forgetRecentProject(path));
      }
      return;
    }
    await switchProject(t`Switching project…`, path, () => setRecentProjects(forgetRecentProject(path)));
  }, [openProjectWindow, project?.root, switchProject, t]);

  useEffect(() => {
    let active = true;
    // Boot once. Depending on `enterProject` re-ran this whenever that callback
    // identity churned (after every build/load), which cleared the PDF and
    // restarted compile → endless “Rendering PDF…”.
    void invoke<ProjectSnapshot | null>("initial_project")
      .then(async (snapshot) => {
        initialProjectProbe.resolve(snapshot ? "project" : "empty");
        if (!active || !snapshot) return;
        await enterProjectRef.current?.(snapshot);
      })
      .catch((reason) => {
        initialProjectProbe.resolve("failed");
        if (active) setError(toMessage(reason));
      });
    return () => {
      active = false;
    };
    // initialProjectProbe is a stable useState value — listed to satisfy the
    // lint without changing the boot-once behavior.
  }, [initialProjectProbe]);

  useEffect(() => {
    try {
      localStorage.setItem(BUILD_PREFERENCES_KEY, JSON.stringify(buildPreferences));
    } catch {
      // Build preferences still apply for the current session without storage.
    }
  }, [buildPreferences]);

  useTrafficLightAlignment(shellRef, !browserHosted && !isFullscreen, appearance.interfaceScale, project?.manifest.name);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save().then((saved) => {
          if (!saved) return;
          void flushDeferredWholeFileSync();
          if (activePaper) return;
          // An explicit build brings a closed or hidden PDF panel back (Trellis layout).
          trellis.showPanel("pdf", { focus: false });
          void compile();
        });
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void chooseExisting();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activePaper, chooseExisting, compile, flushDeferredWholeFileSync, save, trellis]);

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
  });
  const { setLiteratureOpen: setLiteratureDrawerOpen } = referenceImport;
  const openLiterature = useCallback((open: SetStateAction<boolean>) => {
    setLiteratureDrawerOpen(open);
    if (open === true) trellis.revealOpenTool("literature");
  }, [setLiteratureDrawerOpen, trellis]);
  const { clearStage: clearImportStage } = referenceImport;

  const fetchAndOpenPaper = useCallback(async (paper: PaperSummary) => {
    if (!canDownloadPaper(paper)) {
      if (paper.url) {
        try { await openUrl(paper.url); } catch (reason) { setError(toMessage(reason)); }
      }
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
    try {
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
    } catch (reason) {
      clearFetchState();
      if (opening.isCurrent()) setError(toMessage(reason));
    } finally {
      clearImportStage();
    }
  }, [claim, clearImportStage, openPaper, refreshProject]);

  const readDraggedPaper = (paper: PaperSummary) => {
    if (paper.hasFullText || paper.hasBlog) void openPaper(paper);
    else if (paper.arxivId || paper.url) void fetchAndOpenPaper(paper);
    else setError(t`This paper has no local reading or downloadable source.`);
  };

  useEffect(() => () => {
    Object.values(paperFetchTimers.current).forEach((timer) => window.clearTimeout(timer));
  }, []);

  const referenceImages = useReferenceImages(project?.root, references);

  const openProjectAssetFromClick = useCallback((path: string) => {
    if (suppressedFigureClick.current === path) {
      suppressedFigureClick.current = null;
      return;
    }
    void openAsset(path);
  }, [openAsset]);

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

  // A file dragged out of the Project panel becomes a panel wherever it is
  // dropped: once the pointer leaves the panel, Trellis's own drag takes over.
  const beginProjectFigureDrag = useCallback((path: string, _label: string, event: React.PointerEvent) => {
    trackProjectItemDrag(path, event, suppressedFigureClick, (pointer) => trellisTakesProjectDrag(trellis, path, pointer));
  }, [trellis]);
  const beginProjectFileDrag = useCallback((path: string, _label: string, event: React.PointerEvent) => {
    trackProjectItemDrag(path, event, suppressedProjectFileClick, (pointer) => trellisTakesProjectDrag(trellis, path, pointer));
  }, [trellis]);

  const createProjectEntry = useCallback(async (
    path: string,
    kind: "file" | "folder" | "presentation",
  ) => {
    try {
      const createdPath = kind === "presentation"
        ? await invoke<string>("create_open_slide_deck", { deckId: path, projectRoot: project?.root })
        : await invoke<string>("create_project_entry", { path, kind, projectRoot: project?.root });
      allowViewState(createdPath);
      await refreshProject();
      await refreshHistory();
      if (kind !== "folder") {
        // A local-only file has no Overleaf document id and therefore cannot
        // join realtime editing. Upload it before opening the editor so the
        // first keystroke does not have to wait for a later full-sync timer.
        if (overleafLink && overleafSyncMode === "live") {
          await overleafSyncRef.current({ auto: true });
        }
        await openFile(createdPath);
      }
      return createdPath;
    } catch (reason) {
      setError(toMessage(reason));
      throw reason;
    }
  }, [
    allowViewState, openFile, overleafLink, overleafSyncMode, overleafSyncRef, project?.root, refreshHistory,
    refreshProject,
  ]);
  useLayoutEffect(() => {
    const createAgentProjectDocument = async (request: AgentProjectDocumentToolRequest) => {
      if (!project?.root) {
        // eslint-disable-next-line lingui/no-unlocalized-strings -- tool error returned to the agent
        throw Object.assign(new Error("Open a Lattice project before creating a document."), {
          code: "project_document_project_unavailable",
        });
      }
      const createdPath = await createProjectEntry(request.args.path, "file");
      const remainingMs = request.expiresAt - Date.now();
      const documentReady = request.args.documentType === "board" ? waitForAgentCanvasAdapter : waitForAgentSpreadsheetDocument;
      await documentReady(createdPath, remainingMs);
      return createdPath;
    };
    agentProjectDocumentCreatorRef.current = createAgentProjectDocument;
    return () => {
      if (agentProjectDocumentCreatorRef.current === createAgentProjectDocument) {
        agentProjectDocumentCreatorRef.current = null;
      }
    };
  }, [createProjectEntry, project?.root]);

  const importProjectAssets = useCallback(async (paths: string[], targetDirectory = "figures"): Promise<string[]> => {
    if (!paths.length || assetImporting) return [];
    setAssetImporting(true);
    const trace = logAction(t`Figures`, t`Import figures`, paths.join(", "));
    try {
      const imported = await invoke<string[]>("import_project_assets", {
        paths,
        targetDirectory,
        projectRoot: project?.root,
      });
      for (const importedPath of imported) allowViewState(importedPath);
      await refreshProject();
      const count = imported.length;
      trace.ok(targetDirectory
        ? count === 1 ? t`Imported ${count} figure into ${targetDirectory}.` : t`Imported ${count} figures into ${targetDirectory}.`
        : count === 1 ? t`Imported ${count} figure into the project root.` : t`Imported ${count} figures into the project root.`);
      return imported;
    } catch (reason) {
      trace.fail(reason);
      return [];
    } finally {
      setAssetImporting(false);
      setAssetDropTarget(null);
    }
  }, [allowViewState, assetImporting, project?.root, refreshProject, t]);

  /**
   * Run an import into the project tree and settle what it added: re-admit
   * the paths to view-state memory, then refresh the tree and history.
   */
  const importIntoProject = useCallback(async (run: () => Promise<string[]>): Promise<string[]> => {
    if (assetImporting) return [];
    setAssetImporting(true);
    try {
      const imported = await run();
      for (const path of imported) allowViewState(path);
      await reconcileProjectTree();
      await refreshHistory();
      setError(null);
      return imported;
    } catch (reason) {
      setError(toMessage(reason));
      return [];
    } finally {
      setAssetImporting(false);
      setAssetDropTarget(null);
    }
  }, [allowViewState, assetImporting, reconcileProjectTree, refreshHistory]);

  const importProjectSources = useCallback(async (paths: string[], targetDirectory = "") => (
    paths.length ? importIntoProject(() => (
      invoke<string[]>("import_project_sources", { paths, targetDirectory, projectRoot: project?.root })
    )) : []
  ), [importIntoProject, project?.root]);

  /**
   * Finder-style tree drops: any mix of files and folders, routed by the
   * backend on content (UTF-8 text through the transaction log, the rest
   * copied).
   */
  const importProjectFiles = useCallback(async (
    paths: string[],
    targetDirectory = "",
    copyExisting = false,
  ) => (paths.length ? importIntoProject(async () => {
    const imported = await invoke<{ path: string }[]>("import_project_files", {
      paths, targetDirectory, projectRoot: project?.root,
      ...(copyExisting ? { copyExisting: true } : {}),
    });
    return imported.map((file) => file.path);
  }) : []), [importIntoProject, project?.root]);

  const chooseProjectAssets = useCallback(async (targetDirectory = "figures") => {
    const selected = await open({
      multiple: true,
      title: t`Import figures into ${targetDirectory}`,
      filters: [{ name: t`Figures`, extensions: ["png", "jpg", "jpeg", "pdf", "svg", "eps", "webp"] }],
    });
    if (!selected) return;
    await importProjectAssets(Array.isArray(selected) ? selected : [selected], targetDirectory);
  }, [importProjectAssets, t]);

  useEffect(() => {
    if (!project) return;
    let active = true;
    const clearDropHighlights = () => {
      nativeDragPathsRef.current = [];
      setAssetDropTarget(null);
      setNativeEditorDropActive(false);
      setFileDropTargetActive(false);
      setAgentPanelDropActive(false);
    };
    const dispose = disposeWhenSettled(import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (!active) return;
        if (event.payload.type === "leave") {
          clearDropHighlights();
          return;
        }
        if (event.payload.type === "enter") nativeDragPathsRef.current = event.payload.paths;
        const dragPaths = event.payload.type === "over" ? nativeDragPathsRef.current : event.payload.paths;
        const editorPosition = dropEditorAt(event.payload.position);
        const canvasTarget = dropCanvasAt(event.payload.position);
        const targetDirectory = dropDirectoryAt(event.payload.position);
        const agentPanelTarget = dropAgentPanelAt(event.payload.position);
        const dropKind = classifyExternalProjectDrop(dragPaths);
        const editorPath = activeFileRef.current;
        const insertsIntoEditor = Boolean(editorPosition && dropKind === "asset" && /\.(?:tex|md)$/i.test(editorPath ?? ""));
        // The tree accepts every drop kind, so the highlight only tracks
        // geometry (null when the pointer is not over the Project tree).
        setAssetDropTarget(targetDirectory);
        setNativeEditorDropActive(insertsIntoEditor);
        setAgentPanelDropActive(agentPanelTarget && dropKind !== "unsupported");
        // Sources open in the editor under the pointer; figures do too unless they insert into its text.
        const opensInEditor = dropKind === "source" || (dropKind === "asset" && !insertsIntoEditor);
        setFileDropTargetActive(Boolean(editorPosition && opensInEditor));
        if (event.payload.type === "drop") {
          clearDropHighlights();
          if (!event.payload.paths.length) return;
          if (agentPanelTarget && dropKind !== "unsupported") {
            // The agent iframe never sees native drops (Tauri intercepts
            // them), so read the bytes here and relay them over the embed
            // bridge into the composer, same as its "+" attachment menu.
            // Checked ahead of the source/mixed branches: any file the agent
            // can read (figures and text sources alike) becomes an attachment.
            void invoke<AgentComposerFilePayload[]>("read_agent_composer_files", { paths: event.payload.paths })
              .then((files) => postSynaraMessage(buildAgentComposerFilesMessage(files)))
              .catch((error) => setError(toMessage(error)));
          } else if (dropKind === "source" && (editorPosition || canvasTarget)) {
            void importProjectSources(event.payload.paths).then(async (paths) => {
              for (const path of paths) await openFile(path);
            });
          } else if (targetDirectory !== null) {
            // The Project tree takes any mix, Finder-style, into the folder
            // under the pointer ("" is the project root). Imported files land
            // without opening; editor/canvas drops import and open instead.
            void importProjectFiles(event.payload.paths, targetDirectory);
          } else if (dropKind === "source") {
            setError(t`Drop source files onto an editor or the Project pane`);
          } else if (dropKind === "mixed") {
            setError(t`Drop source files and figures separately`);
          } else if (dropKind === "unsupported") {
            setError(t`This file type can’t be opened in an editor`);
          } else if (editorPosition && insertsIntoEditor) {
            void importProjectAssets(event.payload.paths, "figures").then((paths) => {
              if (!paths.length) return;
              updateCanvasRequest("figure", {
                id: crypto.randomUUID(), paths, clientX: editorPosition.x, clientY: editorPosition.y,
              });
            });
          } else if (canvasTarget) {
            void importProjectAssets(event.payload.paths, "figures").then(async (paths) => {
              for (const path of paths) await openAsset(path);
            });
          } else {
            setError(t`Drop figures onto a TeX or Markdown editor, or the Project pane`);
          }
        }
      }))
      // Browser-based tests and previews do not expose native file paths.
      .catch(() => () => undefined));
    return () => {
      active = false;
      dispose();
    };
  }, [
    activeFileRef, importProjectAssets, importProjectFiles, importProjectSources, openAsset, openFile,
    postSynaraMessage, project, updateCanvasRequest, t,
  ]);

  const prepareLatexFigure = useCallback(async (path: string): Promise<string | null> => {
    try {
      const prepared = await invoke<string>("prepare_latex_figure", { path, projectRoot: project?.root });
      if (prepared !== path) await refreshProject();
      setError(null);
      return prepared;
    } catch (reason) {
      setError(toMessage(reason));
      return null;
    }
  }, [project?.root, refreshProject]);

  const handleEditorPosition = useCallback((position: EditorPosition) => {
    editorPositionRef.current = position;
    setEditorPosition((current) => (
      current?.path === position.path && current.line === position.line && current.column === position.column ? current : position
    ));
  }, []);

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

  const deleteProjectEntries = useCallback(async (requestedPaths: string[]) => {
    const paths = [...new Set(requestedPaths.map((path) => path.replace(/[\\/]+$/, "")))]
      .filter((path, _index, candidates) => !candidates.some(
        (candidate) => candidate !== path && path.startsWith(`${candidate}/`),
      ));
    if (!paths.length) return;
    const path = paths[0];
    const confirmation = paths.length === 1
      ? t({ message: `Delete “${{ path }}” from this project?` })
      : t({ message: `Delete ${{ count: paths.length }} selected items from this project?` });
    if (!await confirmAction({
      title: confirmation,
      message: t`This action cannot be undone.`,
      confirmLabel: t`Delete`,
      destructive: true,
    })) return;
    try {
      for (const path of paths) await invoke("delete_project_entry", { path, projectRoot: project?.root });
      // A successful disk deletion authoritatively retires every UI reference
      // to that path, including files removed through a deleted directory.
      await removeDocuments(paths);
      if (overleafLink && project) {
        // Structural deletes do not pass through `save()`, so handle the
        // remote side now instead of waiting for an unrelated later sync.
        await settleRemoteDeletes(
          paths,
          project.root,
          projectOperationGenerationRef.current,
        );
      }
      await refreshHistory();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [overleafLink, project, projectOperationGenerationRef, refreshHistory, removeDocuments, settleRemoteDeletes, t]);

  const applyProjectEntryPathChanges = useCallback((changes: readonly ProjectPathChange[]) => {
    if (changes.length === 0) return;
    const remapPath = (path: string) => remapProjectPath(path, changes);

    moveDocuments(changes);
    setProject((current) => current ? applyProjectPathChanges(current, changes) : current);
    setGitStatus((current) => ({
      ...current,
      files: current.files.map((file) => ({ ...file, path: remapPath(file.path) })),
    }));
    setOutlineSources((current) => Object.fromEntries(
      Object.entries(current).map(([path, content]) => [remapPath(path), content]),
    ));
    // TexLab resynchronizes the renamed active file rather than retaining
    // diagnostics for its old URI. Build diagnostics still need remapping.
    setBuild((current) => current ? {
      ...current,
      diagnostics: current.diagnostics.map((diagnostic) => diagnostic.file
        ? { ...diagnostic, file: remapPath(diagnostic.file) }
        : diagnostic),
    } : current);
  }, [moveDocuments, setBuild, setGitStatus, setProject]);

  const renameProjectEntry = useCallback((path: string, name: string) => withTreeMutation(async () => {
    try {
      const renamedPath = await invoke<string>("rename_project_entry", { path, newName: name, projectRoot: project?.root });
      const changes = [{ previousPath: path, nextPath: renamedPath }];
      applyProjectEntryPathChanges(changes);
      void markDiskVersion();
      setError(null);
      return renamedPath;
    } catch (reason) {
      setError(toMessage(reason));
      await reconcileProjectTree().catch(() => undefined);
      throw reason;
    }
  }), [applyProjectEntryPathChanges, markDiskVersion, project?.root, reconcileProjectTree, withTreeMutation]);

  const moveProjectEntries = useCallback(async (
    paths: string[],
    targetDirectory: string,
  ): Promise<string[]> => {
    const normalizedTarget = targetDirectory.trim().replace(/[\\/]+$/, "");
    const plannedChanges = paths.map((path): ProjectPathChange => ({
      previousPath: path,
      nextPath: normalizedTarget
        ? `${normalizedTarget}/${path.split("/").at(-1) ?? path}`
        : (path.split("/").at(-1) ?? path),
    }));
    const completedChanges: ProjectPathChange[] = [];
    const originalPrimaryPath = activeFileRef.current;
    let optimisticChangesApplied = false;
    return withTreeMutation(async () => {
      try {
        if (plannedChanges.some((change) => (
          /\.(?:tex|md)$/i.test(change.previousPath) && change.previousPath === originalPrimaryPath
        ))) {
          if (!flush()) {
            setError(t`Try again`);
            return [];
          }
          if (!(await save())) {
            // save() already reports the path and underlying write failure.
            return [];
          }
        }
        applyProjectEntryPathChanges(plannedChanges);
        optimisticChangesApplied = true;
        for (const planned of plannedChanges) {
          const movedPath = await invoke<string>("move_project_entry", {
            path: planned.previousPath,
            targetDirectory: normalizedTarget,
            projectRoot: project?.root,
          });
          const completed = { previousPath: planned.previousPath, nextPath: movedPath };
          completedChanges.push(completed);
          if (planned.nextPath !== movedPath) {
            applyProjectEntryPathChanges([{
              previousPath: planned.nextPath,
              nextPath: movedPath,
            }]);
          }
          if (/\.(?:tex|md)$/i.test(planned.previousPath)) {
            const content = planned.previousPath === originalPrimaryPath ? sourceRef.current
              : await invoke<string>("read_project_file", { path: movedPath, projectRoot: project?.root });
            const rewritten = rewriteMovedDocumentAssetPaths(
              content,
              planned.previousPath,
              movedPath,
              projectAssetPaths,
            );
            if (rewritten !== content) {
              // The open buffer takes the rewrite at once, so typing during
              // the write builds on it; it is clean again once the write lands.
              if (planned.previousPath === originalPrimaryPath) editFile(rewritten);
              await invoke("write_project_file", { path: movedPath, content: rewritten, projectRoot: project?.root });
              if (planned.previousPath === originalPrimaryPath) accept(movedPath, rewritten, { text: rewritten });
            }
          }
        }
        void markDiskVersion();
        setError(null);
        return completedChanges.map((change) => change.nextPath);
      } catch (reason) {
        const completedPaths = new Set(completedChanges.map((change) => change.previousPath));
        const rollbackChanges = optimisticChangesApplied
          ? plannedChanges
            .filter((change) => !completedPaths.has(change.previousPath))
            .reverse()
            .map((change) => ({ previousPath: change.nextPath, nextPath: change.previousPath }))
          : [];
        applyProjectEntryPathChanges(rollbackChanges);
        setError(toMessage(reason));
        await reconcileProjectTree().catch(() => undefined);
        throw reason;
      }
    });
  }, [
    accept, activeFileRef, applyProjectEntryPathChanges, editFile, flush, markDiskVersion, project?.root,
    projectAssetPaths, reconcileProjectTree, save, sourceRef, t, withTreeMutation,
  ]);

  /** List every occurrence of a label or citation key in the references panel. */
  const showSymbolReferences = useCallback(async (kind: "label" | "citation", symbol: string) => {
    const occurrences = kind === "label"
      ? await invoke<SymbolOccurrence[]>("find_label_occurrences", { label: symbol })
      : await invoke<SymbolOccurrence[]>("find_citation_occurrences", { key: symbol });
    setReferenceHits({ kind, symbol, occurrences });
  }, []);

  const submitRename = useCallback(async (name: string) => {
    if (!renameTarget) return;
    try {
      if (renameTarget.kind === "label" || renameTarget.kind === "citation") {
        const result = renameTarget.kind === "label"
          ? await invoke<RenameSymbolResult>("rename_label", { oldLabel: renameTarget.label, newLabel: name })
          : await invoke<RenameSymbolResult>("rename_citation_key", { oldKey: renameTarget.key, newKey: name });
        applyBibliographyIndex(await loadBibliographyIndex());
        await refreshUnusedSymbols();
        await refreshHistory();
        if (result.changedFiles.includes(activeFile)) await loadFile(activeFile);
        setOutlineSources({});
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
    activeFile, loadFile, refreshHistory, refreshUnusedSymbols, renameTarget, showSymbolReferences,
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

  /** Save pasted image bytes into the project; resolves the new path. */
  const importImageBytes = useCallback(async (
    readPng: () => Promise<{ base64: string; type: string }>,
    targetDirectory: string,
    emptyMessage = "",
  ): Promise<string | null> => {
    try {
      const { base64, type } = await readPng();
      const path = await invoke<string>("import_clipboard_image", {
        targetDirectory, fileName: clipboardImageFileName(type), base64Data: base64, projectRoot: project?.root,
      });
      await refreshProject();
      setError(null);
      return path;
    } catch (reason) {
      setError(toMessage(reason) || emptyMessage);
      return null;
    }
  }, [project?.root, refreshProject]);
  const importClipboardImageFile = useCallback((file: File) => importImageBytes(
    async () => ({ base64: await fileToBase64(file), type: file.type || "image/png" }),
    "figures",
  ), [importImageBytes]);
  const importSystemClipboardImage = useCallback(async (targetDirectory: string) => project ? importImageBytes(async () => {
    const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
    const image = await readImage();
    const size = await image.size();
    return { base64: await rgbaImageToPngBase64(await image.rgba(), size.width, size.height), type: "image/png" };
  }, targetDirectory, t`No image found on the clipboard.`) : null, [importImageBytes, project, t]);
  /** Insert an imported figure at the editor caret. */
  const insertFigureAtCaret = useCallback((path: string | null) => {
    if (path) updateCanvasRequest("figure", { id: crypto.randomUUID(), paths: [path], clientX: -1, clientY: -1 });
  }, [updateCanvasRequest]);
  const handlePasteImageFile = useCallback((file: File) => {
    void importClipboardImageFile(file).then(insertFigureAtCaret);
    return true;
  }, [importClipboardImageFile, insertFigureAtCaret]);
  const pasteClipboardImage = useCallback(async () => {
    if (!project || !activeFile?.endsWith(".tex")) {
      setError(t`Open a .tex file before pasting a figure.`);
      return;
    }
    const path = await importSystemClipboardImage("figures");
    if (!path) return;
    reveal("editor");
    insertFigureAtCaret(path);
  }, [activeFile, importSystemClipboardImage, insertFigureAtCaret, project, reveal, t]);

  const revealProjectItem = useCallback(async (relativePath: string) => {
    if (!project) return;
    try {
      await revealItemInDir(projectItemPath(project.root, relativePath));
      setError(null);
    } catch (reason) {
      const message = toMessage(reason);
      setError(t`Could not show that item in Finder. ${message}`);
    }
  }, [project, t]);

  const deletePaper = useCallback(async (paper: PaperSummary) => {
    if (!paper.citationKey) {
      setError(t`This bibliography entry has no citation key to remove.`);
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
        setError(first
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
          setError(reverted
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
      setError(null);
      await refreshProject();
      await refreshHistory();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [
    accept, activeFile, activeFileRef, activePaper, flush, leavePaper, markDiskVersion, project,
    refreshHistory, refreshProject, save, sourceRef, t, captureProjectScope,
  ]);

  /** Opens on `tab`, or without one on the page Settings was last left on. */
  const openSettings = useCallback((requested?: SettingsTab) => {
    const tab = requested ?? loadSettingsTab();
    if (isSynaraSettingsTab(tab)) requestSynaraRuntime();
    setSettingsTab(tab);
    persistSettingsTab(tab);
    setSettingsOpen(true);
  }, [requestSynaraRuntime]);

  const settingsDialog = settingsOpen ? (
    <Suspense fallback={null}>
      <SettingsDialog
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
          openSettings(tab);
          if (tab === "doctor") void texSetup.runDoctor();
        }}
        doctorReport={texSetup.doctorReport}
        doctorBusy={texSetup.doctorBusy}
        doctorNotice={texSetup.doctorNotice}
        onRunDoctor={() => { void texSetup.runDoctor(); }}
        onOpenTexSetup={texSetup.openWizard}
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
        onClose={() => setSettingsOpen(false)}
      />
    </Suspense>
  ) : null;

  const overleafPicker = overleafPickerOpen ? (
    <Suspense fallback={null}>
      <OverleafPickerDialog
        open
        onClose={() => setOverleafPickerOpen(false)}
        onBeforeClone={startProjectTransition}
        onCloneCancelled={cancelProjectTransition}
        onCloned={(root) => {
          setOverleafPickerOpen(false);
          void revealNewProject(t`Opening the Overleaf project…`, async () => root).then((opened) => {
            if (opened) setError(null);
          });
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
            setError(null);
            await compile();
          }}
        />
      )}
    </Suspense>
  ) : null;

  const projectPaths = useMemo(
    () => (project ? flattenProjectPaths(project.files) : []),
    [project],
  );
  const rootDocumentPath = project?.manifest.rootDocuments.find((document) => document.isDefault)?.path
    ?? project?.manifest.rootDocuments[0]?.path
    ?? "";
  const primaryBibliography = project?.manifest.primaryBibliography ?? "";
  const protectedProjectPaths = useMemo(
    () => [...(rootDocumentPath ? [rootDocumentPath] : []), primaryBibliography],
    [primaryBibliography, rootDocumentPath],
  );
  // The document in the editor, and the same text as of the last pause in
  // typing for the work that reads all of it (useSettledSource): counts,
  // TODOs, outline, labels, macros. A long buffer pays for that once per pause
  // rather than once per keystroke; a short one reads live.
  const { key: editorKey, text: canvasSource } = documents.canvas;
  const settledCanvasSource = useSettledSource(`${project?.root ?? ""}\n${editorKey}`, canvasSource);
  // With a Paper in front, the primary buffer is not being edited.
  const settledSource = activePaper ? source : settledCanvasSource;
  // Live buffers participate in the project-wide TeX derivations below
  // (outline, macros, labels, appendix) only for .tex files. Deriving the
  // nullable scalars here keeps every downstream memo inert while typing
  // Markdown — `null` is Object.is-stable across keystrokes, so the maps and
  // the parse chains behind them stop recomputing per character.
  const activeTexSource = activeFile.endsWith(".tex") ? settledSource : null;
  const liveOutlineSources = useMemo(() => ({
    ...outlineSources,
    ...(activeTexSource != null ? { [activeFile]: activeTexSource } : {}),
  }), [activeFile, activeTexSource, outlineSources]);
  // Go to symbol lists the same outline, so it reads the included files too:
  // with only the open buffer it found nothing in a project whose sections
  // live in \input/\include files, or whenever the root was not open.
  const outlineWanted = outlineOpen || searchDialog === "goto-symbol";
  useEffect(() => {
    if (!project || !outlineWanted || !rootDocumentPath) return;
    let cancelled = false;
    const missing: string[] = [];
    const seen = new Set<string>();
    const visit = (path: string, depth: number) => {
      if (depth > 8 || seen.has(path)) return;
      seen.add(path);
      const text = liveOutlineSources[path];
      if (text == null) {
        missing.push(path);
        return;
      }
      for (const included of includedPathsIn(text, projectPaths)) visit(included, depth + 1);
    };
    visit(rootDocumentPath, 0);
    if (!missing.length) return;
    void Promise.all(missing.map(async (path) => {
      try {
        return [path, await invoke<string>("read_project_file", { path })] as const;
      } catch {
        return [path, ""] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      setOutlineSources((current) => {
        const next = { ...current };
        let changed = false;
        for (const [path, content] of entries) {
          if (current[path] === content) continue;
          next[path] = content;
          changed = true;
        }
        return changed ? next : current;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [liveOutlineSources, outlineWanted, project, projectPaths, rootDocumentPath]);
  const outlineNodes = useMemo(() => {
    if (!rootDocumentPath) return [];
    return parseProjectOutline(rootDocumentPath, liveOutlineSources, projectPaths);
  }, [liveOutlineSources, projectPaths, rootDocumentPath]);
  const liveReferences = useMemo(() => {
    let merged = references;
    if (activeTexSource != null) {
      merged = mergeReferences(merged, activeFile, parseLocalLabels(activeFile, activeTexSource));
    }
    return merged;
  }, [activeFile, activeTexSource, references]);
  const activeOutlineId = useMemo(() => {
    if (!activeFile.endsWith(".tex") || !editorPosition) return null;
    return activeOutlineNode(outlineNodes, activeFile, editorPosition.line)?.id ?? null;
  }, [activeFile, editorPosition, outlineNodes]);
  // Versionless arXiv ids whose full text is already in the library — the
  // Discover panel shows these hits as done instead of importable.
  const importedArxivIds = useMemo(
    () => new Set(papers.filter((paper) => paper.hasFullText && paper.arxivId).map((paper) => baseArxivId(paper.arxivId))),
    [papers],
  );
  const liveSourceMap = useMemo(() => ({
    ...outlineSources,
    ...(activeTexSource != null ? { [activeFile]: activeTexSource } : {}),
  }), [activeFile, activeTexSource, outlineSources]);
  const liveMacroSources = useMemo(() => Object.values(liveSourceMap), [liveSourceMap]);
  const liveMacros = useMemo(() => parseLocalMacros(liveMacroSources), [liveMacroSources]);
  const graphicsRoots = useMemo(() => parseGraphicsPaths(liveMacroSources), [liveMacroSources]);
  const katexMacros = useMemo(() => katexMacrosFromSources(liveMacroSources), [liveMacroSources]);
  // TODOs come from .md buffers too (todo_source_path on the Rust side), so
  // this cannot ride the .tex-only scalars above. The rescan only visits
  // candidate lines, so it runs in the render that changes the settled text:
  // deferring it with useDeferredValue re-rendered all of App a second time
  // per keystroke.
  const todoHits = useMemo(
    () => mergeTodosWithBuffer(diskTodos, activeFile, settledSource),
    [activeFile, diskTodos, settledSource],
  );

  // Where \appendix sits, as two scalars rather than the marker object. The
  // source map behind it is rebuilt on every keystroke, so keying the SyncTeX
  // lookup on the map spent an IPC round trip per character typed while a
  // build was on screen. The appendix only moves when someone edits around it.
  const appendixMarker = useMemo(() => findAppendixMarker(liveSourceMap), [liveSourceMap]);
  const appendixMarkerPath = appendixMarker?.path ?? "";
  const appendixMarkerLine = appendixMarker?.line ?? 0;
  useEffect(() => {
    if (!build?.success || !pdfUrl || !appendixMarkerPath) {
      setMainBodyPages(null);
      return;
    }
    let cancelled = false;
    void invoke<{ page: number } | null>("synctex_view", { path: appendixMarkerPath, line: appendixMarkerLine, column: 0 })
      .then((target) => (target ? Math.max(0, target.page - 1) : null), () => null)
      .then((pages) => {
        if (!cancelled) setMainBodyPages(pages);
      });
    return () => {
      cancelled = true;
    };
  }, [appendixMarkerLine, appendixMarkerPath, build?.success, pdfUrl]);

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
      setError(t`Open a .tex file before formatting.`, t`Format`);
      return;
    }
    const trace = logAction(t`Format`, t`Format document`, path);
    void import("./build/texlab-language")
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
  /** Every app-level action: the palette entries and the global shortcuts (see AppCommand). */
  const commands: AppCommand[] = [
    { id: "build", label: t`Build project`, detail: "⌘S", group: t`Build`, run: () => void compileAndShowPdf(false, true) },
    { id: "rebuild", label: t`Clean rebuild`, detail: t`latexmk -c then -g`, group: t`Build`, run: () => void cleanAndRebuild() },
    { id: "clean", label: t`Clean aux files`, group: t`Build`, run: () => void cleanProject() },
    { id: "stop-build", label: t`Stop build`, group: t`Build`, run: () => void abortBuild() },
    { id: "sync-pdf", label: t`Jump to PDF`, detail: "⌘⇧J", group: t`Navigate`, key: "j", shift: true, run: () => void revealSourceInPdf() },
    { id: "quick-open", label: t`Quick open file`, detail: "⌘P", group: t`Navigate`, key: "p", run: () => setSearchDialog("quick-open") },
    { id: "goto-line", label: t`Go to line`, detail: "⌘G", group: t`Navigate`, key: "g", run: () => setSearchDialog("goto-line") },
    { id: "goto-symbol", label: t`Go to symbol`, detail: "⌘⇧O", group: t`Navigate`, key: "o", shift: true, run: () => setSearchDialog("goto-symbol") },
    { id: "back", key: "[", run: () => void documents.go(-1) },
    { id: "forward", key: "]", run: () => void documents.go(1) },
    { id: "palette", key: "p", shift: true, run: () => setCommandPaletteOpen(true) },
    { id: "reopen-tab", key: "t", shift: true, run: documents.reopenClosed },
    // Reset the panel layout, and bring back any panel that was hidden or closed.
    { id: "layout-reset", label: t`Reset panel layout`, group: t`Layout`, run: () => void trellis.resetLayout() },
    ...SINGLETON_PANELS.map((kind) => {
      const name = i18n._(PANEL_TITLES[kind]);
      return { id: `panel-${kind}`, label: spaceMixedScript(t({ message: `Show ${name} panel` })), group: t`Layout`, run: () => trellis.showPanel(kind) };
    }),
    { id: "table", label: t`Insert table`, detail: t`Grid generator`, group: t`Edit`, run: () => setTableGeneratorOpen(true) },
    { id: "cite", label: t`Insert citation`, detail: "⌘⇧K", group: t`Edit`, key: "k", shift: true, run: () => setSearchDialog("cite") },
    { id: "ref", label: t`Insert reference`, detail: "⌘⇧L", group: t`Edit`, key: "l", shift: true, run: () => setSearchDialog("ref") },
    { id: "bib", label: t`Add bibliography entry`, group: t`Edit`, run: () => referenceImport.openBibEntry() },
    { id: "discover", label: t`Discover literature`, detail: t`OpenAlex search`, group: t`Research`, run: () => openLiterature(true) },
    { id: "find", label: t`Find in project`, detail: t`⌘⇧F · source files and papers`, group: t`Edit`, key: "f", shift: true, run: openProjectFind },
    { id: "replace", label: t`Replace in project`, detail: t`⌘⇧H · all source files`, group: t`Edit`, key: "h", shift: true, run: openProjectReplace },
    {
      id: "todos", label: t`Manuscript TODOs`, detail: todoCount === 0 ? t`No markers` : todoCount === 1 ? t`${todoCount} marker` : t`${todoCount} markers`, group: t`Edit`,
      run: () => {
        void refreshTodos();
        setTodosOpen(true);
        revealOpenTool("todos");
      },
    },
    {
      id: "checklist", label: t`Submission checklist`, detail: t`Words / pages / TODOs`, group: t`Edit`,
      run: () => {
        void refreshTodos();
        void refreshWordCount();
        setChecklistOpen(true);
        revealOpenTool("checklist");
      },
    },
    { id: "paste-image", label: t`Paste clipboard image as figure`, group: t`Edit`, run: () => void pasteClipboardImage() },
    { id: "format", label: t`Format document`, detail: "latexindent", group: t`Edit`, run: formatFocusedDocument },
    { id: "history", label: t`Open project history`, group: t`Project`, run: () => { setHistoryOpen(true); revealOpenTool("history"); } },
    { id: "export-zip", label: t`Export project ZIP`, detail: t`Overleaf / arXiv source pack`, group: t`Project`, run: () => void exportProjectZip() },
    {
      id: "tutorial", label: t`Open guided tutorial`, group: t`Project`, run: () => void openTutorialProject(),
      detail: t`Learn Lattice with the Understanding Attention sample project`,
    },
    { id: "doctor", label: t`Run TeX doctor`, group: t`Project`, run: () => openSettings("doctor") },
    {
      id: "browser", group: t`Project`, run: () => void moveWorkspace(),
      ...(inBrowserTab
        ? { label: t`Open in Lattice app` }
        : { label: t`Open in browser`, detail: "http://127.0.0.1:18452" }),
    },
    { id: "settings", label: t`Open settings`, detail: "⌘,", group: t`Project`, key: ",", run: () => openSettings() },
  ];
  const runCommand = useAppCommands(commands, cycleDiagnostic);

  // Trellis workspace: App stays the owner of every document; the
  // workspace reads App through this bridge (at event time) and the store below.
  useTrellisBridge({
    trellis, project, projectRef, papers, documents, lastBuild: buildOutcome, building, buildPipeline,
    synara, editorComments, referenceImport, projectSearch, compile, compileAndShowPdf, revealSourceInPdf,
    openSettings, openLiterature, refreshTodos, setSearchDialog, setHistoryOpen, setGitOpen, setTodosOpen,
    setChecklistOpen, setProjectSearchOpen, setBibliographyAuditRoot, setBibliographyAuditOpen,
    setSpreadsheetCreateRequest, setBoardCreateRequest, setPresentationCreateRequest,
  });
  // Panel action rows (Trellis tab-bar accessories): memoized, because App
  // re-renders on every keystroke and each row is a set of tooltip buttons.
  const { permissionMode, autoModeAvailable, changePermissionMode } = synara;
  const trellisActions = useMemo(() => {
    const actions = (mode: "project" | "papers" | "agent") => (
      <PanelActions
        mode={mode}
        synara={{ origin: synaraOrigin, permissionMode, autoModeAvailable, changePermissionMode }}
        openBibEntryDialog={referenceImport.openBibEntry}
        onCheckReferences={() => {
          const root = projectRef.current?.root;
          if (!root) return;
          setBibliographyAuditRoot(root);
          setBibliographyAuditOpen(true);
        }}
        setLiteratureOpen={openLiterature}
        openProjectFind={projectSearch.openFind}
        setProjectSearchOpen={setProjectSearchOpen}
        setBoardCreateRequest={setBoardCreateRequest}
        setPresentationCreateRequest={setPresentationCreateRequest}
        setSpreadsheetCreateRequest={setSpreadsheetCreateRequest}
      />
    );
    return { project: actions("project"), papers: actions("papers"), agent: actions("agent") };
    // `synara` is rebuilt each render; the row reads only the fields listed.
  }, [
    autoModeAvailable, changePermissionMode, permissionMode, projectRef, projectSearch.openFind,
    openLiterature, referenceImport.openBibEntry, synaraOrigin,
  ]);
  // A forward search needs the PDF panel on screen: reopen or reveal it.
  useEffect(() => {
    const ws = trellis.ws;
    if (!ws || !pdfSyncTarget) return;
    const pdf = ws.view("pdf");
    if (!pdf || !pdf.visible) trellis.showPanel("pdf", { focus: false });
  }, [pdfSyncTarget, trellis]);

  // The navigators' callbacks are mostly inline, so they change on every App
  // render. The memoized Navigator gets stable forwarders instead, which call
  // the latest handlers: refreshed after every commit, before any event.
  const navigatorHandlersRef = useRef<NavigatorHandlers | null>(null);
  useLayoutEffect(() => {
    navigatorHandlersRef.current = {
      onFile: openProjectFileFromClick,
      onLikelyFile: prewarmLikelyProjectFile,
      onAsset: openProjectAssetFromClick,
      onBeginFigureDrag: beginProjectFigureDrag,
      onBeginFileDrag: beginProjectFileDrag,
      onCreateEntry: createProjectEntry,
      onDeleteEntries: deleteProjectEntries,
      onRenameEntry: renameProjectEntry,
      onMoveEntries: moveProjectEntries,
      onCopyEntries: (paths, targetDirectory) => project
        ? importProjectFiles(paths.map((path) => absoluteProjectPath(project.root, path)), targetDirectory, true)
        : Promise.resolve([]),
      onError: setError,
      onReveal: revealProjectItem,
      onImportAssets: chooseProjectAssets,
      onPasteImage: (targetDirectory) => void importSystemClipboardImage(targetDirectory),
      onPaper: (paper) => void openPaper(paper),
      onLikelyPaper: prewarmLikelyPaper,
      onFetchFullText: (paper) => void fetchAndOpenPaper(paper),
      onDeletePaper: deletePaper,
      onEditBibEntry: (paper) => void referenceImport.editBibEntry(paper),
      setImportInput: referenceImport.setInput,
      onImport: referenceImport.importFromInput,
      onCancelImport: referenceImport.cancelImport,
    };
  });
  const [navigatorHandlers] = useState(() => Object.fromEntries(NAVIGATOR_HANDLER_KEYS.map((key) => [
    key,
    (...args: unknown[]) => (navigatorHandlersRef.current?.[key] as ((...values: unknown[]) => unknown) | undefined)?.(...args),
  ])) as unknown as NavigatorHandlers);

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
          onSettings={() => openSettings()}
          onInstallTex={texSetup.openWizard}
          onOpenOverleaf={() => setOverleafPickerOpen(true)}
        />
        {settingsDialog}
        {overleafPicker}
        {overleafReview}
        <TexSetupDialogs setup={texSetup} />
      </>
    );
  }

  const editorEditableForPath = (path: string, ignoreOverleaf = false) => (
    !compileRepair.busy
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


  const renderNavigator = (mode: "project" | "papers") => {
    // With both navigators on screen (Trellis), only the project one answers
    // search and new-document requests.
    const owner = mode === "project";
    return (
      <Suspense fallback={null}>
        <Navigator
          mode={mode}
          projectKey={project.root}
          searchOpen={owner && projectSearchOpen}
          boardCreateRequest={owner ? boardCreateRequest : 0}
          spreadsheetCreateRequest={owner ? spreadsheetCreateRequest : 0}
          presentationCreateRequest={owner ? presentationCreateRequest : 0}
          onSearchOpenChange={owner ? setProjectSearchOpen : ignoreSearchOpenChange}
          files={project.files}
          gitStatus={projectGit.gitFiles}
          activeFile={activeAsset || activePaper ? "" : activeFile}
          activeAssetPath={activeAsset?.path ?? ""}
          protectedPaths={protectedProjectPaths}
          papers={papers}
          activePaper={activePaper}
          {...navigatorHandlers}
          assetDropTarget={assetDropTarget}
          assetImporting={assetImporting}
          paperFetchStates={paperFetchStates}
          importInput={referenceImport.input}
          recentImport={referenceImport.recentImport?.projectRoot === project.root ? referenceImport.recentImport : null}
          importStage={referenceImport.stage ? paperImportStageLabel(referenceImport.stage) : null}
          importStageId={referenceImport.stage}
          importing={referenceImport.importing}
        />
      </Suspense>
    );
  };
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
      onPdfTextSelect={(value) => agentContext.reportSelection("pdf", value)}
      onPaperTextSelect={(value) => agentContext.reportSelection("paper", value)}
      onImportAsset={importClipboardImageFile}
      onContextSurfaceActivate={agentContext.activateSurface}
      onViewMarkdownSource={() => chooseMode("split")}
      onOpenSlideMutation={applyOpenSlideMutation}
      onOpenSlideContext={setOpenSlideContext}
      onOpenSlideError={setError}
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
              const frame = synara.frameRef.current;
              if (frame && synara.origin) {
                const url = new URL(frame.src);
                url.pathname = `/${encodeURIComponent(threadId)}`;
                frame.src = url.toString();
              }
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
        else if (url) void openUrl(url).catch((reason) => setError(toMessage(reason)));
      }}
      citationKeys={citationKeys}
      citations={citations}
      references={liveReferences}
      unusedLabels={texlabActive ? [] : unusedSymbols.labels}
      unusedCitations={texlabActive ? [] : unusedSymbols.citations}
      onLoadReferenceImage={referenceImages.load}
      referenceImageGeneration={referenceImages.generation}
      onEditorLeave={documents.canvas.onLeave}
      onPrepareFigure={prepareLatexFigure}
      onPasteImageFile={handlePasteImageFile}
      nativeFigureDropActive={nativeEditorDropActive}
      fileDropTargetActive={fileDropTargetActive}
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
      localMacros={liveMacros}
      katexMacros={katexMacros}
      onGotoLineRequest={() => setSearchDialog("goto-line")}
      outlineOpen={outlineOpen}
      onOutlineOpenChange={setOutlineOpen}
      outlineNodes={outlineNodes}
      activeOutlineId={activeOutlineId}
      onOutlineNavigate={(path, line) => { void navigateOutline(path, line); }}
      tableGeneratorOpen={tableGeneratorOpen}
      onTableGeneratorOpenChange={setTableGeneratorOpen}
      editorKeymap={appearance.editorKeymap}
      editorSpellcheck={appearance.editorSpellcheck}
      spellingWords={project.manifest.spellingWords ?? EMPTY_SPELLING_WORDS}
      onAddSpellingWord={addProjectSpellingWord}
      projectPaths={projectPaths}
      graphicsRoots={graphicsRoots}
      buildDiagnostics={
        buildPipeline.compiledSources.get(activeFile) === source
          ? build?.diagnostics ?? EMPTY_DIAGNOSTICS
          : EMPTY_DIAGNOSTICS
      }
      texlabDiagnostics={texlabDiagnostics}
      pdfSyncTarget={pdfSyncTarget}
      canForwardSync={Boolean(forwardSyncPosition)}
      locatingPdf={locatingPdf}
      onForwardSync={() => void revealSourceInPdf()}
      onPdfSource={revealPdfSource}
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
      onOpenEditorComments={openEditorComments}
      onResolveEditorComment={editorComments.toggleResolved}
      onReplyEditorComment={(commentId) => {
        editorComments.openReply(commentId);
        revealOpenTool(commentsToolKind);
      }}
      commentFocusRequest={editorComments.focusRequest}
      onCommentFocusHandled={(nonce) => {
        editorComments.setFocusRequest((current) => (current?.nonce === nonce ? null : current));
      }}
      todoCount={todoHits.length}
      onOpenTodos={() => {
        void refreshTodos();
        setTodosOpen(true);
        revealOpenTool("todos");
      }}
      projectWordCount={projectWordCount}
      onPdfPageCount={setPdfPageCount}
      onPdfPageChange={setPdfPageNumber}
      onCreateMissingFile={(path) => {
        void createProjectEntry(path, "file");
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
      }}
    />
  );

  return (
    <TrellisControllerContext.Provider value={trellis}>
    <div
      className={`app-shell trellis-layout ${isFullscreen ? "fullscreen" : ""} ${browserHosted ? "browser-hosted" : ""}`}
      ref={shellRef}
    >
      <Suspense fallback={null}>
        <PaperDropBridge
          library={{ projectRoot: project.root, papers }}
          onOpen={readDraggedPaper}
          onError={(reason) => setError(toMessage(reason))}
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
          onSettings: () => openSettings(),
        }}
        panelControls={<TrellisTitlebar controller={trellis} />}
        canvasToolbar={(
        <CanvasToolbar
          activePath={activePaper ? activePaper.title : documents.activeTab}
          activeKind={activeAsset ? "asset" : activePaper ? "paper" : "document"}
          dirty={documents.dirty}
          // The tour points these controls out rather than opening them, so
          // their panels stay shut while it runs.
          onHistory={() => {
            setHistoryOpen(true);
            revealOpenTool("history");
          }}
          onGit={() => {
            synara.requestRuntime();
            setGitOpen(true);
            revealOpenTool("git");
          }}
          commentCount={editorComments.all.filter((comment) => !comment.resolved).length}
          onComments={openEditorComments}
          inBrowserTab={inBrowserTab}
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
          onOverleafSync={() => {
            // Manual mode is a review step, not a button that quietly
            // rewrites files: show what would change and let the user decide.
            if (overleafSyncMode === "manual") setOverleafReviewOpen(true);
            else void runOverleafSync();
          }}
          onOverleafOpenCurrent={overleafLink ? openCurrentOverleafProject : undefined}
          onOverleafOpen={() => setOverleafPickerOpen(true)}
          overleafUnreadChat={
            overleafChat.unread + overleafComments.threads.filter((thread) => !thread.resolved).length + overleafRealtime.changes.length
            + editorComments.comments.filter((comment) => !comment.resolved).length
          }
          onOverleafChat={() => {
            openEditorComments();
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
          <TrellisWorkspace key={project.root} controller={trellis} projectRoot={project.root} dark={theme === "dark"} />
        </Suspense>
        {createPortal(renderNavigator("project"), trellis.hosts.project)}
        {createPortal(renderNavigator("papers"), trellis.hosts.papers)}
        {createPortal(trellisActions.project, trellis.hosts.projectActions)}
        {createPortal(trellisActions.papers, trellis.hosts.papersActions)}
        {createPortal(trellisActions.agent, trellis.hosts.agentActions)}
        {agentPresent && createPortal(
          <Suspense fallback={null}>
            <TrellisAgentSurface
              synara={synara}
              projectRoot={project.root}
              theme={theme}
              appLocale={appLocale}
              dropActive={agentPanelDropActive}
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
      </main>


      <TexSetupDialogs setup={texSetup} />


      <AppHistoryDrawers
        drawers={{
          historyOpen, setHistoryOpen, gitOpen, setGitOpen, gitWorkspaceView, setGitWorkspaceView,
          agentTurnReview, setAgentTurnReview,
        }}
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
        activeFileRef={activeFileRef}
        build={build}
        checklistOpen={checklistOpen}
        editorCommentAuthorId={editorCommentAuthorId}
        mainBodyPages={mainBodyPages}
        openProjectFile={openFile}
        pdfPageCount={pdfPageCount}
        project={project}
        projectWordCount={projectWordCount}
        refreshTodos={refreshTodos}
        setChecklistOpen={setChecklistOpen}
        setProject={setProject}
        setTodosOpen={setTodosOpen}
        todoHits={todoHits}
        todosOpen={todosOpen}
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
        captureProjectScope={projectState.captureProjectScope}
        projectRef={projectRef}
        dirty={source !== savedSource}
        activeFile={activeFile}
        loadFile={loadFile}
        openMarkdownProjectPath={openMarkdownProjectPath}
        openProjectFile={openFile}
        refreshHistory={refreshHistory}
        refreshProject={refreshProject}
        save={save}
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

      <SearchPickerDialog
        open={commandPaletteOpen}
        title={t`Command palette`}
        placeholder={t`Run a command…`}
        detailPlacement="end"
        items={commands.flatMap(({ id, label, detail, group, when }) => (
          label && when !== false ? [{ id, label, detail, group }] : []
        ))}
        onClose={() => setCommandPaletteOpen(false)}
        onSelect={(item) => {
          setCommandPaletteOpen(false);
          runCommand(item.id);
        }}
      />
      {settingsDialog}
      {overleafPicker}
      {overleafReview}

    </div>
    </TrellisControllerContext.Provider>
  );
}

export default App;
