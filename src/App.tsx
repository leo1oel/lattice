import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { Image } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import * as Y from "yjs";
import {
  bibliographyEntryLine,
  mergeReferences,
  parseGraphicsPaths,
  parseLocalLabels,
  parseLocalMacros,
  type DefinitionTarget,
  type SymbolTarget,
} from "./editor/latex/latex-text";
import { formatBibDocument } from "./papers/bib-format";
import { clipboardImageFileName, fileToBase64, rgbaImageToPngBase64 } from "./editor/insert/clipboard-image";
import { listenForBrowserProjectDrops } from "./project/browser-project-drop";
import { SearchPickerDialog } from "./components/ui/search-picker-dialog";
import { parsePaperLinkPath } from "./papers/paper-link";
import { canDownloadPaper, citationSourceUrl } from "./papers/paper-source";
import { paperImportStageLabel } from "./papers/paper-import-progress";
import {
  assertCollabWorkspaceLease,
  CollabDiskWriteQueue,
  type CollabWorkspaceLease,
} from "./collab/collab-workspace-lease";
import { loadEditorCommentAuthorId } from "./editor/comments/editor-comment-data";
import { useAppearance } from "./settings/use-appearance";
import { isBrowserHosted, isBundledChromium } from "./platform/browser-runtime";
import { configureInterfaceSounds, playInterfaceSound } from "./telemetry/interface-sounds";
import { useWorkspaceSidebar } from "./app/use-workspace-sidebar";
import { useFileViewStates } from "./app/use-file-view-states";
import { useProjectSearch } from "./app/use-project-search";
import { useReferenceImages } from "./app/use-reference-images";
import { collectAssetPaths, planWorkspaceRestore } from "./app/workspace-restore";
import { useReferenceImport } from "./app/use-reference-import";
import { overleafThreadOf, useEditorComments } from "./app/use-editor-comments";
import { useAgentCheckpoints } from "./app/use-agent-checkpoints";
import { useBuildPipeline } from "./app/use-build-pipeline";
import { useTexSetup } from "./app/use-tex-setup";
import { paperDocumentPath, useDocumentBuffers } from "./app/use-document-buffers";
import { useLocalSemanticSearch } from "./app/use-local-semantic-search";
import { useSynaraHost } from "./app/use-synara-host";
import { useAgentContext } from "./app/use-agent-context";
import { useProjectState, useProjectTreeWatch } from "./app/use-project-state";
import { loadBibliographyIndex, useProjectLibrary } from "./app/use-project-library";
import { loadDocumentCanvas, usePreviewPrewarm } from "./app/use-preview-prewarm";
import {
  useFullscreen,
  useLeavePresenceOnClose,
  useTrafficLightAlignment,
  useWindowMinimumSize,
} from "./app/use-native-window";
import { afterNextPaintOpportunity, disposeWhenSettled, useLatest } from "./app/effect-helpers";
import { useCollabChat } from "./collab/use-collab-chat";
import { useOverleafWorkspace } from "./app/use-overleaf-workspace";
import {
  bytesToBase64,
  SHARE_SOURCE,
  useCollabV2Session,
} from "./app/use-collab-v2-session";
import {
  syncSharedProjectWithOverleaf,
  writeOpenSlideMutation,
  type EditorWriteResult,
  type SharedWorkspaceDisk,
} from "./app/shared-document-sync";
import { AppCollabDialog, AppOverleafCollabDrawer } from "./app/app-collab-surfaces";
import { AppEditorPanels } from "./app/app-editor-panels";
import { AppHistoryDrawers } from "./app/app-history-drawers";
import { AppOnboardingTour } from "./app/app-onboarding-tour";
import { AppProjectDialogs, TexSetupDialogs, type CreateProjectForm } from "./app/app-project-dialogs";
import { AppProjectSearchDialogs, AppSearchDialogs, type SearchDialog } from "./app/app-search-dialogs";
import { AppTitlebar } from "./app/app-titlebar";
import { AppWorkspaceSidebar } from "./app/app-workspace-sidebar";
import { CanvasToolbar } from "./canvas/canvas-toolbar";
import type {
  OpenSlideContext,
  OpenSlideMutation,
  OpenSlideSyncOperation,
} from "./editor/presentation/open-slide-bridge";
import { AvatarGroup } from "./components/ui/avatar-group";
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
  loadLastFile,
  persistLastFile,
  loadWorkspaceLayout,
  persistWorkspaceLayout,
  persistOverleafRemoteDelete,
  persistOverleafSyncMode,
  hasSeenTutorial,
  markTutorialSeen,
  resolveAppLocale,
} from "./settings/app-settings";
import { waitForAgentCanvasAdapter } from "./agent/agent-canvas-tools";
import type { AgentProjectDocumentToolRequest } from "./agent/agent-project-document-tools";
import type { BuildAgentCommentsOptions } from "./agent/agent-editor-comments";
import {
  registerAgentSpreadsheetDocumentResolver,
  waitForAgentSpreadsheetDocument,
} from "./agent/agent-spreadsheet-tools";
import { isSpreadsheetPath } from "./editor/spreadsheet/spreadsheet-types";
import { seedSpreadsheetDoc, spreadsheetDocContent } from "./editor/spreadsheet/spreadsheet-yjs";
import {
  clearPreCollabProjectRoot,
  rememberPreCollabProjectRoot,
} from "./collab/collab-return";
import { rewriteMovedDocumentAssetPaths } from "./editor/insert/figure-insertion";
import {
  mergeTextIntoYText,
  peerInitials,
  saveCollabDisplayName,
  peerCursorLocationV2,
  waitForPeerCursorLocationV2,
  type CollabPeer,
  type EditorCollabSession,
} from "./collab/collab-session";
import { collabCredentialStore } from "./collab/collab-credentials";
import { isCollabEnabled, loadCollabFeaturePolicy } from "./collab/collab-feature-policy";
import { CollabControlErrorV2, CollabControlV2Client } from "./collab/collab-control-v2";
import { acceptCollabInvitationV2 } from "./collab/collab-join-v2";
import { CollabProjectControllerV2 } from "./collab/collab-project-v2";
import { isClientDestroyedErrorV2 } from "./collab/collab-text-v2";
import {
  parsePreferredCollabInvitation,
  planRemoteCollabDeleteUiV2,
  requireRememberedV2Credential,
} from "./collab/collab-app-v2";
import {
  forgetCollabProjectV2,
  loadCollabProjectsV2,
  rememberCollabProjectV2,
  type CollabProjectRecordV2,
} from "./collab/collab-rooms";
import {
  EMPTY_DIAGNOSTICS,
  flattenProjectPaths,
  resolveDiagnosticPath,
  type CompileDiagnostic,
} from "./build/compile-diagnostics";
import { useTexlabDiagnostics } from "./build/use-texlab-diagnostics";
import { useCompileRepair } from "./build/use-compile-repair";
import { Welcome } from "./project/project-dialogs";
import { TUTORIAL_STEPS } from "./onboarding/onboarding-steps";
import { activeOutlineNode, includedPathsIn, parseProjectOutline } from "./editor/latex/latex-outline";
import { katexMacrosFromSources } from "./editor/latex/katex-macros";
import {
  editorDropPreviewAt,
  EditorDropPreviewPortal,
  type EditorDropPreview,
  type EditorDropZone,
  type EditorTab,
} from "./canvas/editor-tabs";
import { baseArxivId } from "./papers/arxiv-id";
import { type PdfSyncTarget } from "./pdf/pdf-viewer";
import { findAppendixMarker } from "./editor/latex/appendix-pages";
import { mergeTodosWithBuffer } from "./project/todo-scavenger";
import type {
  ProjectManifest,
  NavigationEntry,
  ProjectSnapshot,
  AssetPreview,
  CanvasRequests,
  FigurePointerDrag,
  SyncTexTarget,
  EditorPosition,
  PdfSyncResponse,
  PaperSummary,
  RenameTarget,
  RenameSymbolResult,
  CanvasMode,
  EditorPaneId,
  DocumentViewMode,
  SettingsTab,
  InsertSymbolCommand,
  OverleafSyncResult,
  ViewRestoreRequest,
} from "./app-types";
import {
  absoluteProjectPath,
  applyProjectPathChanges,
  arxivIdFromTabKey,
  chooseAction,
  confirmAction,
  classifyExternalProjectDrop,
  dropAgentPanelAt,
  dropCanvasAt,
  dropDirectoryAt,
  dropEditorAt,
  editorPaneAt,
  isHtmlFilePath,
  isOpenSlideDeckPath,
  isPreviewableSourceFilePath,
  isProjectAssetFilePath,
  isProjectSourceFilePath,
  isPaperTabKey,
  isWholeFileEditorPath,
  paperKey,
  paperTabKey,
  projectItemPath,
  remapProjectPath,
  resolveKnownWholeFileProjectPath,
  stripFrontmatter,
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
import { logAction, notifyError } from "./telemetry/app-notify";
// setError / setWarning / setNotice are the ~170-call-site toast shims; they
// live beside the hooks extracted out of this file so both can use them.
import { setError, setNotice, setWarning } from "./app/notify";
import { addAppLog } from "./telemetry/app-log-store";
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
const Navigator = lazy(() =>
  import("./project/navigator").then((module) => ({ default: module.Navigator })),
);
const PaperLookupBridge = lazy(() => import("./papers/use-paper-lookup"));
const BibliographyAudit = lazy(() =>
  import("./papers/bibliography-audit").then((module) => ({ default: module.BibliographyAudit })),
);
const CompileDiagnosticsPanel = lazy(() =>
  import("./build/compile-diagnostics-panel").then((module) => ({ default: module.CompileDiagnosticsPanel })),
);
const DocumentCanvas = lazy(() =>
  loadDocumentCanvas().then((module) => ({ default: module.DocumentCanvas })),
);
const OpenSlideTabPool = lazy(() =>
  loadDocumentCanvas().then((module) => ({ default: module.OpenSlideTabPool })),
);

/** Shared empty word list: `?? []` in JSX rebuilds the editor's lint pass. */
const EMPTY_SPELLING_WORDS: string[] = [];

/** How long a project switch waits for an in-flight Overleaf sync before giving up on it. */
const PROJECT_SWITCH_SYNC_WAIT_MS = 15_000;

/// A one-shot instruction handed to a window as it opens, for the things the
/// project on disk cannot say. Kept narrow on purpose: the window that runs it
/// has to be able to do so from its own startup state alone.
type PendingWindowAction = {
  kind: "join-collab-v2";
  host: string;
  projectInstanceId: string;
};

// Must match the prefix `open_project_window` puts on a window-creation
// failure. Everything else it can fail with is the project itself.
const NEW_WINDOW_FAILURE_PREFIX = "Could not open a new window";

function isSynaraSettingsTab(tab: SettingsTab): boolean {
  return tab === "agent" || tab === "mcp" || tab === "api";
}

const isTwoPane = (mode: CanvasMode) => mode === "dual" || mode === "columns";

/**
 * A paper's full text and overview, read from the local library. They are
 * independent: an arxiv2md conversion can fail while alphaXiv still supplied
 * a useful blog, so keep either readable result rather than letting one
 * rejection discard the other. Library rows stay local on open — refreshing
 * alphaXiv in the foreground made a cached Paper switch wait on the network.
 */
async function readPaperDocuments(arxivId: string) {
  const [fullText, blog] = await Promise.allSettled([
    invoke<string>("read_paper", { arxivId }),
    invoke<string | null>("read_paper_blog_local", { arxivId }),
  ]);
  return {
    markdown: fullText.status === "fulfilled" ? fullText.value : "",
    blog: blog.status === "fulfilled" ? blog.value : null,
    failure: fullText.status === "rejected" ? fullText.reason as unknown : null,
  };
}

/** Keep full text when it is showing and exists; otherwise prefer the overview. */
function preferredPaperView(current: "blog" | "fulltext", markdown: string, blog: string | null) {
  return current === "fulltext" && markdown ? "fulltext" : blog ? "blog" : "fulltext";
}

/** How a live share stores a newly created text-like file. */
function sharedTextKind(path: string): "board" | "spreadsheet" | "text" {
  if (path.toLocaleLowerCase().endsWith(".tldr")) return "board";
  return isSpreadsheetPath(path) ? "spreadsheet" : "text";
}

function recordNavigationTiming(
  kind: "file" | "paper",
  path: string,
  startedAt: number,
  phases: Record<string, number>,
): void {
  const endedAt = performance.now();
  const detail = { kind, path, totalMs: endedAt - startedAt, ...phases };
  try {
    performance.measure("lattice:document-switch", { start: startedAt, end: endedAt, detail });
  } catch {
    // Older WebKit builds do not support PerformanceMeasureOptions.detail.
  }
  if (detail.totalMs < 100) return;
  addAppLog({
    level: "info",
    source: "Navigation performance",
    title: `${kind === "paper" ? "Paper" : "File"} switch`,
    detail: `${path}\n${Object.entries(detail)
      .filter(([key]) => key.endsWith("Ms"))
      .map(([key, value]) => `${key}=${Number(value).toFixed(1)}`)
      .join(" ")}`,
    toast: false,
  });
}

/**
 * Follow a pointer drag of a project-tree row. Past a 5px threshold it becomes
 * a drag: `move` gets each pointer position with the editor drop zone under it,
 * `clear` runs when it ends, and a release over a zone drops the path there.
 * The click that ends a drag is swallowed through `suppressClick`.
 */
function trackProjectItemDrag(
  path: string,
  event: React.PointerEvent,
  suppressClick: { current: string | null },
  move: (pointer: PointerEvent, preview: EditorDropPreview | null) => void,
  clear: () => void,
  drop: (zone: EditorDropZone) => void,
) {
  if (event.button !== 0) return;
  const { clientX: startX, clientY: startY, pointerId } = event;
  let dragging = false;
  const listening = new AbortController();
  const onMove = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    if (!dragging && Math.hypot(pointer.clientX - startX, pointer.clientY - startY) < 5) return;
    if (!dragging) document.body.classList.add("dragging-project-item");
    dragging = true;
    move(pointer, editorDropPreviewAt(path, pointer.clientX, pointer.clientY));
  };
  const end = () => {
    listening.abort();
    document.body.classList.remove("dragging-project-item");
    clear();
  };
  const onFinish = (pointer: PointerEvent) => {
    if (pointer.pointerId !== pointerId) return;
    const preview = dragging ? editorDropPreviewAt(path, pointer.clientX, pointer.clientY) : null;
    end();
    if (!dragging) return;
    suppressClick.current = path;
    window.setTimeout(() => {
      if (suppressClick.current === path) suppressClick.current = null;
    }, 0);
    if (preview) drop(preview.zone);
  };
  window.addEventListener("pointermove", onMove, { passive: false, signal: listening.signal });
  window.addEventListener("pointerup", onFinish, { signal: listening.signal });
  window.addEventListener("pointercancel", end, { signal: listening.signal });
  window.addEventListener("blur", end, { signal: listening.signal });
}

function App() {
  const { t } = useLingui();
  const browserHosted = isBrowserHosted();
  const bundledChromium = isBundledChromium();
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
  const buffers = useDocumentBuffers();
  const {
    activeFile, activeFileRef,
    source, setSource, sourceRef, setPrimarySource,
    savedSource, setSavedSource, savedSourceRef, setPrimarySaved,
    secondaryFile, secondaryFileRef,
    secondarySource, setSecondarySource, secondarySourceRef, setSecondarySourceLive,
    secondarySavedSource, setSecondarySavedSource, secondarySavedRef, setSecondarySaved,
    activeAsset, activeAssetRef, showActiveAsset,
    secondaryAsset, secondaryAssetRef, showSecondaryAsset,
    activePaper, setActivePaper, activePaperPath, activePaperDirty,
    paperMarkdown, setPaperMarkdown, paperMarkdownRef, savedPaperMarkdown, savedPaperMarkdownRef,
    paperBlog, setPaperBlog, paperBlogRef, savedPaperBlog, savedPaperBlogRef, markPaperSaved,
    paperView, setPaperView, paperSide, setPaperSide,
    commitPrimaryText, commitSecondaryText, commitOpenText, commitCleanOpenText,
    showPrimaryText, showSecondaryText, clearSecondaryPane,
    setPaperBuffers, closePaper, paperBuffersDirty, remapOpenPaths,
  } = buffers;
  const [tutorialActive, setTutorialActive] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const autoTutorialAttemptedRef = useRef(false);
  /** A toolbar action the guided tour points at but must not open while it runs. */
  const outsideTour = (action: () => void) => () => {
    if (!tutorialActive) action();
  };
  const [postStartupInteraction, setPostStartupInteraction] = useState(false);
  const {
    workspaceIndex,
    cancelPreviewPrewarm,
    prewarmLikelyProjectFile,
    prewarmLikelyPaper,
  } = usePreviewPrewarm(project, projectRef, { activeFile, activePaperId: activePaper?.arxivId, paperView });
  const fileLoadGenerationRef = useRef(0);
  // Set as soon as a Paper intent reserves the primary surface, including the
  // network-fetch phase before openPaper starts. A later local-file intent in
  // the secondary pane can then cancel that pending whole-canvas replacement
  // instead of letting it unexpectedly collapse the user's split workspace.
  const paperLoadGenerationRef = useRef<number | null>(null);
  const secondaryFileLoadGenerationRef = useRef(0);
  const documentViewGenerationRef = useRef(0);
  const overleafSyncingRef = useRef(false);
  /** Resolves when the in-flight Overleaf sync has finished its disk refresh. */
  const overleafSyncSettledRef = useRef<Promise<void> | null>(null);
  const resolveOverleafSyncRef = useRef<(() => void) | null>(null);
  const visualMarkdownFlushRef = useRef<(() => boolean) | null>(null);
  const agentCommentsOptionsRef = useRef<(() => BuildAgentCommentsOptions | null) | null>(null);
  const saveBeforeProjectTransitionRef = useRef<() => Promise<boolean>>(async () => true);
  const flushWholeFilesBeforeProjectTransitionRef = useRef<() => Promise<void>>(async () => {});
  const hasLateProjectTransitionEditRef = useRef<() => boolean>(() => false);
  const [primaryOpening, setPrimaryOpening] = useState<{
    generation: number;
    label: string;
  } | null>(null);
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
  const [focusedPane, setFocusedPane] = useState<EditorPaneId>("primary");
  const [editorCompletionActive, setEditorCompletionActive] = useState(false);
  const editorCompletionActiveRef = useRef(false);
  const [dualRatioResetGeneration, setDualRatioResetGeneration] = useState(0);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("split");
  const [dualPanePreview, setDualPanePreview] = useState<{
    projectRoot: string;
    primaryPath: string | null;
    secondaryPath: string | null;
  } | null>(null);
  const [editorPosition, setEditorPosition] = useState<EditorPosition | null>(null);
  // Read by the presence hook, which must not re-subscribe on every keystroke.
  const editorPositionRef = useRef<EditorPosition | null>(null);
  editorPositionRef.current = editorPosition;
  const forwardSyncGenerationRef = useRef(0);
  const outlineSyncGenerationRef = useRef(0);
  const [pdfSyncTarget, setPdfSyncTarget] = useState<PdfSyncTarget | null>(null);
  const [locatingPdf, setLocatingPdf] = useState(false);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const openTabsRef = useRef<string[]>([]);
  useLayoutEffect(() => { openTabsRef.current = openTabs; }, [openTabs]);
  const [pinnedTabs, setPinnedTabs] = useState<string[]>([]);
  const pinnedTabsRef = useRef<string[]>([]);
  useLayoutEffect(() => { pinnedTabsRef.current = pinnedTabs; }, [pinnedTabs]);
  const addOpenTab = useCallback((path: string) => {
    setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
  }, []);
  const [workspacePersistenceReadyRoot, setWorkspacePersistenceReadyRoot] = useState<string | null>(null);
  const pendingWorkspaceSurfaceRef = useRef<{
    root: string;
    activeTab: string;
    canvasMode: CanvasMode;
    paperView: "blog" | "fulltext";
  } | null>(null);
  const projectAssetPaths = useMemo(
    () => collectAssetPaths(project?.files ?? []),
    [project],
  );
  // Most-recently-active tab key first; drives LRU eviction over the max-tabs cap.
  const tabRecency = useRef<string[]>([]);
  const noteTabActive = useCallback((key: string) => {
    tabRecency.current = [key, ...tabRecency.current.filter((existing) => existing !== key)];
  }, []);
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
  const [navStack, setNavStack] = useState<NavigationEntry[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  const navLock = useRef(false);
  const {
    statesRef: viewStateRef, get: getFileViewState, remember: rememberFileViewState, allow: allowViewState,
    drop: dropViewState, forget: forgetViewStates, remap: remapViewStates, loadForProject: loadViewStatesForProject,
  } = useFileViewStates(project?.root ?? null, projectRef, projectBeforeTransitionRef);
  const [canvasRequests, setCanvasRequests] = useState<CanvasRequests>({
    navigation: null, restore: null, rename: null, wrap: null, cite: null, figure: null,
  });
  /** Post, clear or rewrite one pending canvas request (a value or an updater, like a state setter). */
  const updateCanvasRequest = useCallback(<K extends keyof CanvasRequests>(
    kind: K,
    update: CanvasRequests[K] | ((current: CanvasRequests[K]) => CanvasRequests[K]),
  ) => setCanvasRequests((requests) => {
    const next = typeof update === "function" ? update(requests[kind]) : update;
    return next === requests[kind] ? requests : { ...requests, [kind]: next };
  }), []);
  const settleCanvasRequest = useCallback((id: string) => setCanvasRequests((requests) => {
    const kind = (Object.keys(requests) as (keyof CanvasRequests)[]).find((key) => requests[key]?.id === id);
    return kind ? { ...requests, [kind]: null } : requests;
  }), []);
  const setViewRestore = useCallback((update: SetStateAction<ViewRestoreRequest | null>) => {
    updateCanvasRequest("restore", update);
  }, [updateCanvasRequest]);
  const [tableGeneratorOpen, setTableGeneratorOpen] = useState(false);
  const projectSearch = useProjectSearch();
  const { openFind: openProjectFind, openReplace: openProjectReplace } = projectSearch;
  const semanticSearch = useLocalSemanticSearch(project?.root, projectRef);
  const { requestReindex: requestSemanticReindex } = semanticSearch;
  const [searchDialog, setSearchDialog] = useState<SearchDialog | null>(null);
  const openCompileDiagnosticRef = useRef<(diagnostic: CompileDiagnostic) => Promise<void>>(async () => undefined);
  const activePaperSource = paperView === "blog" ? paperBlog ?? "" : paperMarkdown;
  const activePaperPreviewSource = paperView === "blog"
    ? paperBlog ?? ""
    : stripFrontmatter(paperMarkdown);
  const setActivePaperSource = useCallback((value: string) => {
    if (paperView === "blog") {
      paperBlogRef.current = value;
      setPaperBlog(value);
    } else {
      paperMarkdownRef.current = value;
      setPaperMarkdown(value);
    }
  }, [paperBlogRef, paperMarkdownRef, paperView, setPaperBlog, setPaperMarkdown]);
  const changePaperView = useCallback((view: "blog" | "fulltext") => {
    if (view === paperView) return;
    // Blog and full text are distinct editable documents. Publish the old
    // NodeView while its path still owns the callback, then change identity.
    if (visualMarkdownFlushRef.current?.() === false) return;
    setPaperView(view);
  }, [paperView, setPaperView]);
  const [nativeEditorDropActive, setNativeEditorDropActive] = useState(false);
  const [fileDropTargetPane, setFileDropTargetPane] = useState<EditorPaneId | null>(null);
  const [projectFileDropPreview, setProjectFileDropPreview] = useState<EditorDropPreview | null>(null);
  const [agentPanelDropActive, setAgentPanelDropActive] = useState(false);
  const [figurePointerDrag, setFigurePointerDrag] = useState<FigurePointerDrag | null>(null);
  const nativeDragPathsRef = useRef<string[]>([]);
  const suppressedFigureClick = useRef<string | null>(null);
  const suppressedProjectFileClick = useRef<string | null>(null);
  const openMarkdownProjectPathRef = useRef<(path: string) => void>(() => undefined);
  const markdownModeViewportCaptureRef = useRef<(() => void) | null>(null);
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
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const dualPreview = isTwoPane(canvasMode) && dualPanePreview?.projectRoot === project?.root ? dualPanePreview : null;
  const dualPreviewPanes = {
    primary: Boolean(dualPreview && dualPreview.primaryPath === activeFile),
    secondary: Boolean(dualPreview && secondaryFile && dualPreview.secondaryPath === secondaryFile),
  };
  const focusedPanePreview = focusedPane === "secondary" ? dualPreviewPanes.secondary : dualPreviewPanes.primary;
  // A reverse SyncTeX jump needs a pane that still holds an editor. Both panes
  // previewing, or the only other pane holding an asset, leaves nowhere to land.
  const canRevealPdfSource = dualPreviewPanes.primary
    ? !dualPreviewPanes.secondary && Boolean(secondaryFile) && !secondaryAsset
    : !dualPreviewPanes.secondary || !activeAsset;
  const focusedAsset = isTwoPane(canvasMode) && focusedPane === "secondary" ? secondaryAsset : activeAsset;
  const paperFocused = Boolean(activePaper && focusedPane === "primary");
  const focusedDocumentPath = focusedPane === "secondary" && secondaryFile ? secondaryFile : activeFile;
  const canInsert = canvasMode !== "pdf"
    && !paperFocused
    && !focusedAsset
    && /\.(?:tex|sty|cls|txt)$/i.test(focusedDocumentPath);
  useEffect(() => {
    // A drawer opened against one editor must not survive after its insertion
    // target disappears; otherwise it reopens stale when that view returns.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- capability loss invalidates this transient UI state
    if (!canInsert && insertOpen) setInsertOpen(false);
  }, [canInsert, insertOpen]);
  const [collabSession, setCollabSession] = useState<EditorCollabSession | null>(null);
  const [collabCanWrite, setCollabCanWrite] = useState(true);
  const [activeCollabVersion, setActiveCollabVersion] = useState<2 | null>(null);
  // True only after the shared doc has been seeded (host) / materialized (guest).
  // The editor must not bind yCollab before this: binding early makes the guest
  // create a competing main.tex Y.Text that loses the map key to the host's copy,
  // orphaning the editor on the "Waiting for shared project files" placeholder.
  const [collabReady, setCollabReady] = useState(false);
  /** Bumped whenever a save actually writes, so pushes follow real edits. */
  const [saveGeneration, setSaveGeneration] = useState(0);
  const saveActivityRef = useRef({ pending: 0, generation: 0 });
  const savedPathsRef = useRef(new Set<string>());
  const recordSavedPaths = useCallback((paths: readonly string[]) => {
    if (!paths.length) return;
    for (const path of paths) savedPathsRef.current.add(path);
    setSaveGeneration((generation) => generation + 1);
  }, []);
  const collabSessionRef = useRef<EditorCollabSession | null>(null);
  const collabV2ControllerRef = useRef<CollabProjectControllerV2 | null>(null);
  const collabWorkspaceLeaseRef = useRef<CollabWorkspaceLease | null>(null);
  const collabDiskWriteQueueRef = useRef(new CollabDiskWriteQueue());
  const collabPathMutationGenerationRef = useRef(new Map<string, number>());
  const collabPathMutationGeneration = useCallback((path: string) => collabPathMutationGenerationRef.current.get(path) ?? 0, []);
  const collabDetachRef = useRef<(() => void) | null>(null);
  const projectRootRef = useRef<string | null>(null);
  const agentProjectDocumentCreatorRef = useRef<((
    request: AgentProjectDocumentToolRequest,
  ) => Promise<string>) | null>(null);
  const enterProjectRef = useRef<((
    snapshot: ProjectSnapshot,
    options?: { skipCollabLifecycle?: boolean; deferInitialBuild?: boolean },
  ) => Promise<void>) | null>(null);
  const compileRef = useRef<(
    force?: boolean,
    sound?: boolean,
    options?: { consumeAgentAssociations?: boolean },
  ) => Promise<void>>(async () => undefined);
  const externalOverleafEditsRef = useRef<(paths: readonly string[]) => void>(() => {});
  const htmlViewModesRef = useRef(new Map<string, DocumentViewMode>());
  const documentModeRef = useRef<DocumentViewMode>("split");
  // Split still consumes the whole canvas. When it is requested from the
  // secondary pane, temporarily promote that file and restore pane ownership
  // when the user returns to Edit.
  const temporarilyPromotedSplitRef = useRef<{
    projectRoot: string;
    primaryPath: string;
    splitPath: string;
  } | null>(null);
  // A standalone file (for example the bibliography) can hide a two-file
  // layout. Remember its ownership so either member restores the same pair,
  // rather than loading the right-hand file into both panes.
  const textSplitRef = useRef<{
    projectRoot: string;
    primaryPath: string;
    secondaryPath: string;
    mode: "dual" | "columns";
  } | null>(null);
  useLayoutEffect(() => {
    if (
      !secondaryFile
      || textSplitRef.current?.projectRoot !== project?.root
      || !openTabs.includes(textSplitRef.current?.primaryPath ?? "")
    ) textSplitRef.current = null;
    if (
      project && !activePaper && !activeAsset && !secondaryAsset
      && activeFile && secondaryFile && activeFile !== secondaryFile
      && isTwoPane(canvasMode)
    ) {
      textSplitRef.current = {
        projectRoot: project.root, primaryPath: activeFile,
        secondaryPath: secondaryFile, mode: canvasMode,
      };
    }
  }, [activeAsset, activeFile, activePaper, canvasMode, openTabs, project, secondaryAsset, secondaryFile]);
  useEffect(() => {
    if (
      !activePaper
      && !activeAsset
      && activeFile
      && isPreviewableSourceFilePath(activeFile)
      && !isHtmlFilePath(activeFile)
      && (canvasMode === "source" || canvasMode === "split" || canvasMode === "pdf")
    ) {
      documentModeRef.current = canvasMode;
    }
  }, [activeAsset, activeFile, activePaper, canvasMode]);
  collabSessionRef.current = collabSession;
  useEffect(() => {
    setCollabCanWrite(collabSession?.canWrite !== false);
    return collabSession?.subscribeCanWrite?.(setCollabCanWrite);
  }, [collabSession]);
  projectRootRef.current = project?.root ?? null;
  useEffect(() => registerAgentSpreadsheetDocumentResolver(async (path) => {
    const controller = collabV2ControllerRef.current;
    if (activeCollabVersion === 2) {
      // A live shared project is catalog-authoritative. Falling through to the
      // local filesystem for an unshared or differently-typed path would let
      // the Agent create edits that collaborators can never receive.
      if (!controller) return null;
      if (!controller.hasSpreadsheetPath(path)) return null;
      await controller.openPath(path, "secondary", { sideload: true });
      const binding = controller.spreadsheetDocumentForPath(path);
      if (!binding) return null;
      return {
        doc: binding.doc,
        canWrite: binding.canWrite && collabCanWrite,
        awareness: binding.awareness,
        path,
        commit: async () => {
          await controller.settled();
          await controller.flush();
        },
      };
    }

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
  }), [activeCollabVersion, collabCanWrite, recordSavedPaths]);
  /** Insert `\cite{key}`/`\ref{key}` at the caret, bringing an editor on screen first. */
  const insertCitation = useCallback((key: string, command: InsertSymbolCommand) => {
    updateCanvasRequest("cite", { key, command, id: crypto.randomUUID() });
    setCanvasMode((mode) => (mode === "pdf" || mode === "asset" ? "split" : mode));
  }, [updateCanvasRequest]);
  const [bibliographyAuditRoot, setBibliographyAuditRoot] = useState<string | null>(null);
  const [bibliographyAuditOpen, setBibliographyAuditOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const closedTabsRef = useRef<string[]>([]);
  /**
   * Retire every tab-strip and navigation reference to the paths `gone`
   * matches, including pending canvas requests, and return the surviving tabs
   * and recency. Deletes do this before any refresh await so autosave cannot
   * recreate a deleted buffer and a background tab cannot reopen a missing file.
   */
  const forgetOpenPaths = useCallback((gone: (path: string) => boolean) => {
    const tabs = openTabsRef.current.filter((tab) => !gone(tab));
    const recency = tabRecency.current.filter((tab) => !gone(tab));
    openTabsRef.current = tabs;
    tabRecency.current = recency;
    closedTabsRef.current = closedTabsRef.current.filter((tab) => !gone(tab));
    setOpenTabs(tabs);
    setPinnedTabs((pinned) => pinned.filter((tab) => !gone(tab)));
    setNavStack((entries) => entries.filter((entry) => !gone(entry.path)));
    updateCanvasRequest("restore", (request) => request && gone(request.path) ? null : request);
    updateCanvasRequest("navigation", (request) => request && gone(request.path) ? null : request);
    return { tabs, recency };
  }, [updateCanvasRequest]);
  const [outlineSources, setOutlineSources] = useState<Record<string, string>>({});
  const [referenceHits, setReferenceHits] = useState<{
    kind: "label" | "citation";
    symbol: string;
    occurrences: SymbolOccurrence[];
  } | null>(null);
  const sidebar = useWorkspaceSidebar(project?.root);
  const {
    sidebarOpen, setSidebarOpen, sidebarWidth, sidebarDragWidth, sidebarResizing,
    sidebarCollapsePreview, sidebarRestoring, sidebarRebounding, finishSidebarRestore,
    fitSidebarToContent,
    agentDocked, setAgentDocked, sidebarMode, setSidebarMode,
  } = sidebar;
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [boardCreateRequest, setBoardCreateRequest] = useState(0);
  const [spreadsheetCreateRequest, setSpreadsheetCreateRequest] = useState(0);
  const [presentationCreateRequest, setPresentationCreateRequest] = useState(0);
  const [openSlideContext, setOpenSlideContext] = useState<OpenSlideContext | null>(null);
  // Reading only suppresses the dock; its preference and live iframe survive.
  // Non-previewable editors can retain the previous document's canvasMode.
  const readingOnly = Boolean(activePaper)
    || (canvasMode === "pdf" && isPreviewableSourceFilePath(activeFile))
    || (canvasMode === "asset" && /\.pdf$/i.test(activeAsset?.path ?? ""));
  const agentVisible = agentDocked ? !readingOnly : sidebarOpen && sidebarMode === "agent";
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
      },
      clearSelection: () => agentContext.dismissSelection(),
      flushVisualMarkdown: () => {
        visualMarkdownFlushRef.current?.();
      },
      agentCommentsOptions: () => agentCommentsOptionsRef.current?.() ?? null,
      projectDocumentCreator: () => agentProjectDocumentCreatorRef.current,
      onHistorySnapshot: (snapshot) => agentCheckpoints.handleSnapshot(snapshot),
      onMinimumSidebarWidth: sidebar.setMinimumSidebarWidth,
    },
  });
  const {
    origin: synaraOrigin, sourceControlFrameRef: synaraSourceControlFrameRef, postMessage: postSynaraMessage,
    requestRuntime: requestSynaraRuntime,
  } = synara;
  const [buildPreferences, setBuildPreferences] = useState<BuildPreferences>(loadBuildPreferences);
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
    secondarySourceRef,
    agent: agentCheckpoints,
    openDiagnosticRef: openCompileDiagnosticRef,
    onMissingTex: texSetup.openForMissingTex,
  });
  const { build, setBuild, building, cleaning, pdfUrl, runBuild, abortBuild, cleanProject, cleanAndRebuild, resetForProject } = buildPipeline;
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
    fileLoadGenerationRef.current += 1;
    secondaryFileLoadGenerationRef.current += 1;
    resetAgentCompileTracking(true);
    cancelPreviewPrewarm();
    setPrimaryOpening(null);
    return true;
  }, [cancelPreviewPrewarm, projectState, resetAgentCompileTracking]);
  // Forward SyncTeX starts from a .tex caret in a pane that is an editor, not a preview or an asset.
  const forwardSyncPosition = editorPosition && pdfUrl && editorPosition.path.toLocaleLowerCase().endsWith(".tex") && (
    isTwoPane(canvasMode)
      ? (editorPosition.path === activeFile && !activeAsset && !dualPreviewPanes.primary)
        || (editorPosition.path === secondaryFile && !secondaryAsset && !dualPreviewPanes.secondary)
      : (canvasMode === "split" || canvasMode === "pdf") && !activeAsset && editorPosition.path === activeFile
  ) ? editorPosition : null;
  const agentContext = useAgentContext({
    synara, project, papers, agentVisible,
    workspace: {
      activeFile, secondaryFile, activePaper, activePaperPath, canvasMode, paperView, editorPosition,
      pdfPage: pdfPageNumber, pdfPageCount, presentation: openSlideContext,
    },
  });
  const { resetSelection: resetAgentSelection } = agentContext;
  const chooseSidebarMode = (mode: "project" | "papers" | "agent") => {
    if (mode === "agent") {
      setAgentDocked(false);
      synara.mountFrame();
      synara.notifyPanelOpened();
    }
    setSidebarMode(mode);
    setSidebarOpen(true);
    if (mode === "papers" && (/\.bib$/i.test(activeFile) || /\.bib$/i.test(secondaryFile ?? ""))) {
      void saveRef.current();
    }
    if (tutorialActive && tutorialStep === TUTORIAL_STEPS.openPapers && mode === "papers") {
      setTutorialStep(TUTORIAL_STEPS.papers);
    } else if (tutorialActive && tutorialStep === TUTORIAL_STEPS.openAgent && mode === "agent") {
      setTutorialStep(TUTORIAL_STEPS.agent);
    }
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
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

  const projectGit = useProjectTreeWatch(projectState, sidebarMode === "project");
  const { setGitStatus } = projectGit;
  // Remember the file open per project, so reopening it lands on the last page.
  useEffect(() => {
    if (project?.root && activeFile) persistLastFile(project.root, activeFile);
  }, [project?.root, activeFile]);
  const { theme, themePreference, setThemePreference, appearance, setAppearance } = useAppearance();
  const appLocale = resolveAppLocale(appearance.interfaceLanguage);
  useEffect(() => {
    configureInterfaceSounds(appearance.interfaceSounds);
  }, [appearance.interfaceSounds]);
  useWindowMinimumSize({
    interfaceScale: appearance.interfaceScale,
    minimumSidebarWidth: sidebar.minimumSidebarWidth,
    sidebarOpen,
    canvasMode,
    projectRoot: project?.root,
  });
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
        setNotice("Finishing Overleaf sync, then switching…", "Overleaf");
        await Promise.race([
          settled,
          new Promise<void>((resolve) => window.setTimeout(resolve, PROJECT_SWITCH_SYNC_WAIT_MS)),
        ]);
      }
    }
    // The editor stayed live while Overleaf settled, so publish and durably
    // save any edit (including a just-finished IME composition) made during
    // that wait before invalidating the outgoing project's ownership.
    if (visualMarkdownFlushRef.current?.() === false) {
      setNotice("Finish the current text composition, then switch projects again.");
      return false;
    }
    if (!(await saveBeforeProjectTransitionRef.current())) return false;
    await Promise.race([
      flushWholeFilesBeforeProjectTransitionRef.current(),
      new Promise<void>((resolve) => window.setTimeout(resolve, PROJECT_SWITCH_SYNC_WAIT_MS)),
    ]);
    if (hasLateProjectTransitionEditRef.current()) {
      setNotice("The document changed while saving. Save it, then switch projects again.");
      return false;
    }
    if (beginProjectTransition()) return true;
    setNotice("Overleaf sync is finishing. Try switching projects again in a moment.", "Overleaf");
    return false;
  }, [beginProjectTransition]);

  const [createForm, setCreateForm] = useState<CreateProjectForm>({
    open: false, error: null, name: "Untitled research", venue: "neurips",
  });
  const updateCreateForm = useCallback((update: Partial<CreateProjectForm>) => {
    setCreateForm((form) => ({ ...form, error: null, ...update }));
  }, []);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(loadRecentProjects);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const isFullscreen = useFullscreen();
  const saveTimer = useRef<number | null>(null);
  const automaticBuildPending = useRef(false);
  const automaticBuildQueued = useRef(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const rememberProject = useCallback((snapshot: ProjectSnapshot) => {
    setRecentProjects(rememberRecentProject({ name: snapshot.manifest.name, path: snapshot.root }));
  }, []);

  const projectHistory = useMemo(() => [...history, ...agentCheckpoints.historyItems].sort((left, right) => (
    right.timestamp.localeCompare(left.timestamp)
  )), [agentCheckpoints.historyItems, history]);

  const diskMtimeRef = useRef<number | null>(null);
  const secondaryMtimeRef = useRef<number | null>(null);
  const registerVisualMarkdownFlush = useCallback((flush: (() => boolean) | null) => {
    visualMarkdownFlushRef.current = flush;
  }, []);
  const registerMarkdownModeViewportCapture = useCallback((capture: (() => void) | null) => {
    markdownModeViewportCaptureRef.current = capture;
  }, []);

  /** Publish deferred visual edits, then report whether the primary owner (by default whatever holds it now) is dirty. */
  const flushAndCheckPrimaryDirty = useCallback((owner: "file" | "paper" | "asset" = activePaper ? "paper" : activeAsset ? "asset" : "file") => {
    if (visualMarkdownFlushRef.current?.() === false) return true;
    if (owner === "file") return sourceRef.current !== savedSourceRef.current;
    return owner === "paper" && paperBuffersDirty();
  }, [paperBuffersDirty, savedSourceRef, sourceRef, activeAsset, activePaper]);

  const markDiskMtime = useCallback(async (path: string, mayApply: () => boolean = () => true) => {
    try {
      const stat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", { path });
      if (mayApply()) diskMtimeRef.current = stat.exists ? stat.mtimeMs : null;
    } catch {
      if (mayApply()) diskMtimeRef.current = null;
    }
  }, []);

  const loadFile = useCallback(async (
    path: string,
    options?: {
      restoreView?: boolean;
      revealSource?: boolean;
      expectedProjectRoot?: string;
      projectGeneration?: number;
      /**
       * The v2 controller this load is binding, for a caller that owns the
       * session but has not published it yet. Joining cannot publish first —
       * DocumentCanvas would render against activePath="" and crash in
       * setActivePath — so without this the guest's own load could not tell
       * that the controller in the ref is the live session, took the plain
       * read-from-disk path, and left the share connected but never activated.
       */
      collabController?: CollabProjectControllerV2;
      /**
       * A prerequisite (the previous file's save) the load may overlap with
       * its own disk read but must confirm before committing state. Resolving
       * false — or rejecting — aborts the switch, preserving the old
       * "save failure keeps the current file" semantics without paying
       * write + read serially.
       */
      gate?: Promise<boolean>;
      /** Primary-surface intent reserved by a caller before it awaited save. */
      loadGeneration?: number;
      /** Re-check the old owner's deferred edits immediately before commit. */
      canCommit?: () => boolean;
      /**
       * Where in the freshly loaded file to land. Requesting it here, rather
       * than after this load resolves, keeps the content and the jump in one
       * React commit: setting it afterwards paints the new document at its top
       * first and only scrolls to the line on the next frame, which a SyncTeX
       * jump out of the PDF shows as a flash.
       */
      navigateToLine?: number;
    },
  ) => {
    const loadGeneration = options?.loadGeneration ?? fileLoadGenerationRef.current + 1;
    if (options?.loadGeneration === undefined) fileLoadGenerationRef.current = loadGeneration;
    const projectRoot = options?.expectedProjectRoot ?? projectRef.current?.root;
    const projectGeneration = options?.projectGeneration ?? projectOperationGenerationRef.current;
    const isLatestLoad = () => (
      loadGeneration === fileLoadGenerationRef.current
      && projectOperationGenerationRef.current === projectGeneration
      && projectRef.current?.root === projectRoot
    );
    const previousPath = activeFileRef.current;
    const showLoadedDocument = (content: string) => {
      showPrimaryText(path, content);
      addOpenTab(path);
      closePaper();
      showActiveAsset(null);
      setCanvasMode((mode) => {
        if (isHtmlFilePath(path)) return htmlViewModesRef.current.get(path) ?? "pdf";
        if (isPreviewableSourceFilePath(path)) return documentModeRef.current;
        if (options?.revealSource) return "source";
        if (isHtmlFilePath(previousPath)) return documentModeRef.current;
        if (mode === "asset") return "split";
        return mode;
      });
      if (options?.navigateToLine !== undefined) {
        requestEditorLine(path, options.navigateToLine);
      }
    };
    try {
      const v2 = collabV2ControllerRef.current;
      if (v2?.hasTextPath(path) && (options?.collabController === v2 || activeCollabVersion === 2 || collabSessionRef.current === v2)) {
        // The gate must settle before openPath: activation mutates the
        // controller's activePath, which must not happen for an aborted switch.
        if (options?.gate && !(await options.gate)) return false;
        if (!isLatestLoad() || options?.canCommit?.() === false) return false;
        // cachedFirst: with a server-acked local snapshot the switch shows
        // content immediately and syncs in the background; a cache miss still
        // waits (bounded) so a fresh doc never flashes empty.
        const ytext = await v2.openPath(path, "main", {
          activateIf: () => isLatestLoad() && (options?.canCommit?.() ?? true),
          cachedFirst: true,
          timeoutMs: 8_000,
        });
        if (!isLatestLoad() || options?.canCommit?.() === false) return false;
        const content = ytext.toString();
        showLoadedDocument(content);
        setCollabSession(v2);
        setCollabReady(true);
        collabDetachRef.current?.();
        const writeRemote = (remote: string) => {
          const lease = collabWorkspaceLeaseRef.current;
          if (!lease?.isCurrent()) return;
          const generation = collabPathMutationGeneration(path);
          void collabDiskWriteQueueRef.current.run(lease, path, () => generation === collabPathMutationGeneration(path)
            ? invoke("write_project_file", { path, content: remote, projectRoot: lease.projectRoot })
            : Promise.resolve())
            .then(() => { if (lease.isCurrent() && generation === collabPathMutationGeneration(path)) setSavedSource(remote); })
            .catch((reason) => { if (lease.isCurrent()) setError(toMessage(reason)); });
        };
        if (path.toLocaleLowerCase().endsWith(".tldr") || isSpreadsheetPath(path)) {
          // The v2 controller owns structured-document materialization for
          // both local and remote edits; a second observer duplicates writes.
          collabDetachRef.current = null;
        } else {
          const onText = (_event: unknown, transaction: { local: boolean }) => {
            if (transaction.local) return;
            writeRemote(ytext.toString());
          };
          ytext.observe(onText);
          collabDetachRef.current = () => ytext.unobserve(onText);
        }
        // Purely bookkeeping for the external-change detector; nothing below
        // depends on it, so don't hold the switch on a stat round trip
        // (mayApply already discards stale completions).
        void markDiskMtime(path, isLatestLoad);
        return isLatestLoad();
      }
      const [content, gateOk] = await Promise.all([
        invoke<string>("read_project_file", { path, projectRoot }),
        options?.gate ?? Promise.resolve(true),
      ]);
      if (!gateOk || !isLatestLoad() || options?.canCommit?.() === false) return false;
      showLoadedDocument(content);
      setError(null);
      // Where you last were in this file, unless the caller is about to send
      // you somewhere specific in it. Both land as requests the editor answers
      // on the next frame, and the restore is applied second, so asking for
      // both means the remembered position quietly wins and the jump is lost.
      const saved = options?.restoreView === false ? undefined : viewStateRef.current.get(path)?.text;
      if (saved) {
        setViewRestore({ path, cursor: saved.cursor, scrollTop: saved.scrollTop, id: crypto.randomUUID() });
      }
      // The restore used to wait behind this stat; it has no bearing on
      // cursor or scroll, so let it land whenever it lands (mayApply already
      // discards stale completions).
      void markDiskMtime(path, isLatestLoad);
      return true;
    } catch (reason) {
      // A document torn down while this load was still awaiting it — closing
      // the file, switching away, ending the share — is how a client's life
      // normally ends, so it is not something to put on screen.
      if (isLatestLoad() && !isClientDestroyedErrorV2(reason)) setError(toMessage(reason));
      return false;
    }
  }, [
    activeCollabVersion, activeFileRef, addOpenTab, closePaper, collabPathMutationGeneration, markDiskMtime,
    projectOperationGenerationRef, projectRef, requestEditorLine, setSavedSource, showActiveAsset,
    showPrimaryText, viewStateRef, setViewRestore,
  ]);

  useLeavePresenceOnClose(collabV2ControllerRef);

  const handleRemoteCollabDeleteV2 = useCallback(async (
    path: string,
    lease: CollabWorkspaceLease,
    deleteFromDisk: () => Promise<void>,
  ) => {
    if (!lease.isCurrent()) return;
    collabPathMutationGenerationRef.current.set(path, collabPathMutationGeneration(path) + 1);
    const controller = collabV2ControllerRef.current;
    const deletedActive = activeFileRef.current === path;
    dropViewState(path);
    const remaining = forgetOpenPaths((candidate) => candidate === path);
    if (secondaryFileRef.current === path) {
      showSecondaryText(null);
      setFocusedPane("primary");
    }
    if (deletedActive) {
      // Fence the stale buffer before any refresh await. Otherwise autosave can
      // recreate a path the shared catalog has authoritatively deleted.
      collabDetachRef.current?.();
      collabDetachRef.current = null;
      showPrimaryText("", "");
    }

    await deleteFromDisk();
    const projectGeneration = projectOperationGenerationRef.current;
    const snapshot = await refreshProject({ expectedRoot: lease.projectRoot, generation: projectGeneration });
    if (!lease.isCurrent() || collabV2ControllerRef.current !== controller || !deletedActive) return;
    const { replacement } = planRemoteCollabDeleteUiV2({
      path,
      activeFile: path,
      secondaryFile: null,
      openTabs: remaining.tabs,
      tabRecency: remaining.recency,
      liveTextPaths: controller?.catalogTextPaths() ?? [],
      preferredPaths: [
        ...snapshot.manifest.rootDocuments.filter((document) => document.isDefault).map((document) => document.path),
        ...snapshot.manifest.rootDocuments.map((document) => document.path),
      ],
    });
    if (replacement) {
      await loadFile(replacement, {
        restoreView: false,
        expectedProjectRoot: lease.projectRoot,
        projectGeneration: projectOperationGenerationRef.current,
      });
    } else {
      setNotice("The open file was deleted by a collaborator; this share has no other text file to open.");
    }
  }, [
    activeFileRef, collabPathMutationGeneration, dropViewState, loadFile, projectOperationGenerationRef,
    refreshProject, secondaryFileRef, showSecondaryText, forgetOpenPaths, showPrimaryText,
  ]);

  /**
   * Disk callbacks for a v2 workspace: initial materialization plus peer tree
   * reconciliation (create/rename/delete pulled from the catalog event stream).
   * Rename covers arbitrary path changes by composing move + rename.
   */
  const v2WorkspaceCallbacks = useCallback((lease: CollabWorkspaceLease): SharedWorkspaceDisk => ({
    writeText: (path, content, projectRoot) => {
      const generation = collabPathMutationGeneration(path);
      return collabDiskWriteQueueRef.current.run(lease, path, async () => {
        if (generation !== collabPathMutationGeneration(path)) return;
        await invoke("write_project_file", { path, content, projectRoot });
        if (isWholeFileEditorPath(path) && !overleafSyncingRef.current) {
          recordSavedPaths([path]);
        }
      });
    },
    writeBytes: (path, bytes, projectRoot) => {
      const generation = collabPathMutationGeneration(path);
      return collabDiskWriteQueueRef.current.run(lease, path, () => generation === collabPathMutationGeneration(path) ? invoke("write_project_bytes", { path, base64Data: bytesToBase64(bytes), projectRoot }) : Promise.resolve());
    },
    delete: (path, projectRoot) => handleRemoteCollabDeleteV2(path, lease, () => (
      collabDiskWriteQueueRef.current.run(lease, path, () => invoke("delete_project_entry", { path, projectRoot }))
    )),
    rename: (oldPath, newPath, projectRoot) => collabDiskWriteQueueRef.current.run(lease, oldPath, async () => {
      const directoryOf = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const nameOf = (path: string) => path.split("/").pop() ?? path;
      let current = oldPath;
      if (directoryOf(oldPath) !== directoryOf(newPath)) {
        current = await invoke<string>("move_project_entry", { path: current, targetDirectory: directoryOf(newPath), projectRoot });
      }
      if (nameOf(current) !== nameOf(newPath)) {
        current = await invoke<string>("rename_project_entry", { path: current, newName: nameOf(newPath), projectRoot });
      }
      return current;
    }),
  }), [collabPathMutationGeneration, handleRemoteCollabDeleteV2, recordSavedPaths]);

  // ---- Lattice Share (Yjs v2) ----------------------------------------------
  // Room state and the whole start / join / leave / close lifecycle live in
  // `src/app/use-collab-v2-session.ts`. The call sits here, below `loadFile`
  // and `v2WorkspaceCallbacks`, because both of those bind the editor and its
  // buffers to shared documents and therefore have to stay in App.
  const collab = useCollabV2Session({
    project, projectRef, projectRootRef, projectOperationGenerationRef, activeFile, recentProjects,
    editorCommentAuthorId, activeCollabVersion, setActiveCollabVersion, collabSession, setCollabSession,
    collabSessionRef, setCollabReady, collabV2ControllerRef, collabWorkspaceLeaseRef, collabDiskWriteQueueRef,
    collabPathMutationGeneration, collabDetachRef, enterProjectRef, setBusyLabel, startProjectTransition,
    cancelProjectTransition, refreshProject, loadFile, v2WorkspaceCallbacks,
  });
  const {
    setCollabOpen, collabRoom, setCollabRoom, collabInvite, collabName, setCollabProjectName,
    refreshRecentRooms, collabStatus, setCollabStatus, collabPeerList, setCollabPeerList, collabPeers,
    collabFileCount, setCollabFileCount, setCollabRole, collabRoleRef, collabWorkspaceGenerationRef,
    preCollabProjectRootRef, clearCollabLocalState, bindJoinedDocument, handleV2PermanentError,
    settleCollabBeforeProjectSwitch, mapV2Status, handleV2Catalog, publishTextToCollabV2,
    shareCreatedFileWithCollabV2, openCollabDialog,
  } = collab;

  const externalEditConflictMessage = useCallback(
    (path: string) => t({ message: `Kept overlapping external edits in ${path} with conflict markers.` }),
    [t],
  );

  const saveContents = useCallback(async (): Promise<boolean> => {
    if (!project) return true;
    try {
      const workspaceLease = collabSession ? collabWorkspaceLeaseRef.current : null;
      const primaryPath = activeFileRef.current;
      const primarySource = sourceRef.current;
      const primarySavedSource = savedSourceRef.current;
      const secondaryPath = secondaryFileRef.current;
      const currentSecondarySource = secondarySourceRef.current;
      const currentSecondarySavedSource = secondarySavedRef.current;
      const paperBuffers = [
        ["fulltext", paperMarkdownRef.current, savedPaperMarkdownRef.current],
        ["blog", paperBlogRef.current, savedPaperBlogRef.current],
      ] as const;
      const writtenPaths: string[] = [];
      /** Writes an editor buffer, through the share's disk queue when one is live. */
      const writeEditorText = (path: string, content: string, baseContent: string, mutationGeneration: number) => {
        const write = () => invoke<EditorWriteResult>("write_project_file", {
          path,
          content,
          baseContent,
          projectRoot: workspaceLease?.projectRoot ?? project.root,
        });
        return workspaceLease
          ? collabDiskWriteQueueRef.current.run<EditorWriteResult | undefined>(workspaceLease, path, () => (
            mutationGeneration === collabPathMutationGeneration(path) ? write() : Promise.resolve(undefined)
          ))
          : write();
      };
      const formatForSave = (path: string, content: string) => (
        /\.bib$/i.test(path) ? formatBibDocument(content) : content
      );
      const mergeIntoActiveYText = (path: string, content: string) => {
        if (activeCollabVersion === 2 && collabSessionRef.current?.activePath === path) {
          mergeTextIntoYText(collabSessionRef.current.ytext, content);
        }
      };
      if (!activePaper && !activeAsset && primaryPath && primarySource !== primarySavedSource) {
        const mutationGeneration = collabPathMutationGeneration(primaryPath);
        const content = formatForSave(primaryPath, primarySource);
        // Format before awaiting disk I/O: subsequent typing must remain a dirty
        // edit, not be replaced by the formatted snapshot when the write returns.
        if (content !== primarySource) {
          mergeIntoActiveYText(primaryPath, content);
          setPrimarySource(content);
        }
        const writeResult = await writeEditorText(primaryPath, content, primarySavedSource, mutationGeneration);
        if (mutationGeneration !== collabPathMutationGeneration(primaryPath)) return true;
        const writtenSource = writeResult?.content ?? content;
        if (writtenSource !== content && activeFileRef.current === primaryPath && sourceRef.current === content) {
          mergeIntoActiveYText(primaryPath, writtenSource);
          setPrimarySource(writtenSource);
        }
        if (writeResult?.hadConflicts) setWarning(externalEditConflictMessage(primaryPath));
        // Do NOT push the active buffer into Yjs here. It is already synced
        // character-by-character by yCollab. Re-publishing it as a full
        // delete+insert of the whole Y.Text on every autosave collapses remote
        // carets and bounces recompiles between peers (the "cursors freeze /
        // PDF re-renders forever" bug). Only formatting and a backend three-way
        // merge are applied above because those edits never reached Yjs.
        setPrimarySaved(writtenSource);
        if (activeCollabVersion === 2) await collabV2ControllerRef.current?.settled();
        // Force the detector to inspect the next filesystem version. An Agent
        // may finish another atomic write after the backend response but before
        // a post-save stat; recording that newer mtime without reading it would
        // hide the Agent edit indefinitely.
        diskMtimeRef.current = -1;
        writtenPaths.push(primaryPath);
      }
      if (secondaryPath && currentSecondarySource !== currentSecondarySavedSource
        && secondaryFileRef.current === secondaryPath && secondarySourceRef.current === currentSecondarySource) {
        const mutationGeneration = collabPathMutationGeneration(secondaryPath);
        const content = formatForSave(secondaryPath, currentSecondarySource);
        if (content !== currentSecondarySource) setSecondarySourceLive(content);
        // A visible secondary text editor has its own yCollab binding. Its
        // Y.Text is already current, so saving mirrors that buffer to disk
        // without replacing a concurrently edited shared span.
        const secondaryBinding = activeCollabVersion === 2
          ? await collabV2ControllerRef.current?.openSecondaryPath(secondaryPath)
          : null;
        if (content !== currentSecondarySource && secondaryBinding && secondarySourceRef.current === content) {
          mergeTextIntoYText(secondaryBinding.ytext, content);
        }
        const writeResult = await writeEditorText(secondaryPath, content, currentSecondarySavedSource, mutationGeneration);
        if (mutationGeneration !== collabPathMutationGeneration(secondaryPath)) return true;
        const writtenSource = writeResult?.content ?? content;
        const secondaryUnchanged = secondaryFileRef.current === secondaryPath && secondarySourceRef.current === content;
        if (activeCollabVersion === 2 && secondaryUnchanged) {
          if (secondaryBinding) mergeTextIntoYText(secondaryBinding.ytext, writtenSource);
          else await publishTextToCollabV2(secondaryPath, writtenSource, mutationGeneration);
          await collabV2ControllerRef.current?.settled();
        }
        if (writtenSource !== content && secondaryUnchanged) setSecondarySourceLive(writtenSource);
        if (writeResult?.hadConflicts) setWarning(externalEditConflictMessage(secondaryPath));
        // The project-transition late-edit check runs in the same async turn
        // as this save, before React is guaranteed to commit the state setter.
        setSecondarySaved(writtenSource);
        secondaryMtimeRef.current = -1;
        writtenPaths.push(secondaryPath);
      }
      for (const [view, content, savedContent] of activePaper ? paperBuffers : []) {
        if (content === null || content === savedContent) continue;
        const path = paperDocumentPath(activePaper!.arxivId, view);
        if (!(await publishTextToCollabV2(path, content))) {
          await invoke("write_project_file", { path, content, projectRoot: project.root });
        }
        markPaperSaved(view, content);
        writtenPaths.push(path);
      }
      if (!writtenPaths.length) return true;
      recordSavedPaths(writtenPaths);
      // Saving must only wait for durable writes. The derived sidebars are
      // useful, but making file switches and builds wait on six independent
      // project scans turned every save into a visible pause.
      refreshAfterSave(
        project.root,
        writtenPaths.some((path) => path.endsWith(".tex")),
        writtenPaths.some((path) => /\.bib$/i.test(path)),
      );
      if (writtenPaths.some((path) => /\.(?:md|mdx|tex)$/i.test(path))) requestSemanticReindex();
      return true;
    } catch (reason) {
      // Autosave runs constantly, so this path gets a plain notification rather
      // than a `logAction` trace — a start line per keystroke pause would bury
      // everything else in the log.
      notifyError("Save", `Could not save ${activeFile || "the project"}`, { detail: toMessage(reason) });
      return false;
    }
  }, [
    activeAsset, activeCollabVersion, activeFile, activeFileRef, activePaper, collabPathMutationGeneration,
    collabSession, externalEditConflictMessage, markPaperSaved, paperBlogRef, paperMarkdownRef, project,
    publishTextToCollabV2, recordSavedPaths, refreshAfterSave, requestSemanticReindex, savedPaperBlogRef,
    savedPaperMarkdownRef, savedSourceRef, secondaryFileRef, secondarySavedRef, secondarySourceRef,
    setPrimarySaved, setPrimarySource, setSecondarySaved, setSecondarySourceLive, sourceRef,
  ]);
  // Keep activity tracking outside the save body: React Compiler cannot lower
  // try/finally, while Promise.finally still covers every early return/error.
  const save = useCallback((): Promise<boolean> => {
    saveActivityRef.current.pending += 1;
    saveActivityRef.current.generation += 1;
    return saveContents().finally(() => { saveActivityRef.current.pending -= 1; });
  }, [saveContents]);
  useLayoutEffect(() => {
    saveBeforeProjectTransitionRef.current = save;
  }, [save]);

  const acceptExternalText = useCallback(async (
    path: string,
    content: string,
    pane: EditorPaneId,
  ) => {
    if (activeCollabVersion === 2) {
      const controller = collabV2ControllerRef.current;
      if (pane === "primary" && controller?.activePath === path) {
        mergeTextIntoYText(controller.ytext, content);
      } else if (pane === "secondary") {
        const binding = await controller?.openSecondaryPath(path);
        if (binding) mergeTextIntoYText(binding.ytext, content);
      }
    }
    if (pane === "primary" && activeFileRef.current === path) commitPrimaryText(content);
    if (pane === "secondary" && secondaryFileRef.current === path) commitSecondaryText(content);
  }, [activeCollabVersion, activeFileRef, commitPrimaryText, commitSecondaryText, secondaryFileRef]);

  useLayoutEffect(() => {
    hasLateProjectTransitionEditRef.current = () => {
      if (visualMarkdownFlushRef.current?.() === false) return true;
      const primaryDirty = activePaper
        ? paperBuffersDirty()
        : !activeAsset && sourceRef.current !== savedSourceRef.current;
      return primaryDirty || secondarySourceRef.current !== secondarySavedRef.current;
    };
  }, [
    activeAsset, activePaper, paperBuffersDirty, savedSourceRef, secondarySavedRef, secondarySourceRef,
    sourceRef,
  ]);

  useEffect(() => {
    if (!browserHosted) return;
    const saveBrowserPage = (event?: BeforeUnloadEvent) => {
      visualMarkdownFlushRef.current?.();
      if (!hasLateProjectTransitionEditRef.current()) return;
      // Sending the invoke begins synchronously before the tab is discarded.
      // The confirmation keeps a just-typed buffer alive long enough for the
      // loopback write to finish instead of losing the last autosave interval.
      void saveBeforeProjectTransitionRef.current();
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
  }, [browserHosted]);
  useEffect(() => {
    if (!project || !activeFile || activeAsset || activePaper) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        if (saveActivityRef.current.pending) return;
        const saveGenerationAtStart = saveActivityRef.current.generation;
        // Disk reads may finish after our own autosave or a live delivery.
        // Such a snapshot is not a new external edit and must not rewind the
        // buffer or suspend Overleaf OT. Leave mtime unconsumed so we retry.
        const readIsCurrent = () => !cancelled
          && !saveActivityRef.current.pending
          && saveActivityRef.current.generation === saveGenerationAtStart;
        /**
         * Check one pane's file for an external edit: record its mtime the
         * first time, then reload a newer version into a clean buffer.
         * Resolves false when the poll should stop (stale read, missing file).
         */
        const pollPane = async (
          pane: EditorPaneId,
          path: string,
          mtimeRef: { current: number | null },
          savedRef: { readonly current: string },
          bufferRef: { readonly current: string },
        ) => {
          const saved = savedRef.current;
          const stat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", { path });
          if (!readIsCurrent() || !stat.exists || savedRef.current !== saved) return false;
          if (mtimeRef.current == null) {
            mtimeRef.current = stat.mtimeMs;
            return true;
          }
          if (stat.mtimeMs <= mtimeRef.current) return true;
          const content = await invoke<string>("read_project_file", { path });
          if (!readIsCurrent() || savedRef.current !== saved) return false;
          mtimeRef.current = stat.mtimeMs;
          if (content === saved) return true;
          externalOverleafEditsRef.current([path]);
          if (bufferRef.current !== savedRef.current) return true;
          await acceptExternalText(path, content, pane);
          if (buildPreferences.autoBuildMode === "automatic") void compileRef.current();
          return true;
        };
        try {
          if (!(await pollPane("primary", activeFile, diskMtimeRef, savedSourceRef, sourceRef)) || !secondaryFile) return;
          await pollPane("secondary", secondaryFile, secondaryMtimeRef, secondarySavedRef, secondarySourceRef);
        } catch {
          // Ignore transient filesystem races while the editor is open.
        }
      })();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    acceptExternalText, activeAsset, activeFile, activePaper, buildPreferences.autoBuildMode, project,
    savedSourceRef, secondaryFile, secondarySavedRef, secondarySourceRef, sourceRef,
  ]);

  const pushNavigation = useCallback((path: string, line: number) => {
    if (navLock.current || !path) return;
    setNavStack((stack) => {
      const trimmed = stack.slice(0, Math.max(0, navIndex + 1));
      const last = trimmed[trimmed.length - 1];
      if (last && last.path === path && last.line === line) {
        setNavIndex(trimmed.length - 1);
        return trimmed;
      }
      const next = [...trimmed, { path, line }].slice(-80);
      setNavIndex(next.length - 1);
      return next;
    });
  }, [navIndex]);

  const openProjectFile = useCallback(async (
    path: string,
    line?: number,
    targetPane?: EditorPaneId,
    options?: {
      /**
       * Whether a file with no preview of its own (.bib, .sty, .cls) may take
       * the whole editor area. True for an ordinary open — that file has
       * nothing to show beside itself. False for a reverse SyncTeX jump, which
       * would otherwise close the very PDF the double-click came from.
       */
      revealSource?: boolean;
    },
  ) => {
    cancelPreviewPrewarm();
    const rememberedSplit = textSplitRef.current;
    const restoreSplit = targetPane === undefined
      && !isTwoPane(canvasMode)
      && rememberedSplit?.projectRoot === project?.root
      && rememberedSplit?.secondaryPath === secondaryFile
      && (path === rememberedSplit?.primaryPath || path === rememberedSplit?.secondaryPath)
      ? rememberedSplit
      : null;
    const restoreSecondary = restoreSplit?.secondaryPath === path;
    const navigationPath = path;
    if (restoreSplit) path = restoreSplit.primaryPath;
    const restoreSplitLayout = () => {
      if (!restoreSplit) return;
      documentModeRef.current = restoreSplit.mode;
      setCanvasMode(restoreSplit.mode);
      setFocusedPane(restoreSecondary ? "secondary" : "primary");
    };
    const keepDocumentMode = (mode: CanvasMode): CanvasMode => (
      mode === "pdf" || mode === "asset" ? "split" : mode
    );
    const requestedPane = targetPane ?? focusedPane;
    const secondaryFocused = isTwoPane(canvasMode)
      && requestedPane === "secondary"
      && !activeAsset;
    if (secondaryFocused) {
      if (paperLoadGenerationRef.current === fileLoadGenerationRef.current) {
        fileLoadGenerationRef.current += 1;
        paperLoadGenerationRef.current = null;
        setPrimaryOpening(null);
      }
      const requestGeneration = secondaryFileLoadGenerationRef.current + 1;
      secondaryFileLoadGenerationRef.current = requestGeneration;
      const projectRoot = project?.root;
      const ownsProject = captureProjectScope();
      const isLatestSecondaryLoad = () => requestGeneration === secondaryFileLoadGenerationRef.current && ownsProject();
      const collab = activeCollabVersion === 2;
      if (!collab && path === secondaryFile) {
        setFocusedPane("secondary");
        if (line) {
          requestEditorLine(path, line);
          pushNavigation(path, line);
        }
        return;
      }
      if (!collab && secondaryFile && secondarySource !== secondarySavedSource) {
        try {
          if (!(await publishTextToCollabV2(secondaryFile, secondarySource))) {
            await invoke("write_project_file", { path: secondaryFile, content: secondarySource, projectRoot: project?.root });
          }
          setSecondarySavedSource(secondarySource);
        } catch (reason) {
          setError(toMessage(reason));
          return;
        }
      }
      try {
        let content: string;
        if (collab) {
          if (secondaryFile && secondarySource !== secondarySavedSource && !(await save())) return;
          if (!isLatestSecondaryLoad()) return;
          const controller = collabV2ControllerRef.current;
          if (!controller?.hasTextPath(path)) throw new Error(`${path} is not a v2 text file`);
          // sideload: the yCollab binding belongs to the primary pane. Letting
          // this open activate would repoint activePath at the secondary file,
          // unbind the primary editor, and silently stop syncing its keystrokes
          // (the debounced publishTextToCollabV2 pass covers this pane instead).
          content = (await controller.openPath(path, "secondary", { sideload: true })).toString();
        } else {
          content = await invoke<string>("read_project_file", { path, projectRoot });
        }
        if (!isLatestSecondaryLoad()) return;
        showSecondaryText(path, content);
        addOpenTab(path);
        setFocusedPane("secondary");
        setError(null);
        // Same commit as the content: a jump asked for afterwards paints the
        // file at its top for a frame first.
        if (line) requestEditorLine(path, line);
        pushNavigation(path, line || 1);
      } catch (reason) {
        if (isLatestSecondaryLoad()) setError(toMessage(reason));
      }
      return;
    }
    // Every click is a primary-surface intent, including reselecting the file
    // already on screen. Reserving it first prevents an older Paper/asset read
    // from replacing the surface after this click.
    const switchStartedAt = performance.now();
    const loadGeneration = fileLoadGenerationRef.current + 1;
    fileLoadGenerationRef.current = loadGeneration;
    const alreadyOpen = path === activeFile && !activePaper && !activeAsset;
    if (alreadyOpen) {
      // This intent invalidates any older Paper/file request even though it
      // does not need its own opening UI.
      setPrimaryOpening(null);
      setFocusedPane("primary");
      restoreSplitLayout();
      if (line) {
        requestEditorLine(navigationPath, line);
        setCanvasMode(keepDocumentMode);
        pushNavigation(navigationPath, line);
      }
      try {
        if (visualMarkdownFlushRef.current?.() === false) return;
        if (sourceRef.current !== savedSourceRef.current) {
          if (!(await save())) return;
        } else {
          const content = await invoke<string>("read_project_file", { path, projectRoot: project?.root });
          if (
            fileLoadGenerationRef.current === loadGeneration
            && activeFileRef.current === path
            && content !== sourceRef.current
          ) {
            await acceptExternalText(path, content, "primary");
            await markDiskMtime(path);
          }
        }
      } catch (reason) {
        if (fileLoadGenerationRef.current === loadGeneration) setError(toMessage(reason));
      }
      return;
    }
    const clearOpening = () => setPrimaryOpening((current) => (current?.generation === loadGeneration ? null : current));
    setPrimaryOpening({ generation: loadGeneration, label: path.split("/").at(-1) ?? path });
    await afterNextPaintOpportunity();
    const openingPaintMs = performance.now() - switchStartedAt;
    if (fileLoadGenerationRef.current !== loadGeneration) {
      clearOpening();
      return;
    }
    // Reserve this user intent before save or any other await. Otherwise an
    // older file request waiting on a write can allocate a newer generation
    // after a later Paper/asset click and incorrectly reclaim the surface.
    // Visual Markdown serialization is intentionally deferred while typing.
    // Publish it before taking the dirty snapshot so a programmatic switch
    // cannot apply the old document's final edit to the next file buffer.
    const flushStartedAt = performance.now();
    try {
      if (visualMarkdownFlushRef.current?.() === false) {
        clearOpening();
        return;
      }
    } catch (reason) {
      if (fileLoadGenerationRef.current === loadGeneration) setError(toMessage(reason));
      clearOpening();
      return;
    }
    const flushMs = performance.now() - flushStartedAt;
    if (activeFile && !activePaper && !activeAsset) {
      const current = viewStateRef.current.get(activeFile);
      viewStateRef.current.set(activeFile, {
        ...current,
        text: current?.text ?? { cursor: 0, scrollTop: 0 },
      });
    }
    const contentLoadStartedAt = performance.now();
    let gate: Promise<boolean> | undefined;
    const paperDirty = Boolean(activePaper) && paperBuffersDirty();
    const targetAliasesDirtyPaper = paperDirty
      && (path === paperDocumentPath(activePaper!.arxivId, "fulltext") || path === paperDocumentPath(activePaper!.arxivId, "blog"));
    if (sourceRef.current !== savedSourceRef.current || paperDirty || (secondaryFile && secondarySource !== secondarySavedSource)) {
      if (path === secondaryFile || targetAliasesDirtyPaper) {
        // save() rewrites this destination from either the secondary buffer or
        // the Paper editor; overlapping it with the read below would hand the
        // incoming editor pre-save contents after the write succeeds.
        if (!(await save()) || fileLoadGenerationRef.current !== loadGeneration) {
          clearOpening();
          return;
        }
      } else {
        // Otherwise the write of the old file and the read of the new one are
        // independent — run them concurrently and let loadFile confirm the
        // save before committing state.
        gate = save();
      }
    }
    const applied = await loadFile(path, {
      restoreView: !line,
      revealSource: options?.revealSource ?? true,
      gate,
      loadGeneration,
      canCommit: () => !flushAndCheckPrimaryDirty(),
      navigateToLine: restoreSecondary ? undefined : line,
    });
    clearOpening();
    if (!applied) return;
    recordNavigationTiming("file", path, switchStartedAt, {
      openingPaintMs, flushMs, saveAndReadMs: performance.now() - contentLoadStartedAt,
    });
    setFocusedPane("primary");
    restoreSplitLayout();
    if (line) {
      if (restoreSecondary) requestEditorLine(navigationPath, line);
      // The jump itself rode the load's commit; this only widens a
      // preview-only surface so the editor it lands in is on screen.
      setCanvasMode(keepDocumentMode);
      pushNavigation(navigationPath, line);
    } else {
      pushNavigation(navigationPath, 1);
    }
  // `publishTextToCollabV2` is listed although `activeCollabVersion` already
  // tracks its identity today: that is two lists agreeing by coincidence, not a
  // guarantee, so it is listed to keep it true.
  }, [
    acceptExternalText, activeAsset, activeCollabVersion, activeFile, activeFileRef, activePaper, addOpenTab,
    cancelPreviewPrewarm, canvasMode, flushAndCheckPrimaryDirty, focusedPane, loadFile, markDiskMtime,
    paperBuffersDirty, project?.root, publishTextToCollabV2, pushNavigation, requestEditorLine, save,
    savedSourceRef, secondaryFile, secondarySavedSource, secondarySource, setSecondarySavedSource,
    showSecondaryText, sourceRef, viewStateRef, captureProjectScope,
  ]);
  const openProjectFileRef = useLatest(openProjectFile);

  const openProjectFileFromClick = useCallback((path: string, line?: number) => {
    if (suppressedProjectFileClick.current === path) {
      suppressedProjectFileClick.current = null;
      return;
    }
    void openProjectFile(path, line);
  }, [openProjectFile]);

  /** Jump to where a collaborator is working, following them into their file. */
  const followCollabPeer = useCallback(async (peer: CollabPeer) => {
    const v2 = collabV2ControllerRef.current;
    const location = v2 ? peerCursorLocationV2(v2, peer.clientId) : null;
    // Their caret is the precise answer; the file they announced is the fallback
    // for a peer who has not placed a cursor yet (or is in another file on v2).
    const path = location?.path ?? peer.path;
    if (!path) {
      setNotice(`${peer.name} is not in a file right now`);
      return;
    }
    try {
      if (location) {
        requestEditorLine(path, location.line);
        pushNavigation(path, location.line);
        return;
      }
      // Cross-file peers only have a coordinator path until we join that
      // file's awareness room. Open it first, then resolve the real awareness
      // client by stable instance id and complete the jump in this same click.
      await openProjectFile(path, undefined, "primary");
      if (collabV2ControllerRef.current !== v2 || v2?.activePath !== path || !peer.instanceId) return;
      const openedLocation = await waitForPeerCursorLocationV2(v2, peer.instanceId);
      if (!openedLocation || collabV2ControllerRef.current !== v2) return;
      requestEditorLine(path, openedLocation.line);
      pushNavigation(path, openedLocation.line);
    } catch {
      setNotice(`Could not open ${path}`);
    }
  }, [openProjectFile, pushNavigation, requestEditorLine]);

  const navigateHistory = useCallback(async (direction: -1 | 1) => {
    const nextIndex = navIndex + direction;
    const entry = navStack[nextIndex];
    if (!entry) return;
    navLock.current = true;
    setNavIndex(nextIndex);
    try {
      await openProjectFile(entry.path, entry.line);
    } finally {
      navLock.current = false;
    }
  }, [navIndex, navStack, openProjectFile]);

  const reopenClosedTab = useCallback(async () => {
    const path = closedTabsRef.current.shift();
    if (!path) return;
    await openProjectFile(path);
  }, [openProjectFile]);

  const revealPdfSource = useCallback(async (page: number, x: number, y: number) => {
    // In dual/columns one pane can be showing this preview. The jump then
    // belongs to the pane that still holds an editor, and the layout the reader
    // arranged has to survive it — collapsing to split would close the other
    // editor to make room for a preview that is already on screen.
    const jumpPane: EditorPaneId | null = dualPreviewPanes.primary
      ? (secondaryFile && !secondaryAsset ? "secondary" : null)
      : dualPreviewPanes.secondary ? "primary" : null;
    try {
      const target = await invoke<SyncTexTarget>("synctex_edit", { page, x, y });
      // A citation resolves into the bibliography, a macro into a .sty. Those
      // files own the whole editor area when opened deliberately, but a jump
      // out of the PDF must keep the preview it was made from on screen.
      await openProjectFile(target.path, target.line, jumpPane ?? undefined, { revealSource: false });
      if (!jumpPane) setCanvasMode((mode) => (mode === "source" ? mode : "split"));
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [dualPreviewPanes.primary, dualPreviewPanes.secondary, openProjectFile, secondaryAsset, secondaryFile]);

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

  // The same conversation, for a share that never goes near Overleaf. In a v2
  // share every file is its own doc, so chat rides a dedicated project-wide
  // document (COLLAB_CHAT_PATH) instead of whichever file happens to be
  // active — otherwise peers reading different files each saw a different
  // conversation, and switching files swapped the visible history.
  //
  // This sits above the Overleaf bridge on purpose: before the extraction these
  // hooks ran between the two halves of the Overleaf code, and keeping them
  // ahead of it preserves the original effect and teardown order.
  const [collabChatDoc, setCollabChatDoc] = useState<import("yjs").Doc | null>(null);
  useEffect(() => {
    const v2 = collabV2ControllerRef.current;
    if (activeCollabVersion !== 2 || !collabSession || !v2) {
      setCollabChatDoc(null);
      return;
    }
    const unsubscribe = v2.subscribeChatDoc(setCollabChatDoc);
    // collabFileCount re-runs this, so a read-only guest binds the chat file
    // once a writer creates it mid-share, and epoch bumps rebind.
    void v2.openChatDoc().catch(() => undefined);
    return () => {
      unsubscribe();
      setCollabChatDoc(null);
    };
  }, [activeCollabVersion, collabFileCount, collabSession]);
  const collabChat = useCollabChat({
    doc: activeCollabVersion === 2 ? collabChatDoc : (collabSession?.doc ?? null),
    // The identity editor comments already sign with, rather than inventing a
    // second one for the same person.
    selfId: editorCommentAuthorId,
    displayName: collabName,
  });

  const runSharedOverleafSync = useCallback(async (
    observedRemoteVersion?: number | null,
    livePaths: readonly string[] = [],
    diagnosticOperationId: string = crypto.randomUUID(),
  ): Promise<OverleafSyncResult> => {
    const controller = collabV2ControllerRef.current;
    const lease = collabWorkspaceLeaseRef.current;
    const projectRoot = projectRef.current?.root;
    if (
      activeCollabVersion !== 2
      || !controller
      || !lease?.isCurrent()
      || !projectRoot
      || collabSessionRef.current !== controller
    ) {
      throw new Error("The shared project changed before Overleaf sync could start.");
    }
    if (!collabCanWrite || controller.canWrite === false) {
      throw new Error("This shared project is read-only.");
    }
    return syncSharedProjectWithOverleaf(
      { controller, lease, projectRoot, disk: v2WorkspaceCallbacks(lease) },
      commitOpenText,
      { observedRemoteVersion, livePaths, operationId: diagnosticOperationId },
    );
  }, [activeCollabVersion, collabCanWrite, commitOpenText, projectRef, v2WorkspaceCallbacks]);

  // ---- Overleaf bridge -----------------------------------------------------
  // Link discovery, syncing, the realtime channel and everything that rides it
  // (presence, chat, comment threads, tracked changes) live in
  // `src/app/use-overleaf-workspace.ts`. It has to be called here rather than
  // beside the rest of App's state: every sync path goes through save, compile,
  // loadFile and refreshProject, all of which are declared above.
  const wholeFileEditingPaths = useMemo(() => [
    ...(!activePaper && !activeAsset && !dualPreviewPanes.primary && canvasMode !== "pdf"
      && isWholeFileEditorPath(activeFile) ? [activeFile] : []),
    ...(isTwoPane(canvasMode) && secondaryFile && !secondaryAsset && !dualPreviewPanes.secondary
      && isWholeFileEditorPath(secondaryFile) ? [secondaryFile] : []),
  ], [
    activeAsset, activeFile, activePaper, canvasMode, dualPreviewPanes.primary, dualPreviewPanes.secondary,
    secondaryAsset, secondaryFile,
  ]);
  const wholeFileDraftPaths = useMemo(() => (
    openSlideContext?.pendingEdits
    && wholeFileEditingPaths.includes(openSlideContext.pagePath)
      ? [openSlideContext.pagePath]
      : []
  ), [openSlideContext, wholeFileEditingPaths]);
  const overleaf = useOverleafWorkspace({
    project, projectRef, projectOperationGenerationRef, activeFile, activeFileRef, activePaper, activeAsset,
    source, sourceRef, savedSourceRef, setSource, setSavedSource, setViewRestore, viewStateRef, editorPosition,
    editorPositionRef, build, saveGeneration, savedPathsRef, wholeFileEditingPaths, wholeFileDraftPaths,
    collabSession, collabName, runSharedOverleafSync, save, compile, loadFile, refreshProject, openProjectFile,
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
    if (!projectRoot) throw new Error("The project closed before the Open Slide edit could be saved.");
    if (collabSessionRef.current?.canWrite === false || !collabCanWrite) {
      throw new Error("This shared project is read-only.");
    }
    const controller = activeCollabVersion === 2 ? collabV2ControllerRef.current : null;
    const lease = controller ? collabWorkspaceLeaseRef.current : null;
    if (controller && !lease?.isCurrent()) {
      throw new Error("The shared project changed before the Open Slide edit could be saved.");
    }
    const written = await writeOpenSlideMutation(
      mutation,
      projectRoot,
      controller && lease
        ? { controller, lease, projectRoot, disk: v2WorkspaceCallbacks(lease), queue: collabDiskWriteQueueRef.current }
        : null,
      () => projectRef.current?.root === projectRoot,
    );
    if (written.text !== undefined) commitOpenText(mutation.path, written.text);
    if (written.hadConflicts) {
      setWarning(`Open Slide and another editor changed the same lines in ${mutation.path}; Lattice kept both with conflict markers.`);
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
      else showPrimaryText("", "");
    }
    return mutation.kind === "delete"
      ? [{ path: mutation.path, kind: "delete" }]
      : [{
          path: mutation.path,
          kind: mutation.kind,
          ...(written.text !== undefined ? { text: written.text } : { base64: written.base64 }),
        }];
  }, [
    activeCollabVersion, activeFileRef, collabCanWrite, collabDiskWriteQueueRef, commitOpenText, loadFile,
    projectRef, recordSavedPaths, refreshHistory, refreshProject, v2WorkspaceCallbacks, showPrimaryText,
  ]);

  const openSources = useCallback(() => new Map([
    [activeFileRef.current, sourceRef.current],
    ...(secondaryFileRef.current ? [[secondaryFileRef.current, secondarySourceRef.current] as const] : []),
  ]), [activeFileRef, secondaryFileRef, secondarySourceRef, sourceRef]);
  const editorComments = useEditorComments({
    project, projectRootRef, overleaf,
    shared: { controllerRef: collabV2ControllerRef, active: activeCollabVersion === 2 && Boolean(collabSession), fileCount: collabFileCount },
    author: { id: editorCommentAuthorId, name: collabName },
    openSources,
    agentOptionsRef: agentCommentsOptionsRef,
  });
  const { reset: resetEditorComments, load: loadEditorComments } = editorComments;

  const revealSourceInPdf = useCallback(async () => {
    if (!forwardSyncPosition || locatingPdf) return;
    const position = forwardSyncPosition;
    const requestGeneration = forwardSyncGenerationRef.current + 1;
    forwardSyncGenerationRef.current = requestGeneration;
    const ownsProject = captureProjectScope();
    const fileLoadGeneration = fileLoadGenerationRef.current;
    const documentViewGeneration = documentViewGenerationRef.current;
    const isCurrentRequest = () => (
      forwardSyncGenerationRef.current === requestGeneration
      && ownsProject()
      && fileLoadGenerationRef.current === fileLoadGeneration
      && documentViewGenerationRef.current === documentViewGeneration
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
      const sourceDirty = position.path === secondaryFile
        ? secondarySource !== secondarySavedSource
        : source !== savedSource;
      if (sourceDirty || !pdfUrl) await runBuild();
      if (!isCurrentRequest()) return;
      const target = await invoke<PdfSyncResponse | null>("synctex_view", {
        path: position.path,
        line: position.line,
        column: position.column,
      });
      if (!isCurrentRequest()) return;
      if (!target) {
        warnOnly("This source line has no matching position in the PDF.");
        return;
      }
      setWarning(null);
      setPdfSyncTarget({ ...target, id: crypto.randomUUID() });
      setCanvasMode((mode) => (mode === "source" || isTwoPane(mode) ? "split" : mode));
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
    forwardSyncPosition, locatingPdf, pdfUrl, runBuild, save, savedSource, secondaryFile, secondarySavedSource,
    secondarySource, source, captureProjectScope,
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
    await openProjectFile(path, line);
    if (!isCurrentRequest(false)) return;
    try {
      const target = await invoke<PdfSyncResponse | null>("synctex_view", { path, line, column: 0 });
      if (!isCurrentRequest()) return;
      if (target) setPdfSyncTarget({ ...target, id: crypto.randomUUID() });
      setCanvasMode((mode) => (mode === "source" || isTwoPane(mode) ? "split" : mode));
      setError(null);
    } catch {
      // The source jump is still useful when this PDF has no SyncTeX map.
    }
  }, [activeFileRef, openProjectFile, captureProjectScope]);

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
    try {
      await openProjectFile(path, diagnostic.line ?? undefined);
      setDiagnosticsExpanded(true);
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeFile, openProjectFile, project, setDiagnosticsExpanded]);
  useEffect(() => {
    openCompileDiagnosticRef.current = openCompileDiagnostic;
  }, [openCompileDiagnostic]);

  const repairWritable = collabCanWrite && collabSession?.canWrite !== false
    && (!overleafLink || overleafRealtime.canWrite);
  const compileRepair = useCompileRepair({
    projectRoot: project?.root,
    rootDocument: build?.rootDocument,
    runtimeMode: synara.permissionMode,
    enabled: repairWritable && !building,
    save: async () => {
      if (visualMarkdownFlushRef.current?.() === false) return false;
      return save();
    },
    onComplete: async () => {
      const root = projectRef.current?.root;
      const generation = projectOperationGenerationRef.current;
      if (!root) return;
      const owns = () => projectRef.current?.root === root && projectOperationGenerationRef.current === generation;
      await refreshProject({ expectedRoot: root, generation });
      const paneRefs = {
        primary: [activeFileRef, sourceRef, savedSourceRef],
        secondary: [secondaryFileRef, secondarySourceRef, secondarySavedRef],
      } as const;
      for (const pane of ["primary", "secondary"] as const) {
        if (!owns()) return;
        if (pane === "primary" ? activePaper || activeAssetRef.current : secondaryAssetRef.current) continue;
        const [fileRef, bufferRef, savedRef] = paneRefs[pane];
        const path = fileRef.current;
        const clean = () => fileRef.current === path && bufferRef.current === savedRef.current;
        if (!path || !clean()) continue;
        const content = await invoke<string>("read_project_file", { path, projectRoot: root });
        if (!owns()) return;
        if (clean()) await acceptExternalText(path, content, pane);
      }
      if (owns()) await compileRef.current();
    },
  });

  const saveAndCompileAutomatically = useCallback(async () => {
    automaticBuildQueued.current = true;
    if (automaticBuildPending.current) return;
    automaticBuildPending.current = true;
    const generation = projectOperationGenerationRef.current;
    try {
      do {
        automaticBuildQueued.current = false;
        const saved = await save();
        if (generation !== projectOperationGenerationRef.current) return;
        if (!saved) return;
        // Only serialize the writes. runBuild owns build coalescing; awaiting
        // it here used to discard edits and attention changes during a build.
        void runBuild(false, { immediatePreview: false });
      } while (automaticBuildQueued.current && (
        sourceRef.current !== savedSourceRef.current
        || secondarySourceRef.current !== secondarySavedRef.current
      ));
    } finally {
      automaticBuildPending.current = false;
    }
  }, [
    projectOperationGenerationRef, runBuild, save, savedSourceRef, secondarySavedRef, secondarySourceRef,
    sourceRef,
  ]);
  const saveRef = useRef(save);
  saveRef.current = save;
  const saveAndCompileAutomaticallyRef = useRef(saveAndCompileAutomatically);
  saveAndCompileAutomaticallyRef.current = saveAndCompileAutomatically;

  const enterProject = useCallback(
    async (
      snapshot: ProjectSnapshot,
      options?: { skipCollabLifecycle?: boolean; deferInitialBuild?: boolean },
    ) => {
      void loadDocumentCanvas();
      if (!options?.skipCollabLifecycle) {
        await settleCollabBeforeProjectSwitch(snapshot.root);
      }
      beginProjectTransition(true);
      const projectGeneration = projectOperationGenerationRef.current;
      const primaryRestoreGeneration = fileLoadGenerationRef.current + 1;
      fileLoadGenerationRef.current = primaryRestoreGeneration;
      const secondaryRestoreGeneration = secondaryFileLoadGenerationRef.current + 1;
      secondaryFileLoadGenerationRef.current = secondaryRestoreGeneration;
      const ownsProjectRestore = () => (
        projectOperationGenerationRef.current === projectGeneration
        && projectRef.current?.root === snapshot.root
      );
      setWorkspacePersistenceReadyRoot(null);
      pendingWorkspaceSurfaceRef.current = null;
      // The backend already owns the incoming root. Clear the outgoing buffer
      // before exposing that root to effects, otherwise an autosave or the
      // incoming project's initial Overleaf sync can write the old relative
      // path into the new project.
      showPrimaryText("", "");
      loadViewStatesForProject(snapshot.root);
      projectRef.current = snapshot;
      projectBeforeTransitionRef.current = null;
      setProject(snapshot);
      rememberProject(snapshot);
      setProjectMenuOpen(false);
      resetAgentSelection();
      resetEditorComments();
      // A pinned turn review belongs to the outgoing project's thread; keeping
      // it would bind the drawer to a foreign thread after the switch.
      setAgentTurnReview(null);
      setDiskTodos([]);
      setTodosOpen(false);
      setActivePaper(null);
      showActiveAsset(null);
      showSecondaryAsset(null);
      setPaperBuffers("", null);
      showSecondaryText(null);
      setFocusedPane("primary");
      setOpenTabs([]);
      setPinnedTabs([]);
      setCanvasMode("split");
      htmlViewModesRef.current.clear();
      documentModeRef.current = "split";
      // Shared workspaces are empty scaffolds until synchronization, so they
      // must wait for their post-sync build instead of showing a cached PDF.
      resetForProject(snapshot.root, !options?.skipCollabLifecycle);
      // A guest joining a share enters an empty scaffold workspace *before* the
      // shared sources have synced. Building it now compiles the placeholder and
      // pops a spurious "compilation failed". The join flow defers the build and
      // triggers one once the real project has materialized (see onSynced).
      if (!options?.deferInitialBuild) {
        void runBuild(false, { immediatePreview: true });
      }
      const isLatestBibliography = claimBibliographyRefresh();
      const bibliographyIndex = await loadBibliographyIndex();
      const [nextPapers, , , nextReferences] = bibliographyIndex;
      if (!ownsProjectRestore()) return;
      // Opening a file cancels workspace restoration, not the project's paper
      // scan. Apply metadata before the editor-generation guards below, but do
      // not overwrite a newer bibliography refresh triggered by a save.
      if (isLatestBibliography()) applyBibliographyIndex(bibliographyIndex);
      else setReferences(nextReferences ?? []);
      const plan = planWorkspaceRestore(snapshot, nextPapers, loadWorkspaceLayout(snapshot.root), loadLastFile(snapshot.root));
      const { primaryFile, secondaryFile, activeTab, mode } = plan;
      documentModeRef.current = plan.documentMode;
      // A newer file intent from the writer (in either pane) cancels the rest of the restore.
      let primaryGeneration = primaryRestoreGeneration;
      const restoreIsCurrent = () => ownsProjectRestore()
        && fileLoadGenerationRef.current === primaryGeneration
        && secondaryFileLoadGenerationRef.current === secondaryRestoreGeneration;
      if (!restoreIsCurrent()) return;
      if (primaryFile && !(await loadFile(primaryFile, { expectedProjectRoot: snapshot.root, projectGeneration }))) return;
      primaryGeneration = fileLoadGenerationRef.current;
      if (!ownsProjectRestore()) return;
      if (secondaryFile) {
        try {
          if (!restoreIsCurrent()) return;
          const content = await invoke<string>("read_project_file", { path: secondaryFile, projectRoot: snapshot.root });
          if (!restoreIsCurrent()) return;
          showSecondaryText(secondaryFile, content);
        } catch {
          if (ownsProjectRestore() && secondaryFileLoadGenerationRef.current === secondaryRestoreGeneration) {
            showSecondaryText(null);
          }
        }
      }
      if (!restoreIsCurrent()) return;
      if (isHtmlFilePath(activeTab)) htmlViewModesRef.current.set(activeTab, mode as DocumentViewMode);
      setOpenTabs(plan.tabs);
      setPinnedTabs(plan.pinnedTabs);
      tabRecency.current = plan.tabRecency;
      setFocusedPane(plan.focusedPane);
      setCanvasMode(mode);
      setPaperView(plan.paperView);
      setNavStack(primaryFile ? [{ path: primaryFile, line: 1 }] : []);
      setNavIndex(primaryFile ? 0 : -1);
      await refreshUnusedSymbols();
      await loadHistory();
      await loadEditorComments();
      await loadTodos();
      await loadWordCount();
      setPdfPageCount(null);
      setChecklistOpen(false);
      if (plan.activeKind !== "document") {
        pendingWorkspaceSurfaceRef.current = { root: snapshot.root, activeTab, canvasMode: mode, paperView: plan.paperView };
      } else {
        setWorkspacePersistenceReadyRoot(snapshot.root);
      }
      // Never animate shell opacity from 0 — a cancelled/interrupted tween leaves the
      // whole window blank white with the UI still "mounted".
      if (shellRef.current) shellRef.current.style.opacity = "1";
    },
    [
      applyBibliographyIndex, beginProjectTransition, claimBibliographyRefresh, loadEditorComments, loadFile,
      loadHistory, loadTodos, loadViewStatesForProject, loadWordCount, projectBeforeTransitionRef,
      projectOperationGenerationRef, projectRef, refreshUnusedSymbols, rememberProject, resetAgentSelection,
      resetEditorComments, resetForProject, runBuild, setActivePaper, setDiskTodos, setPaperBuffers,
      setPaperView, setProject, setReferences, settleCollabBeforeProjectSwitch, showActiveAsset,
      showSecondaryAsset, showSecondaryText, showPrimaryText,
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
    setBusyLabel("Opening window…");
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
  }, []);

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

  /**
   * Connect the workspace this window just entered at `root` to a v2 share:
   * start its controller, materialize the shared files onto disk and bind the
   * editor. `track` receives the controller as soon as it exists, so a failure
   * part-way can tear it down with discardSharedController.
   */
  const connectSharedWorkspace = useCallback(async (root: string, share: {
    deployment: string;
    projectInstanceId: string;
    credentialRef: string;
    store: ReturnType<typeof collabCredentialStore>;
    permission: CollabProjectRecordV2["permission"];
    track: (controller: CollabProjectControllerV2) => void;
  }) => {
    const role = share.permission === "host" ? "host" : "guest";
    const generation = collabWorkspaceGenerationRef.current + 1;
    collabWorkspaceGenerationRef.current = generation;
    const lease: CollabWorkspaceLease = {
      projectRoot: root,
      generation,
      isCurrent: () => collabWorkspaceGenerationRef.current === generation && projectRootRef.current === root,
    };
    collabWorkspaceLeaseRef.current = lease;
    collabRoleRef.current = role;
    const controller = await CollabProjectControllerV2.start({
      deployment: share.deployment, projectInstanceId: share.projectInstanceId, credentialRef: share.credentialRef,
      credentialStore: share.store, permission: share.permission, onStatus: mapV2Status, onCatalog: handleV2Catalog,
      displayName: collabName, participantId: editorCommentAuthorId, onPeers: setCollabPeerList,
      onPermanentError: handleV2PermanentError,
    });
    share.track(controller);
    collabV2ControllerRef.current = controller;
    collabSessionRef.current = controller;
    const materialized = await controller.materializeProject(lease, v2WorkspaceCallbacks(lease));
    assertCollabWorkspaceLease(lease);
    await refreshProject();
    collabRoleRef.current = role;
    setCollabRole(role);
    setActiveCollabVersion(2);
    setCollabRoom(controller.room);
    setCollabFileCount(controller.fileCount());
    // loadFile awaits openPath before publishing the session/ready state.
    // Publishing first lets DocumentCanvas render against activePath="" and
    // used to crash the entire joining app in setActivePath().
    await bindJoinedDocument(controller, materialized.openPath);
    return controller;
  }, [
    bindJoinedDocument, collabName, collabRoleRef, collabWorkspaceGenerationRef, editorCommentAuthorId,
    handleV2Catalog, handleV2PermanentError, mapV2Status, refreshProject, setCollabFileCount, setCollabPeerList,
    setCollabRole, setCollabRoom, v2WorkspaceCallbacks,
  ]);
  const discardSharedController = useCallback(async (controller: CollabProjectControllerV2 | null) => {
    if (!controller) return;
    if (collabV2ControllerRef.current === controller) await clearCollabLocalState().catch(() => undefined);
    else controller.destroy();
  }, [clearCollabLocalState]);
  /** Any unsaved edit in this window, which must be saved before a share replaces it. */
  const unsavedEdits = Boolean(project) && (source !== savedSource || (Boolean(secondaryFile) && secondarySource !== secondarySavedSource));

  const joinCollabShare = useCallback(() => {
    if (!isCollabEnabled()) return;
    const v2Raw = collabInvite.trim() || collabRoom.trim();
    let v2Invite;
    try {
      v2Invite = parsePreferredCollabInvitation(v2Raw);
    } catch (reason) {
      setError(toMessage(reason));
      return;
    }
    if (v2Invite) {
      if (loadCollabFeaturePolicy().emergencyDisableReads) {
        setError("Collaboration reads are temporarily disabled.");
        return;
      }
      void (async () => {
        setBusyLabel("Opening a v2 shared workspace…");
        let controller: CollabProjectControllerV2 | null = null;
        const priorRoot = project?.root ?? null;
        let openedJoinWorkspace = false;
        try {
          saveCollabDisplayName(collabName.trim());
          if (unsavedEdits && !(await save())) return;
          if (!await startProjectTransition()) return;
          preCollabProjectRootRef.current = priorRoot;
          rememberPreCollabProjectRoot(priorRoot);
          const shortRoom = v2Invite.projectInstanceId.slice(-12);
          const store = collabCredentialStore();
          let record = await acceptCollabInvitationV2(v2Raw, store, { projectRoot: null, title: `Shared project ${shortRoom.slice(-6)}` });
          if (!record?.credentialRef) throw new Error("Could not store the v2 collaboration credential");
          const credentialRef = record.credentialRef;
          const catalog = await new CollabControlV2Client(v2Invite.deployment, v2Invite.projectInstanceId, v2Invite.guestSecret).catalog();
          const roomName = catalog.name ?? v2Invite.projectName ?? record.title;
          const workspace = await invoke<ProjectSnapshot>("create_collab_join_workspace", { room: shortRoom.slice(-6), projectName: roomName });
          // Joining is an in-place project transition. Bind the backend window
          // before exposing the new root to editor and collaboration effects.
          const snapshot = await invoke<ProjectSnapshot>("open_project", { path: workspace.root });
          openedJoinWorkspace = true;
          record = { ...record, projectRoot: snapshot.root, title: roomName, lastUsed: Date.now() };
          rememberCollabProjectV2(record);
          await enterProject(snapshot, { skipCollabLifecycle: true, deferInitialBuild: true });
          setCollabProjectName(record.title);
          const joined = await connectSharedWorkspace(snapshot.root, {
            deployment: v2Invite.deployment, projectInstanceId: v2Invite.projectInstanceId, credentialRef, store,
            permission: v2Invite.permission, track: (started) => { controller = started; },
          });
          setCollabStatus("synced");
          setNotice(`Joined v2 shared workspace · ${joined.fileCount()} files`);
          playInterfaceSound("collaboration-ready");
        } catch (reason) {
          setCollabReady(false);
          await discardSharedController(controller);
          let restoreError: unknown;
          if (openedJoinWorkspace && priorRoot) {
            try {
              const previous = await invoke<ProjectSnapshot>("open_project", { path: priorRoot });
              await enterProject(previous, { skipCollabLifecycle: true });
            } catch (restoreReason) {
              restoreError = restoreReason;
            }
          }
          preCollabProjectRootRef.current = null;
          clearPreCollabProjectRoot();
          cancelProjectTransition();
          setCollabStatus("error");
          setError(toMessage(restoreError === undefined ? reason : restoreError));
        } finally {
          setBusyLabel(null);
        }
      })();
      return;
    }
    setError("That invite is not a v2 collaboration invite — ask the host for a fresh one from Copy invite.");
  }, [
    cancelProjectTransition, collabInvite, collabName, collabRoom, connectSharedWorkspace, discardSharedController,
    enterProject, preCollabProjectRootRef, project, save, setCollabProjectName, setCollabStatus,
    startProjectTransition, unsavedEdits,
  ]);

  /// Startup reads this rather than depending on `rejoinCollabProjectV2`,
  /// whose identity churns; the boot effect must run exactly once.
  const pendingJoinRef = useRef<((record: CollabProjectRecordV2) => void) | null>(null);

  const rejoinCollabProjectV2 = useCallback((record: CollabProjectRecordV2) => {
    if (!isCollabEnabled()) return;
    void (async () => {
      setBusyLabel("Rejoining v2 collaboration…");
      let controller: CollabProjectControllerV2 | null = null;
      try {
        const store = collabCredentialStore();
        const credentialRef = await requireRememberedV2Credential(record, store);
        if (unsavedEdits && !(await save())) return;
        let root = record.projectRoot;
        if (root && root !== project?.root) {
          if (!await startProjectTransition()) return;
          await enterProject(await invoke<ProjectSnapshot>("open_project", { path: root }), { skipCollabLifecycle: true, deferInitialBuild: true });
        } else if (!root) {
          if (!await startProjectTransition()) return;
          const snapshot = await invoke<ProjectSnapshot>("create_collab_join_workspace", { room: record.projectInstanceId.slice(-6), projectName: record.title });
          root = snapshot.root;
          await enterProject(snapshot, { skipCollabLifecycle: true, deferInitialBuild: true });
        }
        if (!root) throw new Error("The remembered collaboration has no workspace");
        setCollabProjectName(record.title);
        await connectSharedWorkspace(root, {
          deployment: record.host, projectInstanceId: record.projectInstanceId, credentialRef, store,
          permission: record.permission, track: (started) => { controller = started; },
        });
        rememberCollabProjectV2({ ...record, projectRoot: root, lastUsed: Date.now() });
        refreshRecentRooms();
        setCollabStatus("synced");
        playInterfaceSound("collaboration-ready");
      } catch (reason) {
        await discardSharedController(controller);
        cancelProjectTransition();
        // Closing a room revokes every grant with it, so a guest's credential
        // stops authenticating the moment the host ends the share (or removes
        // them). Either way this entry can now only be clicked and fail, so
        // retire it instead of leaving a dead room in the list.
        const gone = reason instanceof CollabControlErrorV2 && (reason.status === 401 || reason.status === 404);
        if (gone && record.permission !== "host") {
          forgetCollabProjectV2(record.host, record.projectInstanceId);
          refreshRecentRooms();
          setCollabStatus("disconnected");
          setNotice(`“${record.title}” is no longer available — the host ended it. Removed from your list.`, SHARE_SOURCE);
          return;
        }
        setError(toMessage(reason));
        setCollabStatus("error");
      } finally {
        setBusyLabel(null);
      }
    })();
  }, [
    cancelProjectTransition, connectSharedWorkspace, discardSharedController, enterProject, project?.root,
    refreshRecentRooms, save, setCollabProjectName, setCollabStatus, startProjectTransition, unsavedEdits,
  ]);

  useEffect(() => {
    pendingJoinRef.current = rejoinCollabProjectV2;
  }, [rejoinCollabProjectV2]);

  const chooseExisting = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "Open a LaTeX project" });
    if (!selected) return;
    // Same rule as the recent-projects list: a window in use keeps the project
    // it has, and the chosen one gets a window of its own.
    if (project?.root) await openProjectWindow(String(selected));
    else await switchProject("Opening project…", String(selected));
  }, [openProjectWindow, project?.root, switchProject]);

  const createProject = useCallback(async () => {
    if (!createForm.name.trim()) {
      updateCreateForm({ error: "Enter a project name." });
      return;
    }
    const parent = await open({ directory: true, multiple: false, title: "Choose where to create the project" });
    if (!parent) return;
    await revealNewProject("Creating project…", async () => {
      const snapshot = await invoke<ProjectSnapshot>("create_project", {
        parent, name: createForm.name, venue: createForm.venue,
      });
      updateCreateForm({ open: false });
      return snapshot.root;
    }, (reason) => updateCreateForm({ error: toMessage(reason) }));
  }, [createForm.name, createForm.venue, revealNewProject, updateCreateForm]);

  const openTutorialProject = useCallback(async () => {
    autoTutorialAttemptedRef.current = true;
    setBusyLabel("Preparing tutorial…");
    try {
      if (!(await save()) || !await startProjectTransition()) {
        autoTutorialAttemptedRef.current = false;
        return false;
      }
      const snapshot = await invoke<ProjectSnapshot>("open_tutorial_project");
      await enterProject(snapshot);
      setSidebarMode("project");
      setSidebarOpen(true);
      setCanvasMode("source");
      setTutorialStep(TUTORIAL_STEPS.welcome);
      setTutorialActive(true);
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
  }, [cancelProjectTransition, enterProject, save, setSidebarMode, setSidebarOpen, startProjectTransition]);
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
      title: "Export project ZIP",
      defaultPath: `${project.manifest.name.replace(/[\\/:*?"<>|]+/g, "-") || "project"}.zip`,
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
    if (!zipPath) return;
    setBusyLabel("Exporting ZIP…");
    try {
      if (!(await save())) return;
      await invoke("export_project_zip", { zipPath });
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [project, save]);

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
    await switchProject("Switching project…", path, () => setRecentProjects(forgetRecentProject(path)));
  }, [openProjectWindow, project?.root, switchProject]);

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
        if (!active) return;
        // Taken after the project is in, because acting on it needs the
        // window to already be showing the project it refers to. The backend
        // hands it over once, so a reload of this window will not rejoin.
        const raw = await invoke<string | null>("take_pending_window_action");
        if (!active || !raw) return;
        const action = JSON.parse(raw) as PendingWindowAction;
        if (isCollabEnabled() && action.kind === "join-collab-v2") {
          const record = loadCollabProjectsV2().find(
            (item) => item.host === action.host
              && item.projectInstanceId === action.projectInstanceId,
          );
          if (record) pendingJoinRef.current?.(record);
        }
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
    const documentDirty = Boolean(!activePaper && !activeAsset && activeFile && source !== savedSource);
    if (!project || (!documentDirty && !activePaperDirty)) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const automatic = !activePaper && buildPreferences.autoBuildMode === "automatic";
    // A completion menu is still part of the current edit. Saving and building
    // while its keyboard or pointer selection is in progress compiles the
    // temporary `\cite{}` buffer and can replace the menu with an error panel.
    if (automatic && editorCompletionActive) return;
    const delay = automatic ? 1_200 : 900;
    // Call through refs so enterProject / build state updates do not keep
    // resetting the idle timer (that starved autosave and left PDF stuck reloading).
    saveTimer.current = window.setTimeout(() => {
      if (automatic) void saveAndCompileAutomaticallyRef.current();
      else void saveRef.current();
    }, delay);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [
    activeFile, activeAsset, activePaper, activePaperDirty, buildPreferences.autoBuildMode,
    editorCompletionActive, paperBlog, paperMarkdown, project, savedPaperBlog, savedPaperMarkdown, savedSource,
    source,
  ]);

  // Every secondary text buffer needs an idle save, even without collaboration.
  useEffect(() => {
    if (!project || !secondaryFile) return;
    if (secondarySource === secondarySavedSource) return;
    const automatic = !activePaper && buildPreferences.autoBuildMode === "automatic";
    if (automatic && editorCompletionActive) return;
    const timer = window.setTimeout(() => {
      if (automatic) void saveAndCompileAutomaticallyRef.current();
      else void saveRef.current();
    }, automatic ? 1_200 : 450);
    return () => window.clearTimeout(timer);
  }, [activePaper, buildPreferences.autoBuildMode, editorCompletionActive, project, secondaryFile, secondarySavedSource, secondarySource]);

  const saveWhenLeavingEditor = useCallback(() => {
    if (editorCompletionActiveRef.current) return;
    // A visual edit may still be debounced, and its publication updates refs
    // before React commits. Flush first and never inspect render-time source.
    if (visualMarkdownFlushRef.current?.() === false) return;
    if (
      !activePaper
      && buildPreferences.autoBuildMode === "automatic"
      && (sourceRef.current !== savedSourceRef.current
        || secondarySourceRef.current !== secondarySavedRef.current)
    ) {
      void saveAndCompileAutomatically();
    } else {
      // Saving on attention changes is independent of automatic compilation
      // and includes dirty secondary and paper buffers.
      void save();
    }
  }, [
    activePaper, buildPreferences.autoBuildMode, save, saveAndCompileAutomatically, savedSourceRef,
    secondarySavedRef, secondarySourceRef, sourceRef,
  ]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save().then((saved) => {
          if (!saved) return;
          void flushDeferredWholeFileSync();
          if (!activePaper) void compile();
        });
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void chooseExisting();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activePaper, chooseExisting, compile, flushDeferredWholeFileSync, save]);

  const referenceImport = useReferenceImport({
    project, projectRootRef, refreshProject, refreshHistory, publishToShare: publishTextToCollabV2,
    shared: Boolean(collabSession),
    editor: {
      activeFile,
      source,
      dirty: source !== savedSource,
      save,
      commit: commitPrimaryText,
    },
    onCite: (key) => insertCitation(key, "cite"),
  });
  const { clearStage: clearImportStage } = referenceImport;

  const openPaper = useCallback(async (
    paper: PaperSummary,
    reservedLoadGeneration?: number,
  ) => {
    cancelPreviewPrewarm();
    const switchStartedAt = performance.now();
    // Publish the old visual document while its path and setter still own the
    // buffer. Saving first leaves TipTap's deferred final update behind; the
    // following Paper render can then route that old update into Paper state.
    if (
      reservedLoadGeneration !== undefined
      && reservedLoadGeneration !== fileLoadGenerationRef.current
    ) return null;
    const loadGeneration = reservedLoadGeneration ?? fileLoadGenerationRef.current + 1;
    if (reservedLoadGeneration === undefined) fileLoadGenerationRef.current = loadGeneration;
    paperLoadGenerationRef.current = loadGeneration;
    const ownsProject = captureProjectScope();
    const isLatestLoad = () => loadGeneration === fileLoadGenerationRef.current && ownsProject();
    const clearOpening = () => setPrimaryOpening((current) => (
      current?.generation === loadGeneration ? null : current
    ));
    setPrimaryOpening({ generation: loadGeneration, label: paper.title });
    try {
      await afterNextPaintOpportunity();
      const openingPaintMs = performance.now() - switchStartedAt;
      if (!isLatestLoad()) return null;
      const flushStartedAt = performance.now();
      if (visualMarkdownFlushRef.current?.() === false) return null;
      const flushMs = performance.now() - flushStartedAt;
      const contentLoadStartedAt = performance.now();
      const readPaper = () => readPaperDocuments(paper.arxivId);
      const isPaperDocument = (path: string | null) => (
        path === paperDocumentPath(paper.arxivId, "fulltext") || path === paperDocumentPath(paper.arxivId, "blog")
      );
      const targetAliasesDirtyBuffer = (activePaper?.arxivId === paper.arxivId && paperBuffersDirty())
        || (isPaperDocument(activeFile) && sourceRef.current !== savedSourceRef.current)
        || (isPaperDocument(secondaryFile) && secondarySource !== secondarySavedSource);
      // A dirty buffer holding one of this Paper's files must reach disk before
      // the read; otherwise the save and the read are independent.
      const results = targetAliasesDirtyBuffer
        ? (await save()) && isLatestLoad() ? await readPaper() : null
        : await Promise.all([save(), readPaper()]).then(([saved, loaded]) => (saved ? loaded : null));
      if (!results) return null;
      const { markdown: fullText, blog, failure } = results;
      if (!isLatestLoad()) return null;
      if (!fullText && !blog) throw failure ?? new Error(t`No readable paper content is available.`);
      // The old editor stayed live while save/read ran. If it changed in that
      // interval, keep it on screen for autosave instead of replacing it with
      // the Paper and dropping the late edit.
      if (flushAndCheckPrimaryDirty()) return null;
      setPaperBuffers(fullText, blog);
      setPaperView((current) => preferredPaperView(current, fullText, blog));
      if (!fullText && blog) setNotice("Full paper text is unavailable; showing the overview instead.");
      setActivePaper(paper);
      setPaperSide("left");
      showActiveAsset(null);
      setFocusedPane("primary");
      setCanvasMode("pdf");
      addOpenTab(paperTabKey(paper.arxivId));
      recordNavigationTiming("paper", paper.title, switchStartedAt, {
        openingPaintMs, flushMs, saveAndReadMs: performance.now() - contentLoadStartedAt,
      });
      return { hasBlog: blog !== null, hasFullText: Boolean(fullText) };
    } catch (reason) {
      if (isLatestLoad()) setError(toMessage(reason));
      return null;
    } finally {
      clearOpening();
      if (paperLoadGenerationRef.current === loadGeneration) paperLoadGenerationRef.current = null;
    }
  }, [
    activeFile, activePaper, addOpenTab, cancelPreviewPrewarm, flushAndCheckPrimaryDirty, paperBuffersDirty,
    save, savedSourceRef, secondaryFile, secondarySavedSource, secondarySource, setActivePaper, setPaperBuffers,
    setPaperSide, setPaperView, showActiveAsset, sourceRef, t, captureProjectScope,
  ]);

  /** Opening the tour's sample paper moves the tour on to the reading step it offers. */
  const advanceTutorialPastPaper = useCallback((arxivId: string, opened: { hasBlog: boolean } | null) => {
    if (!tutorialActive || tutorialStep !== TUTORIAL_STEPS.importVit || arxivId !== "2010.11929") return;
    if (opened?.hasBlog) changePaperView("blog");
    setTutorialStep(opened?.hasBlog ? TUTORIAL_STEPS.paperBlog : TUTORIAL_STEPS.paperFullText);
  }, [changePaperView, tutorialActive, tutorialStep]);

  const fetchAndOpenPaper = useCallback(async (paper: PaperSummary) => {
    if (!canDownloadPaper(paper)) {
      if (paper.url) {
        try { await openUrl(paper.url); } catch (reason) { setError(toMessage(reason)); }
      }
      return;
    }
    // Reserve the navigation when the user asks, not after a potentially slow
    // network fetch. Any later file/Paper/asset click invalidates this token.
    const loadGeneration = fileLoadGenerationRef.current + 1;
    fileLoadGenerationRef.current = loadGeneration;
    paperLoadGenerationRef.current = loadGeneration;
    setPrimaryOpening(null);
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
      if (fileLoadGenerationRef.current !== loadGeneration) return;
      const opened = await openPaper(fetched, loadGeneration);
      if (!opened || fileLoadGenerationRef.current !== loadGeneration) return;
      advanceTutorialPastPaper(result.arxivId, opened);
    } catch (reason) {
      clearFetchState();
      if (fileLoadGenerationRef.current === loadGeneration) setError(toMessage(reason));
    } finally {
      if (paperLoadGenerationRef.current === loadGeneration) paperLoadGenerationRef.current = null;
      clearImportStage();
    }
  }, [advanceTutorialPastPaper, clearImportStage, openPaper, refreshProject]);

  const readDraggedPaper = (paper: PaperSummary) => {
    if (paper.hasFullText || paper.hasBlog) void openPaper(paper);
    else if (paper.arxivId || paper.url) void fetchAndOpenPaper(paper);
    else setError(t`This paper has no local reading or downloadable source.`);
  };
  const [paperLookupRequest, setPaperLookupRequest] = useState(0);

  useEffect(() => () => {
    Object.values(paperFetchTimers.current).forEach((timer) => window.clearTimeout(timer));
  }, []);

  const openProjectAsset = useCallback(async (path: string) => {
    if (visualMarkdownFlushRef.current?.() === false) return false;
    const loadGeneration = fileLoadGenerationRef.current + 1;
    fileLoadGenerationRef.current = loadGeneration;
    setPrimaryOpening(null);
    const ownsProject = captureProjectScope();
    const isLatestLoad = () => loadGeneration === fileLoadGenerationRef.current && ownsProject();
    try {
      if (!(await save())) return false;
      if (!isLatestLoad()) return false;
      const asset = await invoke<AssetPreview>("read_project_asset", { path });
      if (!isLatestLoad() || flushAndCheckPrimaryDirty()) return false;
      addOpenTab(path);
      showActiveAsset(asset);
      closePaper();
      setCanvasMode("asset");
      setError(null);
      return true;
    } catch (reason) {
      if (isLatestLoad()) setError(toMessage(reason));
      return false;
    }
  }, [
    addOpenTab, closePaper, flushAndCheckPrimaryDirty, save, showActiveAsset, captureProjectScope,
  ]);

  type DropPaperContent = {
    kind: "paper";
    path: string;
    paper: PaperSummary;
    markdown: string;
    savedMarkdown: string;
    blog: string | null;
    savedBlog: string | null;
    view: "blog" | "fulltext";
  };
  type DropPaneContent =
    | { kind: "source"; path: string; source: string; savedSource: string }
    | { kind: "asset"; path: string; asset: AssetPreview }
    | DropPaperContent;

  const dropProjectPath = useCallback(async (
    path: string,
    zone: EditorDropZone,
    options?: { preserveSplitRatio?: boolean; preservePreview?: boolean },
  ) => {
    const viewGeneration = documentViewGenerationRef.current + 1;
    documentViewGenerationRef.current = viewGeneration;
    const hasExistingPaneDivider = options?.preserveSplitRatio
      || canvasMode === "split"
      || canvasMode === "dual"
      || canvasMode === "columns";
    let primaryLoadGeneration = fileLoadGenerationRef.current;
    const projectRoot = projectRef.current?.root;
    const ownsProject = captureProjectScope();
    const currentDualPreview = dualPanePreview?.projectRoot === projectRoot ? dualPanePreview : null;
    const previewPaths = new Set<string>([
      ...(canvasMode === "pdf" && activeFileRef.current ? [activeFileRef.current] : []),
      // Split's right side is a generated preview with no file identity. When
      // the left side is replaced, the displaced source becomes that right
      // pane and must carry the preview state into the normalized dual layout.
      ...(canvasMode === "split"
        && zone === "left"
        && !activeAssetRef.current
        && activeFileRef.current
        && !isOpenSlideDeckPath(activeFileRef.current)
        && isPreviewableSourceFilePath(activeFileRef.current)
        ? [activeFileRef.current]
        : []),
      ...(currentDualPreview
        ? [currentDualPreview.primaryPath, currentDualPreview.secondaryPath].filter(Boolean) as string[]
        : []),
    ]);
    const isCurrentDrop = () => (
      documentViewGenerationRef.current === viewGeneration
      && fileLoadGenerationRef.current === primaryLoadGeneration
      && ownsProject()
    );
    const sourceContent = (path: string, source: string, savedSource = source): DropPaneContent => (
      { kind: "source", path, source, savedSource }
    );
    const assetContent = (asset: AssetPreview | null): DropPaneContent | null => (
      asset && { kind: "asset", path: asset.path, asset }
    );
    const paperContent = (paper: PaperSummary, texts: Omit<DropPaperContent, "kind" | "path" | "paper">): DropPaneContent => (
      { kind: "paper", path: paperTabKey(paper.arxivId), paper, ...texts }
    );
    const activePaperContent = () => activePaper && paperContent(activePaper, {
      markdown: paperMarkdownRef.current, savedMarkdown: savedPaperMarkdownRef.current,
      blog: paperBlogRef.current, savedBlog: savedPaperBlogRef.current, view: paperView,
    });
    const primarySourceContent = () => (
      activeFileRef.current ? sourceContent(activeFileRef.current, sourceRef.current, savedSourceRef.current) : null
    );
    const secondaryContent = () => assetContent(secondaryAssetRef.current) ?? (secondaryFileRef.current
      ? sourceContent(secondaryFileRef.current, secondarySourceRef.current, secondarySavedRef.current)
      : null);
    const currentPanes = (): { left: DropPaneContent | null; right: DropPaneContent | null } => {
      const currentPaper = activePaperContent();
      const activeAssetContent = assetContent(activeAssetRef.current);
      if (currentPaper) {
        const other = secondaryContent();
        if (!isTwoPane(canvasMode) || !other) return { left: currentPaper, right: null };
        return paperSide === "right" ? { left: other, right: currentPaper } : { left: currentPaper, right: other };
      }
      if (canvasMode === "asset") return { left: activeAssetContent, right: null };
      if (isTwoPane(canvasMode)) return { left: activeAssetContent ?? primarySourceContent(), right: secondaryContent() };
      // Legacy source + asset splits stored the asset in activeAsset. Treat
      // it as the right pane while normalizing future drops to dual panes.
      if (canvasMode === "split") return { left: primarySourceContent(), right: activeAssetContent };
      // A generated preview has no independent file identity. The backing
      // source is the useful pane to preserve when a drop creates a split.
      return { left: primarySourceContent(), right: null };
    };
    const sameContent = (a: DropPaneContent | null, b: DropPaneContent | null) => (
      Boolean(a && b && a.path === b.path)
    );
    const updateDualPreviews = (left: DropPaneContent, right: DropPaneContent) => {
      const primaryPath = left.kind === "source" && previewPaths.has(left.path) ? left.path : null;
      const secondaryPath = right.kind === "source" && previewPaths.has(right.path) ? right.path : null;
      setDualPanePreview(projectRoot && (primaryPath || secondaryPath)
        ? { projectRoot, primaryPath, secondaryPath }
        : null);
    };
    /** Put a source or asset in the secondary pane (and its tab in the strip). */
    const showSecondary = (content: DropPaneContent) => {
      secondaryFileLoadGenerationRef.current += 1;
      if (content.kind === "source") showSecondaryText(content.path, content.source, content.savedSource);
      else showSecondaryText(null);
      showSecondaryAsset(content.kind === "asset" ? content.asset : null);
      addOpenTab(content.path);
    };
    const enterDual = (focus: EditorPaneId) => {
      documentModeRef.current = "dual";
      if (!hasExistingPaneDivider) setDualRatioResetGeneration((generation) => generation + 1);
      setCanvasMode("dual");
      setFocusedPane(focus);
      setError(null);
    };
    const loadDropContent = async (): Promise<DropPaneContent | null> => {
      if (isPaperTabKey(path)) {
        const currentPaper = activePaperContent();
        if (currentPaper?.path === path) return currentPaper;
        const paper = papers.find((item) => paperTabKey(item.arxivId) === path);
        if (!paper) return null;
        const { markdown, blog, failure } = await readPaperDocuments(paper.arxivId);
        if (!isCurrentDrop()) return null;
        if (!markdown && !blog) throw failure ?? new Error(t`No readable paper content is available.`);
        return paperContent(paper, {
          markdown, savedMarkdown: markdown, blog, savedBlog: blog, view: preferredPaperView(paperView, markdown, blog),
        });
      }
      if (isProjectAssetFilePath(path) || projectAssetPaths.has(path)) {
        const asset = await invoke<AssetPreview>("read_project_asset", { path });
        return isCurrentDrop() ? assetContent(asset) : null;
      }
      if (!isProjectSourceFilePath(path)) return null;
      if (path === activeFileRef.current) return primarySourceContent();
      if (path === secondaryFileRef.current) {
        return sourceContent(path, secondarySourceRef.current, secondarySavedRef.current);
      }
      const controller = collabV2ControllerRef.current;
      const content = activeCollabVersion === 2 && controller?.hasTextPath(path)
        ? (await controller.openPath(path, "secondary", { sideload: true })).toString()
        : await invoke<string>("read_project_file", { path, projectRoot });
      return isCurrentDrop() ? sourceContent(path, content) : null;
    };

    try {
      if (zone === "center") {
        if (isPaperTabKey(path)) {
          const paper = papers.find((item) => paperTabKey(item.arxivId) === path);
          if (!paper) return;
          const opening = openPaper(paper);
          primaryLoadGeneration = fileLoadGenerationRef.current;
          if (!(await opening) || !isCurrentDrop()) return;
          setPaperSide("left");
        } else if (isProjectAssetFilePath(path) || projectAssetPaths.has(path)) {
          const opening = openProjectAsset(path);
          primaryLoadGeneration = fileLoadGenerationRef.current;
          if (!(await opening) || !isCurrentDrop()) return;
        } else {
          const opening = openProjectFile(path, undefined, "primary");
          primaryLoadGeneration = fileLoadGenerationRef.current;
          await opening;
          if (!isCurrentDrop() || activeFileRef.current !== path) return;
          showActiveAsset(null);
          const standaloneMode = options?.preservePreview ? "pdf" : "source";
          if (isHtmlFilePath(path)) htmlViewModesRef.current.set(path, standaloneMode);
          else documentModeRef.current = standaloneMode;
          setCanvasMode(standaloneMode);
        }
        temporarilyPromotedSplitRef.current = null;
        setDualPanePreview(null);
        secondaryFileLoadGenerationRef.current += 1;
        clearSecondaryPane();
        setFocusedPane("primary");
        return true;
      }

      if (visualMarkdownFlushRef.current?.() === false || !(await save()) || !isCurrentDrop()) return;
      if (
        zone === "right"
        && path === activeFileRef.current
        && !activePaper
        && !activeAssetRef.current
        && canvasMode !== "dual"
        && canvasMode !== "columns"
      ) {
        const fallback = [...openTabs].reverse().find((candidate) => (
          candidate !== path
          && !isPaperTabKey(candidate)
          && !projectAssetPaths.has(candidate)
        ));
        if (!fallback) return;
        const outgoingSource = sourceRef.current;
        const outgoingSavedSource = savedSourceRef.current;
        const loadGeneration = fileLoadGenerationRef.current + 1;
        fileLoadGenerationRef.current = loadGeneration;
        primaryLoadGeneration = loadGeneration;
        const openedPrimary = await loadFile(fallback, {
          revealSource: true,
          loadGeneration,
          canCommit: () => (
            isCurrentDrop()
            && activeFileRef.current === path
            && sourceRef.current === outgoingSource
          ),
        });
        if (!openedPrimary || !isCurrentDrop()) return;
        const displaced = sourceContent(path, outgoingSource, outgoingSavedSource);
        showSecondary(displaced);
        updateDualPreviews(sourceContent(fallback, sourceRef.current, savedSourceRef.current), displaced);
        enterDual("secondary");
        return;
      }
      const target = await loadDropContent();
      if (!target || !isCurrentDrop()) return;
      // The target takes the dropped side. What it displaces moves across
      // when the other side is empty or was the target's old place.
      const current = currentPanes();
      const [near, far] = zone === "left" ? [current.left, current.right] : [current.right, current.left];
      if (sameContent(target, near)) {
        setFocusedPane(target.kind === "paper" || (zone === "left" && !activePaper) ? "primary" : "secondary");
        return;
      }
      const across = !far || sameContent(target, far) ? near : far;
      const [left, right] = zone === "left" ? [target, across] : [across, target];
      if (!left || !right || sameContent(left, right)) return;

      const arrangedPaper = left.kind === "paper"
        ? left
        : right.kind === "paper"
          ? right
          : null;
      if (arrangedPaper) {
        const other = left.kind === "paper" ? right : left;
        if (other.kind === "paper") return;
        fileLoadGenerationRef.current += 1;
        primaryLoadGeneration = fileLoadGenerationRef.current;
        setPrimaryOpening(null);
        setPaperBuffers(
          arrangedPaper.markdown,
          arrangedPaper.blog,
          arrangedPaper.savedMarkdown,
          arrangedPaper.savedBlog,
        );
        setPaperView(arrangedPaper.view);
        setActivePaper(arrangedPaper.paper);
        setPaperSide(left.kind === "paper" ? "left" : "right");
        showActiveAsset(null);
        addOpenTab(arrangedPaper.path);
        showSecondary(other);
        setDualPanePreview(null);
        enterDual(target.kind === "paper" ? "primary" : "secondary");
        return;
      }
      if (left.kind === "paper" || right.kind === "paper") return;

      if (left.kind === "source") {
        const opening = openProjectFile(left.path, undefined, "primary");
        primaryLoadGeneration = fileLoadGenerationRef.current;
        await opening;
        if (!isCurrentDrop() || activeFileRef.current !== left.path) return;
        showActiveAsset(null);
      } else {
        fileLoadGenerationRef.current += 1;
        primaryLoadGeneration = fileLoadGenerationRef.current;
        setPrimaryOpening(null);
        showActiveAsset(left.asset);
        closePaper();
        addOpenTab(left.path);
      }

      showSecondary(right);
      updateDualPreviews(left, right);
      enterDual(zone === "left" ? "primary" : "secondary");
    } catch (reason) {
      if (isCurrentDrop()) setError(toMessage(reason));
    }
  }, [
    activeAssetRef, activeCollabVersion, activeFileRef, activePaper, addOpenTab, canvasMode, clearSecondaryPane,
    closePaper, dualPanePreview, loadFile, openPaper, openProjectAsset, openProjectFile, openTabs, paperBlogRef,
    paperMarkdownRef, papers, paperSide, paperView, projectAssetPaths, projectRef, save, savedPaperBlogRef,
    savedPaperMarkdownRef, savedSourceRef, secondaryAssetRef, secondaryFileRef, secondarySavedRef,
    secondarySourceRef, setActivePaper, setPaperBuffers, setPaperSide, setPaperView, showActiveAsset,
    showSecondaryAsset, showSecondaryText, sourceRef, t, captureProjectScope,
  ]);
  const closeSplitView = useCallback(() => {
    if (!isTwoPane(canvasMode)) return;
    const focusedPath = focusedPane === "secondary"
      ? secondaryAsset?.path ?? secondaryFile
      : activePaper
        ? paperTabKey(activePaper.arxivId)
        : activeAsset?.path ?? activeFile;
    if (focusedPath) {
      void dropProjectPath(focusedPath, "center", { preservePreview: focusedPanePreview });
    }
  }, [
    activeAsset?.path, activeFile, activePaper, canvasMode, dropProjectPath, focusedPane, focusedPanePreview,
    secondaryAsset?.path, secondaryFile,
  ]);

  const closeEditorTab = useCallback(async (path: string) => {
    if (pinnedTabsRef.current.includes(path)) return;
    const remaining = openTabsRef.current.filter((tab) => tab !== path);
    // Source-backed modes must always retain a document. PDF is the one mode
    // where an empty tab strip is meaningful because the compiled preview can
    // stand on its own.
    if (!remaining.length && canvasMode !== "pdf") return;
    const finishClose = () => {
      setOpenTabs((tabs) => tabs.filter((tab) => tab !== path));
      tabRecency.current = tabRecency.current.filter((key) => key !== path);
      closedTabsRef.current = [path, ...closedTabsRef.current.filter((item) => item !== path)].slice(0, 20);
    };

    if (isTwoPane(canvasMode)) {
      const primaryPath = activePaper ? paperTabKey(activePaper.arxivId) : activeAsset?.path ?? activeFile;
      const secondaryPath = secondaryAsset?.path ?? secondaryFile;
      const closingPrimary = path === primaryPath;
      const survivingPath = closingPrimary ? secondaryPath : path === secondaryPath ? primaryPath : null;
      if (survivingPath && survivingPath !== path) {
        const currentDualPreview = dualPanePreview?.projectRoot === projectRef.current?.root ? dualPanePreview : null;
        const survivingPreview = currentDualPreview
          && (closingPrimary ? currentDualPreview.secondaryPath : currentDualPreview.primaryPath) === survivingPath;
        const closingDirtySource = (path === activeFile && sourceRef.current !== savedSourceRef.current)
          || (path === secondaryFile && secondarySourceRef.current !== secondarySavedRef.current);
        if (closingDirtySource && !(await save())) return;
        if (await dropProjectPath(survivingPath, "center", { preservePreview: Boolean(survivingPreview) }) !== true) return;
        finishClose();
        return;
      }
    }

    const closingActivePaper = Boolean(activePaper && paperTabKey(activePaper.arxivId) === path);
    const fileFallback = [...remaining].reverse().find((key) => !isPaperTabKey(key) && !projectAssetPaths.has(key));
    if (closingActivePaper) {
      const loadGeneration = fileLoadGenerationRef.current + 1;
      fileLoadGenerationRef.current = loadGeneration;
      setPrimaryOpening(null);
      // Deferred visual edits are not represented by activePaperDirty yet.
      // Flush before the dirty check and keep all ownership/tab mutations
      // behind a successful save and fallback load.
      if (visualMarkdownFlushRef.current?.() === false) return;
      if (paperBuffersDirty() && !(await save())) return;
      if (fileLoadGenerationRef.current !== loadGeneration || flushAndCheckPrimaryDirty("paper")) return;
      if (fileFallback) {
        const applied = await loadFile(fileFallback, {
          revealSource: true,
          loadGeneration,
          canCommit: () => !flushAndCheckPrimaryDirty("paper"),
        });
        if (!applied) return;
        setFocusedPane("primary");
      } else {
        closePaper();
        setCanvasMode((mode) => mode === "pdf" ? "split" : mode);
      }
    }
    finishClose();
    // The most recent still-open text file to fall back to (papers can't load
    // into the editor).
    if (isPaperTabKey(path)) return;
    if (projectAssetPaths.has(path)) {
      if (secondaryAsset?.path === path) {
        showSecondaryAsset(null);
        setFocusedPane("primary");
        setCanvasMode(activeAsset ? "asset" : "source");
        return;
      }
      if (activeAsset?.path === path) {
        showActiveAsset(null);
        if (isTwoPane(canvasMode)) {
          if (secondaryFile === activeFile) {
            showSecondaryText(null);
            setCanvasMode("source");
          }
          setFocusedPane("primary");
        } else if (fileFallback) await openProjectFile(fileFallback);
        else setCanvasMode((mode) => (mode === "asset" ? "split" : mode));
      }
      return;
    }
    if (path === secondaryFile) {
      showSecondaryText(null);
      setFocusedPane("primary");
    }
    if (path === activeFile && fileFallback) await openProjectFile(fileFallback);
  }, [
    activeAsset, activeFile, activePaper, canvasMode, closePaper, dropProjectPath, dualPanePreview,
    flushAndCheckPrimaryDirty, loadFile, openProjectFile, paperBuffersDirty, projectAssetPaths, projectRef,
    save, savedSourceRef, secondaryAsset, secondaryFile, secondarySavedRef, secondarySourceRef,
    showActiveAsset, showSecondaryAsset, showSecondaryText, sourceRef,
  ]);

  const dropProjectPathRef = useLatest(dropProjectPath);

  // Paper and asset tabs need their content loaded through their specialized
  // readers after the base project state exists. File tabs are restored inside
  // enterProject; this finishes the active surface without changing tab order.
  useEffect(() => {
    const pending = pendingWorkspaceSurfaceRef.current;
    if (!pending || pending.root !== project?.root) return;
    pendingWorkspaceSurfaceRef.current = null;
    void (async () => {
      if (isPaperTabKey(pending.activeTab)) {
        const arxivId = arxivIdFromTabKey(pending.activeTab);
        const paper = papers.find((item) => item.arxivId === arxivId);
        if (paper) {
          const opened = await openPaper(paper);
          if (!opened) return;
          if (projectRef.current?.root === pending.root) {
            changePaperView(pending.paperView);
            setCanvasMode(pending.canvasMode === "source" || pending.canvasMode === "split" ? pending.canvasMode : "pdf");
          }
        }
      } else if (!(await openProjectAsset(pending.activeTab))) return;
      if (projectRef.current?.root === pending.root) setWorkspacePersistenceReadyRoot(pending.root);
    })();
  }, [changePaperView, openPaper, openProjectAsset, papers, project?.root, projectRef]);

  const referenceImages = useReferenceImages(project?.root, references);

  const openProjectAssetFromClick = useCallback((path: string) => {
    if (suppressedFigureClick.current === path) {
      suppressedFigureClick.current = null;
      return;
    }
    void openProjectAsset(path);
  }, [openProjectAsset]);

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
        void openPaper(paper).then((opened) => {
          if (!opened) return;
          // Honor the view the link named when it is locally readable;
          // openPaper already fell back to whichever side exists.
          if (paperLink.view === "fulltext" && opened.hasFullText) changePaperView("fulltext");
          else if (paperLink.view === "blog" && opened.hasBlog) changePaperView("blog");
        });
        return;
      }
    }
    if (isProjectAssetFilePath(resolvedPath)) openProjectAssetFromClick(resolvedPath);
    else openProjectFileFromClick(resolvedPath);
  }, [changePaperView, openPaper, openProjectAssetFromClick, openProjectFileFromClick, papers, projectRef]);
  useEffect(() => {
    openMarkdownProjectPathRef.current = openMarkdownProjectPath;
  }, [openMarkdownProjectPath]);

  const beginProjectFigureDrag = useCallback((path: string, label: string, event: React.PointerEvent) => {
    trackProjectItemDrag(path, event, suppressedFigureClick, (pointer, preview) => {
      pointer.preventDefault();
      setProjectFileDropPreview(preview);
      setFigurePointerDrag({
        path, label, clientX: pointer.clientX, clientY: pointer.clientY, overCanvas: Boolean(preview), insertAtEditor: false,
      });
    }, () => {
      setProjectFileDropPreview(null);
      setFigurePointerDrag(null);
    }, (zone) => void dropProjectPathRef.current(path, zone));
  }, [dropProjectPathRef]);

  const beginProjectFileDrag = useCallback((path: string, _label: string, event: React.PointerEvent) => {
    trackProjectItemDrag(path, event, suppressedProjectFileClick, (pointer, preview) => {
      setFileDropTargetPane(editorPaneAt({ x: pointer.clientX, y: pointer.clientY }));
      setProjectFileDropPreview(preview);
    }, () => {
      setFileDropTargetPane(null);
      setProjectFileDropPreview(null);
    }, (zone) => void dropProjectPathRef.current(path, zone));
  }, [dropProjectPathRef]);

  const ensureSecondaryFile = useCallback(async (preferred?: string | null) => {
    const primaryPath = activeFileRef.current;
    const eligible = (path: string) => (
      path !== primaryPath && openTabs.includes(path) && !isPaperTabKey(path) && !projectAssetPaths.has(path)
    );
    const candidate = (preferred && eligible(preferred) ? preferred : null)
      ?? tabRecency.current.find(eligible)
      ?? (secondaryFile && secondaryFile !== primaryPath ? secondaryFile : null)
      ?? openTabs.find((path) => path !== primaryPath && path.endsWith(".tex"))
      ?? openTabs.find(eligible)
      ?? null;
    if (!candidate) return null;
    if (candidate === secondaryFile) return candidate;
    const requestGeneration = secondaryFileLoadGenerationRef.current + 1;
    secondaryFileLoadGenerationRef.current = requestGeneration;
    const projectRoot = projectRef.current?.root;
    const ownsProject = captureProjectScope();
    const primaryLoadGeneration = fileLoadGenerationRef.current;
    const isLatestRequest = () => (
      requestGeneration === secondaryFileLoadGenerationRef.current
      && ownsProject()
      && activeFileRef.current === primaryPath
      && fileLoadGenerationRef.current === primaryLoadGeneration
    );
    const controller = collabV2ControllerRef.current;
    const content = activeCollabVersion === 2 && controller?.hasTextPath(candidate)
      ? (await controller.openPath(candidate, "secondary", { sideload: true })).toString()
      : await invoke<string>("read_project_file", { path: candidate, projectRoot });
    if (!isLatestRequest()) return null;
    showSecondaryText(candidate, content);
    addOpenTab(candidate);
    return candidate;
  }, [
    activeCollabVersion, activeFileRef, addOpenTab, openTabs, projectAssetPaths, projectRef, secondaryFile,
    showSecondaryText, captureProjectScope,
  ]);

  const openDocumentMode = useCallback((mode: DocumentViewMode) => {
    const viewGeneration = documentViewGenerationRef.current + 1;
    documentViewGenerationRef.current = viewGeneration;
    const primaryLoadGeneration = fileLoadGenerationRef.current;
    const primaryPanePath = () => activeAssetRef.current?.path ?? activeFileRef.current;
    const secondaryPanePath = () => secondaryAssetRef.current?.path ?? secondaryFileRef.current;
    const isCurrentViewRequest = () => (
      documentViewGenerationRef.current === viewGeneration
      && fileLoadGenerationRef.current === primaryLoadGeneration
    );
    void (async () => {
      if (visualMarkdownFlushRef.current?.() === false) return;
      if (activePaperDirty && !(await save())) return;
      if (!isCurrentViewRequest()) return;
      if (activePaper) {
        markdownModeViewportCaptureRef.current?.();
        setCanvasMode(mode);
        return;
      }
      const promotedSplit = temporarilyPromotedSplitRef.current;
      if (mode === "source" && promotedSplit) {
        const canRestore = promotedSplit.projectRoot === projectRef.current?.root
          && primaryPanePath() === promotedSplit.splitPath
          && secondaryPanePath() === promotedSplit.primaryPath;
        if (canRestore) {
          const restoring = dropProjectPath(promotedSplit.primaryPath, "left", { preserveSplitRatio: true });
          const restoreGeneration = documentViewGenerationRef.current;
          await restoring;
          if (
            documentViewGenerationRef.current === restoreGeneration
            && primaryPanePath() === promotedSplit.primaryPath
            && secondaryPanePath() === promotedSplit.splitPath
          ) {
            temporarilyPromotedSplitRef.current = null;
            setDualPanePreview(null);
            documentModeRef.current = "dual";
            setFocusedPane("secondary");
            setCanvasMode("dual");
          }
          return;
        }
        temporarilyPromotedSplitRef.current = null;
      }
      if (
        (mode === "source" || mode === "pdf")
        && isTwoPane(canvasMode)
      ) {
        const projectRoot = projectRef.current?.root;
        if (!projectRoot) return;
        const panePath = focusedPane === "secondary" ? secondaryFile : activeFile;
        const paneAsset = focusedPane === "secondary" ? secondaryAsset : activeAsset;
        if (!panePath || paneAsset || !isPreviewableSourceFilePath(panePath)) return;
        setDualPanePreview((current) => {
          // The focused pane previews (pdf) or edits (source); the other pane keeps its state.
          const kept = current?.projectRoot === projectRoot ? current : null;
          const focusedPreview = mode === "pdf" ? panePath : null;
          const next = focusedPane === "secondary"
            ? { projectRoot, primaryPath: kept?.primaryPath ?? null, secondaryPath: focusedPreview }
            : { projectRoot, primaryPath: focusedPreview, secondaryPath: kept?.secondaryPath ?? null };
          return next.primaryPath || next.secondaryPath ? next : null;
        });
        documentModeRef.current = canvasMode;
        markdownModeViewportCaptureRef.current?.();
        return;
      }
      if (
        mode === "split"
        && isTwoPane(canvasMode)
        && focusedPane === "secondary"
        && secondaryFile
        && isPreviewableSourceFilePath(secondaryFile)
      ) {
        const originalPrimaryPath = primaryPanePath();
        const projectRoot = projectRef.current?.root;
        if (!originalPrimaryPath || !projectRoot || originalPrimaryPath === secondaryFile) return;
        const promoting = dropProjectPath(secondaryFile, "left");
        const promotionGeneration = documentViewGenerationRef.current;
        await promoting;
        if (
          documentViewGenerationRef.current !== promotionGeneration
          || primaryPanePath() !== secondaryFile
          || secondaryPanePath() !== originalPrimaryPath
        ) return;
        temporarilyPromotedSplitRef.current = { projectRoot, primaryPath: originalPrimaryPath, splitPath: secondaryFile };
        setDualPanePreview(null);
        if (isHtmlFilePath(secondaryFile)) htmlViewModesRef.current.set(secondaryFile, mode);
        else documentModeRef.current = mode;
        markdownModeViewportCaptureRef.current?.();
        setFocusedPane("primary");
        setCanvasMode(mode);
        return;
      }
      // Split/Preview temporarily hide the second editor, but do not discard
      // it. Returning to Edit restores the two files; a center drop remains the
      // explicit way to collapse the layout to one editor.
      const projectRoot = projectRef.current?.root;
      const preserveStandalonePreview = mode === "dual"
        && canvasMode === "pdf"
        && Boolean(projectRoot && activeFile && isPreviewableSourceFilePath(activeFile));
      setDualPanePreview(preserveStandalonePreview && projectRoot
        ? { projectRoot, primaryPath: activeFile, secondaryPath: null }
        : null);
      const nextMode = mode === "source"
        && (canvasMode === "split" || canvasMode === "pdf")
        && (secondaryFile || secondaryAsset)
        ? "dual"
        : mode;
      if (isHtmlFilePath(activeFile)) htmlViewModesRef.current.set(activeFile, nextMode);
      else documentModeRef.current = nextMode;
      showActiveAsset(null);
      closePaper();
      // PDF can stand alone without a source tab. Returning to any source-backed
      // view restores the active document to the strip before rendering it.
      if (nextMode !== "pdf" && activeFile) addOpenTab(activeFile);
      if (nextMode === "dual" || nextMode === "columns") {
        try {
          const openedSecondary = secondaryAsset ? secondaryAsset.path : await ensureSecondaryFile();
          if (!isCurrentViewRequest()) return;
          markdownModeViewportCaptureRef.current?.();
          setCanvasMode(nextMode);
          if (!openedSecondary) setFocusedPane("secondary");
        } catch (reason) {
          if (isCurrentViewRequest()) setError(toMessage(reason));
        }
        return;
      }
      if (!isCurrentViewRequest()) return;
      markdownModeViewportCaptureRef.current?.();
      setCanvasMode(nextMode);
    })();
  }, [
    activeAsset, activeAssetRef, activeFile, activeFileRef, activePaper, activePaperDirty, addOpenTab,
    canvasMode, closePaper, dropProjectPath, ensureSecondaryFile, focusedPane, projectRef, save,
    secondaryAsset, secondaryAssetRef, secondaryFile, secondaryFileRef, showActiveAsset,
  ]);

  const splitDocumentView = useCallback(() => {
    if (activePaper) return;
    if (activeAsset) {
      if (canvasMode === "asset") setCanvasMode("split");
      return;
    }
    if (canvasMode === "source" || canvasMode === "pdf") openDocumentMode("dual");
  }, [activeAsset, activePaper, canvasMode, openDocumentMode]);

  const swapEditorPanes = useCallback(async () => {
    if (!secondaryFile || !activeFile || secondaryFile === activeFile) return;
    const loadGeneration = fileLoadGenerationRef.current + 1;
    fileLoadGenerationRef.current = loadGeneration;
    setPrimaryOpening(null);
    const ownsProject = captureProjectScope();
    const isLatestSwap = () => fileLoadGenerationRef.current === loadGeneration && ownsProject();
    try {
      if (visualMarkdownFlushRef.current?.() === false) return;
      const outgoingPrimary = sourceRef.current;
      const outgoingSecondary = secondarySourceRef.current;
      if ((outgoingPrimary !== savedSourceRef.current || secondarySource !== secondarySavedSource) && !(await save())) return;
      if (!isLatestSwap()) return;
      const nextPrimary = secondaryFile;
      const nextSecondary = activeFile;
      // The primary pane must go through loadFile: in a v2 share it is the
      // pane bound to the controller's active doc, and a bare state swap left
      // activePath pointing at the old file — the editor unbound from yCollab
      // and keystrokes stopped syncing until the next real file switch.
      if (!(await loadFile(nextPrimary, {
        loadGeneration,
        canCommit: () => (
          isLatestSwap()
          && secondarySourceRef.current === outgoingSecondary
          && !flushAndCheckPrimaryDirty("file")
        ),
      }))) return;
      if (!isLatestSwap() || secondarySourceRef.current !== outgoingSecondary) return;
      // This is the exact outgoing primary buffer we just flushed and saved.
      // Re-reading it added an IPC round trip and left a stale continuation
      // capable of committing only half of a pane swap.
      showSecondaryText(nextSecondary, outgoingPrimary);
      setOpenTabs((tabs) => [...new Set([...tabs, nextPrimary, nextSecondary])]);
      setFocusedPane((pane) => (pane === "primary" ? "secondary" : "primary"));
      // loadFile may have retargeted the layout for the new primary's type;
      // a swap must land back in the supported two-editor mode either way.
      setCanvasMode("dual");
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [
    activeFile, flushAndCheckPrimaryDirty, loadFile, save, savedSourceRef, secondaryFile, secondarySavedSource,
    secondarySource, secondarySourceRef, showSecondaryText, sourceRef, captureProjectScope,
  ]);

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
        // Mid-share creates must join the v2 catalog before loadFile, so the
        // editor binds the shared doc instead of a local-only file.
        await shareCreatedFileWithCollabV2(createdPath, sharedTextKind(createdPath));
        // A local-only file has no Overleaf document id and therefore cannot
        // join realtime editing. Upload it before opening the editor so the
        // first keystroke does not have to wait for a later full-sync timer.
        if (overleafLink && overleafSyncMode === "live") {
          await overleafSyncRef.current({ auto: true });
        }
        await openProjectFile(createdPath);
      }
      return createdPath;
    } catch (reason) {
      setError(toMessage(reason));
      throw reason;
    }
  }, [
    allowViewState, openProjectFile, overleafLink, overleafSyncMode, overleafSyncRef, project?.root, refreshHistory,
    refreshProject, shareCreatedFileWithCollabV2,
  ]);
  useLayoutEffect(() => {
    const createAgentProjectDocument = async (request: AgentProjectDocumentToolRequest) => {
      if (!project?.root) {
        throw Object.assign(new Error("Open a Lattice project before creating a document."), {
          code: "project_document_project_unavailable",
        });
      }
      if (collabSession?.canWrite === false || !collabCanWrite) {
        throw Object.assign(
          new Error("This shared project is read-only, so it cannot create documents."),
          { code: "project_document_read_only" },
        );
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
  }, [collabCanWrite, collabSession?.canWrite, createProjectEntry, project?.root]);

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
      trace.ok(`Imported ${imported.length} figure${imported.length === 1 ? "" : "s"} into ${targetDirectory || "the project root"}.`);
      // A share failure raises its own notification and must survive this one.
      for (const path of imported) await shareCreatedFileWithCollabV2(path, "binary");
      return imported;
    } catch (reason) {
      trace.fail(reason);
      return [];
    } finally {
      setAssetImporting(false);
      setAssetDropTarget(null);
    }
  }, [allowViewState, assetImporting, project?.root, refreshProject, shareCreatedFileWithCollabV2, t]);

  /**
   * Run an import into the project tree and settle what it added: re-admit
   * the paths to view-state memory, refresh the tree and history, and
   * register each file with a live share.
   */
  const importIntoProject = useCallback(async (
    run: () => Promise<Array<{ path: string; kind: "text" | "board" | "spreadsheet" | "binary" }>>,
  ): Promise<string[]> => {
    if (assetImporting) return [];
    setAssetImporting(true);
    try {
      const imported = await run();
      for (const file of imported) allowViewState(file.path);
      await reconcileProjectTree();
      await refreshHistory();
      setError(null);
      // After setError(null): a share failure must remain visible.
      for (const file of imported) await shareCreatedFileWithCollabV2(file.path, file.kind);
      return imported.map((file) => file.path);
    } catch (reason) {
      setError(toMessage(reason));
      return [];
    } finally {
      setAssetImporting(false);
      setAssetDropTarget(null);
    }
  }, [allowViewState, assetImporting, reconcileProjectTree, refreshHistory, shareCreatedFileWithCollabV2]);

  const importProjectSources = useCallback(async (paths: string[], targetDirectory = "") => (
    paths.length ? importIntoProject(async () => (
      await invoke<string[]>("import_project_sources", { paths, targetDirectory, projectRoot: project?.root })
    ).map((path) => ({ path, kind: sharedTextKind(path) }))) : []
  ), [importIntoProject, project?.root]);

  /**
   * Finder-style tree drops: any mix of files and folders, routed by the
   * backend on content (UTF-8 text through the transaction log, the rest
   * copied). Returned file kinds drive collab share registration per file.
   */
  const importProjectFiles = useCallback(async (
    paths: string[],
    targetDirectory = "",
    copyExisting = false,
    browserFiles: File[] = [],
  ) => (paths.length || browserFiles.length ? importIntoProject(async () => {
    const uploads = browserFiles.length
      ? await Promise.all(browserFiles.map(async (file) => ({ name: file.name, base64: await fileToBase64(file) })))
      : undefined;
    return invoke<{ path: string; kind: "text" | "board" | "spreadsheet" | "binary" }[]>("import_project_files", {
      paths, targetDirectory, projectRoot: project?.root,
      ...(copyExisting ? { copyExisting: true } : {}), ...(uploads ? { uploads } : {}),
    });
  }) : []), [importIntoProject, project?.root]);

  useEffect(() => {
    if (!project || !browserHosted || isBundledChromium()) return;
    // Desktop Chromium already routes OS paths via BrowserEventRegistry.
    return listenForBrowserProjectDrops((files, target) => {
      void importProjectFiles([], target, false, files);
    }, setAssetDropTarget);
  }, [browserHosted, project, importProjectFiles]);

  const chooseProjectAssets = useCallback(async (targetDirectory = "figures") => {
    const selected = await open({
      multiple: true,
      title: `Import figures into ${targetDirectory}`,
      filters: [{ name: "Figures", extensions: ["png", "jpg", "jpeg", "pdf", "svg", "eps", "webp"] }],
    });
    if (!selected) return;
    await importProjectAssets(Array.isArray(selected) ? selected : [selected], targetDirectory);
  }, [importProjectAssets]);

  useEffect(() => {
    if (!project) return;
    let active = true;
    const clearDropHighlights = () => {
      nativeDragPathsRef.current = [];
      setAssetDropTarget(null);
      setNativeEditorDropActive(false);
      setFileDropTargetPane(null);
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
        const editorPath = editorPosition?.pane === "secondary" ? secondaryFileRef.current : activeFileRef.current;
        const insertsIntoEditor = Boolean(editorPosition && dropKind === "asset" && /\.(?:tex|md)$/i.test(editorPath ?? ""));
        // The tree accepts every drop kind, so the highlight only tracks
        // geometry (null when the pointer is not over the Project tree).
        setAssetDropTarget(targetDirectory);
        setNativeEditorDropActive(insertsIntoEditor);
        setAgentPanelDropActive(agentPanelTarget && dropKind !== "unsupported");
        // Sources open in the pane under the pointer; figures do too unless they insert into its text.
        const opensInPane = dropKind === "source" || (dropKind === "asset" && !insertsIntoEditor);
        setFileDropTargetPane(editorPosition && opensInPane ? editorPosition.pane : null);
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
              for (const path of paths) await openProjectFileRef.current(path, undefined, editorPosition?.pane ?? "primary");
            });
          } else if (targetDirectory !== null) {
            // The Project tree takes any mix, Finder-style, into the folder
            // under the pointer ("" is the project root). Imported files land
            // without opening; editor/canvas drops import and open instead.
            void importProjectFiles(event.payload.paths, targetDirectory);
          } else if (dropKind === "source") {
            setError("Drop source files onto an editor to open them, or into the Project pane to add them.");
          } else if (dropKind === "mixed") {
            setError("Drop source files and figures separately so Lattice knows whether to open or insert them.");
          } else if (dropKind === "unsupported") {
            setError("Lattice can open TeX, bibliography, Markdown, style, class, and text files dropped onto an editor.");
          } else if (editorPosition && insertsIntoEditor) {
            void importProjectAssets(event.payload.paths, "figures").then((paths) => {
              if (!paths.length) return;
              updateCanvasRequest("figure", {
                id: crypto.randomUUID(), paths, clientX: editorPosition.x, clientY: editorPosition.y, pane: editorPosition.pane,
              });
            });
          } else if (canvasTarget) {
            void importProjectAssets(event.payload.paths, "figures").then(async (paths) => {
              for (const path of paths) await openProjectAsset(path);
            });
          } else {
            setError("Drop image or PDF files onto a TeX/Markdown editor to insert them, onto an open document to import and open them, or into the Project pane to add them.");
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
    activeFileRef, importProjectAssets, importProjectFiles, importProjectSources, openProjectAsset,
    postSynaraMessage, project, secondaryFileRef, updateCanvasRequest, openProjectFileRef,
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

  const handleCompletionActiveChange = useCallback((active: boolean) => {
    editorCompletionActiveRef.current = active;
    setEditorCompletionActive(active);
  }, []);

  const gotoDefinition = useCallback(async (target: DefinitionTarget) => {
    if (!project) return;
    try {
      if (target.kind === "reference") {
        await openProjectFile(target.path, target.line);
        setError(null);
        return;
      }
      if (target.kind === "include" || target.kind === "asset") {
        // A relative \input or \includegraphics path may name a file below a
        // search directory rather than the project root.
        const paths = flattenProjectPaths(project.files);
        const resolved = paths.includes(target.path)
          ? target.path
          : paths.find((path) => path.endsWith(`/${target.path}`));
        if (!resolved) {
          setError(target.kind === "include"
            ? `Could not find included file “${target.path}”.`
            : `Could not find figure “${target.path}”.`);
          return;
        }
        if (target.kind === "include") await openProjectFile(resolved, 1);
        else await openProjectAsset(resolved);
        setError(null);
        return;
      }
      const bibliography = project.manifest.primaryBibliography;
      if (!bibliography) {
        setError("This project has no primary bibliography.");
        return;
      }
      const content = bibliography === activeFile
        ? source
        : await invoke<string>("read_project_file", { path: bibliography });
      const line = bibliographyEntryLine(content, target.key) ?? 1;
      await openProjectFile(bibliography, line);
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeFile, openProjectAsset, openProjectFile, project, source]);

  const deleteProjectEntries = useCallback(async (requestedPaths: string[]) => {
    const paths = [...new Set(requestedPaths.map((path) => path.replace(/[\\/]+$/, "")))]
      .filter((path, _index, candidates) => !candidates.some(
        (candidate) => candidate !== path && path.startsWith(`${candidate}/`),
      ));
    if (!paths.length) return;
    const wasDeleted = (candidate: string | null | undefined) => Boolean(
      candidate
      && paths.some((path) => candidate === path || candidate.startsWith(`${path}/`)),
    );
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
      for (const path of paths) {
        const v2 = collabV2ControllerRef.current;
        if (activeCollabVersion === 2 && v2) {
          await v2.delete(path, {
            rename: async () => { throw new Error("Unexpected rename during delete"); },
            delete: (localPath, projectRoot) => collabDiskWriteQueueRef.current.run(collabWorkspaceLeaseRef.current!, localPath, () => invoke("delete_project_entry", { path: localPath, projectRoot })),
          });
        } else await invoke("delete_project_entry", { path, projectRoot: project?.root });
      }

      // A successful disk deletion authoritatively retires every UI reference
      // to that path, including files removed through a deleted directory.
      const deletedActiveFile = wasDeleted(activeFile);
      const deletedSecondaryFile = wasDeleted(secondaryFile);
      const deletedActiveAsset = wasDeleted(activeAsset?.path);
      const deletedSecondaryAsset = wasDeleted(secondaryAsset?.path);
      const { tabs: remainingTabs } = forgetOpenPaths(wasDeleted);
      if (deletedActiveFile) {
        fileLoadGenerationRef.current += 1;
        collabDetachRef.current?.();
        collabDetachRef.current = null;
        setPrimaryOpening(null);
        showPrimaryText("", "");
      }
      if (deletedActiveAsset) showActiveAsset(null);
      if (deletedSecondaryFile || deletedSecondaryAsset) {
        secondaryFileLoadGenerationRef.current += 1;
        clearSecondaryPane();
        setFocusedPane("primary");
        if (
          isTwoPane(canvasMode)
          && !deletedActiveFile
          && !deletedActiveAsset
        ) {
          const nextMode = activeAsset
            ? "asset"
            : dualPanePreview?.primaryPath === activeFile
              ? "pdf"
              : "source";
          if (nextMode !== "asset") documentModeRef.current = nextMode;
          setCanvasMode(nextMode);
          setDualPanePreview(null);
        }
      }
      setDualPanePreview((preview) => {
        const kept = (path: string | null | undefined) => (path && !wasDeleted(path) ? path : null);
        const [primaryPath, secondaryPath] = [kept(preview?.primaryPath), kept(preview?.secondaryPath)];
        return preview && (primaryPath || secondaryPath) ? { ...preview, primaryPath, secondaryPath } : null;
      });
      forgetViewStates(paths, wasDeleted);
      const snapshot = await refreshProject();
      if (deletedActiveFile && !activeAsset && !activePaper) {
        const livePaths = new Set(flattenProjectPaths(snapshot.files));
        const rootDocument = snapshot.manifest.rootDocuments.find((document) => (
          document.isDefault && livePaths.has(document.path) && !wasDeleted(document.path)
        )) ?? snapshot.manifest.rootDocuments.find((document) => (
          livePaths.has(document.path) && !wasDeleted(document.path)
        ));
        const replacement = rootDocument?.path
          ?? remainingTabs.find((tab) => livePaths.has(tab) && isProjectSourceFilePath(tab))
          ?? [...livePaths].find(isProjectSourceFilePath);
        if (replacement) await loadFile(replacement);
      } else if (deletedActiveAsset) {
        setCanvasMode("split");
      }
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
  }, [
    activeAsset, activeCollabVersion, activeFile, activePaper, canvasMode, clearSecondaryPane, dualPanePreview,
    forgetViewStates, loadFile, overleafLink, project, projectOperationGenerationRef, refreshHistory,
    refreshProject, secondaryAsset, secondaryFile, settleRemoteDeletes, showActiveAsset, t, forgetOpenPaths,
    showPrimaryText,
  ]);

  const applyProjectEntryPathChanges = useCallback((changes: readonly ProjectPathChange[]) => {
    if (changes.length === 0) return;
    const remapPath = (path: string) => remapProjectPath(path, changes);

    remapViewStates(changes, remapPath);
    setProject((current) => current ? applyProjectPathChanges(current, changes) : current);
    setGitStatus((current) => ({
      ...current,
      files: current.files.map((file) => ({ ...file, path: remapPath(file.path) })),
    }));
    setOpenTabs((tabs) => tabs.map(remapPath));
    setPinnedTabs((tabs) => [...new Set(tabs.map(remapPath))]);
    remapOpenPaths(remapPath);
    setNavStack((entries) => entries.map((entry) => ({ ...entry, path: remapPath(entry.path) })));
    setViewRestore((request) => request ? { ...request, path: remapPath(request.path) } : request);
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

    tabRecency.current = tabRecency.current.map(remapPath);
  }, [remapOpenPaths, remapViewStates, setBuild, setGitStatus, setProject, setViewRestore]);

  const renameProjectEntry = useCallback((path: string, name: string) => withTreeMutation(async () => {
    try {
      const requestedPath = `${path.includes("/") ? `${path.slice(0, path.lastIndexOf("/") + 1)}` : ""}${name}`;
      const v2 = collabV2ControllerRef.current;
      const renamedPath = activeCollabVersion === 2 && v2
        ? await v2.rename(path, requestedPath, {
          rename: (oldPath, _newPath, projectRoot) => collabDiskWriteQueueRef.current.run(collabWorkspaceLeaseRef.current!, oldPath, () => invoke<string>("rename_project_entry", { path: oldPath, newName: name, projectRoot })),
          delete: async () => { throw new Error("Unexpected delete during rename"); },
        })
        : await invoke<string>("rename_project_entry", { path, newName: name, projectRoot: project?.root });
      const changes = [{ previousPath: path, nextPath: renamedPath }];
      applyProjectEntryPathChanges(changes);
      if (activeFileRef.current) void markDiskMtime(activeFileRef.current);
      setError(null);
      return renamedPath;
    } catch (reason) {
      setError(toMessage(reason));
      await reconcileProjectTree().catch(() => undefined);
      throw reason;
    }
  }), [
    activeCollabVersion, activeFileRef, applyProjectEntryPathChanges, markDiskMtime, project?.root,
    reconcileProjectTree, withTreeMutation,
  ]);

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
    const originalSecondaryPath = secondaryFileRef.current;
    let optimisticChangesApplied = false;
    return withTreeMutation(async () => {
      try {
        if (plannedChanges.some((change) => (
          /\.(?:tex|md)$/i.test(change.previousPath)
          && (
            change.previousPath === originalPrimaryPath
            || change.previousPath === originalSecondaryPath
          )
        ))) {
          if (visualMarkdownFlushRef.current?.() === false) {
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
          const v2 = collabV2ControllerRef.current;
          const movedPath = activeCollabVersion === 2 && v2
            ? await v2.rename(planned.previousPath, planned.nextPath, {
              rename: (oldPath, _newPath, projectRoot) => collabDiskWriteQueueRef.current.run(collabWorkspaceLeaseRef.current!, oldPath, () => invoke<string>("move_project_entry", { path: oldPath, targetDirectory: normalizedTarget, projectRoot })),
              delete: async () => { throw new Error("Unexpected delete during move"); },
            })
            : await invoke<string>("move_project_entry", {
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
            const content = activeCollabVersion === 2 && v2?.hasTextPath(movedPath)
              ? (await v2.openPath(movedPath, "secondary", { sideload: true })).toString()
              : planned.previousPath === originalPrimaryPath ? sourceRef.current
                : planned.previousPath === originalSecondaryPath ? secondarySourceRef.current
                  : await invoke<string>("read_project_file", { path: movedPath, projectRoot: project?.root });
            const rewritten = rewriteMovedDocumentAssetPaths(
              content,
              planned.previousPath,
              movedPath,
              projectAssetPaths,
            );
            if (rewritten !== content) {
              if (planned.previousPath === originalPrimaryPath) setPrimarySource(rewritten);
              if (planned.previousPath === originalSecondaryPath) setSecondarySourceLive(rewritten);
              if (!(await publishTextToCollabV2(movedPath, rewritten))) {
                await invoke("write_project_file", { path: movedPath, content: rewritten, projectRoot: project?.root });
              }
              if (planned.previousPath === originalPrimaryPath && sourceRef.current === rewritten) setPrimarySaved(rewritten);
              if (planned.previousPath === originalSecondaryPath && secondarySourceRef.current === rewritten) {
                setSecondarySaved(rewritten);
              }
            }
          }
        }
        if (activeFileRef.current) void markDiskMtime(activeFileRef.current);
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
    activeCollabVersion, activeFileRef, applyProjectEntryPathChanges, markDiskMtime, project?.root,
    projectAssetPaths, publishTextToCollabV2, reconcileProjectTree, save, secondaryFileRef, secondarySourceRef,
    setPrimarySource, setSecondarySourceLive, sourceRef, t, withTreeMutation, setPrimarySaved,
    setSecondarySaved,
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

  const findSymbolReferences = useCallback(async (target: SymbolTarget) => {
    try {
      await showSymbolReferences(target.kind, target.kind === "label" ? target.label : target.key);
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [showSymbolReferences]);

  const beginRename = useCallback((target: RenameTarget) => {
    setRenameError(null);
    setRenameTarget(target);
  }, []);
  const beginSymbolRename = useCallback((target: SymbolTarget) => beginRename(target.kind === "label"
    ? { kind: "label", label: target.label }
    : { kind: "citation", key: target.key }), [beginRename]);

  const openSymbolOccurrence = useCallback(async (occurrence: SymbolOccurrence) => {
    try {
      await openProjectFile(occurrence.path, occurrence.line);
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [openProjectFile]);

  /** Save pasted image bytes into the project (and a live share); resolves the new path. */
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
      // After setError(null): a share failure must remain visible.
      await shareCreatedFileWithCollabV2(path, "binary");
      return path;
    } catch (reason) {
      setError(toMessage(reason) || emptyMessage);
      return null;
    }
  }, [project?.root, refreshProject, shareCreatedFileWithCollabV2]);
  const importClipboardImageFile = useCallback((file: File) => importImageBytes(
    async () => ({ base64: await fileToBase64(file), type: file.type || "image/png" }),
    "figures",
  ), [importImageBytes]);
  const importSystemClipboardImage = useCallback(async (targetDirectory: string) => project ? importImageBytes(async () => {
    const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
    const image = await readImage();
    const size = await image.size();
    return { base64: await rgbaImageToPngBase64(await image.rgba(), size.width, size.height), type: "image/png" };
  }, targetDirectory, "No image found on the clipboard.") : null, [importImageBytes, project]);
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
      setError("Open a .tex file before pasting a figure.");
      return;
    }
    const path = await importSystemClipboardImage("figures");
    if (!path) return;
    setCanvasMode((mode) => (mode === "pdf" || mode === "asset" ? "split" : mode));
    insertFigureAtCaret(path);
  }, [activeFile, importSystemClipboardImage, insertFigureAtCaret, project]);

  const revealProjectItem = useCallback(async (relativePath: string) => {
    if (!project) return;
    try {
      await revealItemInDir(projectItemPath(project.root, relativePath));
      setError(null);
    } catch (reason) {
      setError(`Could not show that item in Finder. ${toMessage(reason)}`);
    }
  }, [project]);

  const deletePaper = useCallback(async (paper: PaperSummary) => {
    if (!paper.citationKey) {
      setError("This bibliography entry has no citation key to remove.");
      return;
    }
    const projectRoot = project?.root;
    if (!projectRoot) return;
    const operationIsCurrent = captureProjectScope();
    try {
      // The blocker scan runs in Rust against durable project files. Flush the
      // editor first so a citation removed moments ago does not survive only
      // on disk and produce a blocker the visible document cannot find.
      if (visualMarkdownFlushRef.current?.() === false) return;
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
        setError(first
          ? `The bibliography changed while removing \\cite{${paper.citationKey}} (${first.path}:${first.line}). Try again.`
          : `Could not remove \\cite{${paper.citationKey}}.`);
        return;
      }

      // The user or a collaborator can keep editing while the confirmation is
      // open. Rust returns the exact input/output pair for every file so the UI
      // can refuse to merge a stale whole-file result into a newer buffer.
      let conflictPath: string | null = null;
      for (const change of result.changes ?? []) {
        const diverged = (text: string) => text !== change.before && text !== change.after;
        if ((activeFileRef.current === change.path && diverged(sourceRef.current))
          || (secondaryFileRef.current === change.path && diverged(secondarySourceRef.current))) {
          conflictPath = change.path;
          break;
        }
        const controller = collabV2ControllerRef.current;
        if (activeCollabVersion === 2 && controller?.hasTextPath(change.path)) {
          const ytext = await controller.openPath(change.path, "secondary", { sideload: true });
          if (!operationIsCurrent()) return;
          if (diverged(ytext.toString())) {
            conflictPath = change.path;
            break;
          }
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
            ? `${conflictPath} changed while the reference was being removed. Nothing was removed; try again.`
            : `${conflictPath} changed while the reference was being removed. The newer text was preserved; review the removal in History.`);
          await refreshProject();
          await refreshHistory();
        }
        return;
      }

      const changedFiles = result.changedFiles?.length ? result.changedFiles : bibliographyPath ? [bibliographyPath] : [];
      const returnedChanges = new Map((result.changes ?? []).map((change) => [change.path, change.after]));
      for (const path of changedFiles) {
        const content = returnedChanges.get(path) ?? await invoke<string>("read_project_file", { path, projectRoot });
        const published = collabSession ? await publishTextToCollabV2(path, content) : false;
        if (!published && path === activeFile) {
          commitPrimaryText(content);
          await markDiskMtime(path);
        } else if (!published && path === secondaryFile) {
          commitSecondaryText(content);
        }
      }
      if (activePaper && paperKey(activePaper) === paperKey(paper)) {
        closePaper();
        setCanvasMode("split");
      }
      setError(null);
      await refreshProject();
      await refreshHistory();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [
    activeCollabVersion, activeFile, activeFileRef, activePaper, closePaper, collabSession, commitPrimaryText,
    commitSecondaryText, markDiskMtime, project, publishTextToCollabV2, refreshHistory, refreshProject, save,
    secondaryFile, secondaryFileRef, secondarySourceRef, sourceRef, t, captureProjectScope,
  ]);

  const openSettings = useCallback((tab: SettingsTab = "appearance") => {
    if (isSynaraSettingsTab(tab)) requestSynaraRuntime();
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, [requestSynaraRuntime]);

  /** Move this workspace to another surface (browser or desktop app): claim the switch, roll it back on failure. */
  const handOffWorkspace = async (blockedMessage: string, handOff: () => Promise<void>) => {
    if (!await startProjectTransition()) throw new Error(blockedMessage);
    try {
      await handOff();
    } catch (reason) {
      cancelProjectTransition();
      throw reason;
    }
  };

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
          if (isSynaraSettingsTab(tab)) synara.requestRuntime();
          setSettingsTab(tab);
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
        browserHosted={browserHosted}
        bundledChromium={bundledChromium}
        onOpenInBrowser={() => handOffWorkspace(t`Save the current workspace before opening it in a browser.`, async () => {
          if (bundledChromium) {
            await invoke("open_in_system_browser");
            setSettingsOpen(false);
            // The native workspace is not changing ownership yet. It stays
            // parked behind a status screen only while the system-browser
            // peer is connected, then reloads into the same Chromium window.
            cancelProjectTransition();
            return;
          }
          await invoke("open_in_browser");
          setSettingsOpen(false);
          // The existing close-request path leaves collaboration presence
          // before destruction. The backend activates the browser only once
          // that cleanup completes, so the two surfaces never edit together.
          await getCurrentWindow().close();
        })}
        onReturnToDesktop={() => handOffWorkspace(t`Save the current workspace before opening it in the desktop app.`, async () => {
          await invoke("return_to_desktop");
          setSettingsOpen(false);
        })}
        appearance={appearance}
        setAppearance={setAppearance}
        localSemanticSearchEnabled={semanticSearch.enabled}
        localSemanticSearchStatus={semanticSearch.status}
        onLocalSemanticSearchEnabledChange={semanticSearch.changeEnabled}
        theme={theme}
        themePreference={themePreference}
        setThemePreference={setThemePreference}
        buildPreferences={buildPreferences}
        setBuildPreferences={setBuildPreferences}
        hasProject={Boolean(project)}
        project={project}
        onUpdateManifest={async (patch) => {
          try {
            const manifest = patch.spellingWords != null
              ? await invoke<ProjectManifest>("set_project_spelling_words", { words: patch.spellingWords })
              : await invoke<ProjectManifest>("update_project_manifest", patch);
            setProject((current) => current ? { ...current, manifest } : current);
            setError(null);
          } catch (reason) {
            setError(toMessage(reason));
          }
        }}
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
          void revealNewProject("Opening the Overleaf project…", async () => root).then((opened) => {
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
  // Live buffers participate in the project-wide TeX derivations below
  // (outline, macros, labels, appendix) only for .tex files. Deriving the
  // nullable scalars here keeps every downstream memo inert while typing
  // Markdown — `null` is Object.is-stable across keystrokes, so the maps and
  // the parse chains behind them stop recomputing per character. For .tex the
  // scalar tracks `source` exactly, preserving today's behavior.
  const activeTexSource = activeFile.endsWith(".tex") ? source : null;
  const secondaryTexSource = secondaryFile?.endsWith(".tex") ? secondarySource : null;
  const liveOutlineSources = useMemo(() => ({
    ...outlineSources,
    ...(activeTexSource != null ? { [activeFile]: activeTexSource } : {}),
  }), [activeFile, activeTexSource, outlineSources]);
  useEffect(() => {
    if (!project || !outlineOpen || !rootDocumentPath) return;
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
  }, [liveOutlineSources, outlineOpen, project, projectPaths, rootDocumentPath]);
  const outlineNodes = useMemo(() => {
    if (!rootDocumentPath) return [];
    return parseProjectOutline(rootDocumentPath, liveOutlineSources, projectPaths);
  }, [liveOutlineSources, projectPaths, rootDocumentPath]);
  const liveReferences = useMemo(() => {
    let merged = references;
    if (activeTexSource != null) {
      merged = mergeReferences(merged, activeFile, parseLocalLabels(activeFile, activeTexSource));
    }
    if (secondaryFile && secondaryTexSource != null) {
      merged = mergeReferences(merged, secondaryFile, parseLocalLabels(secondaryFile, secondaryTexSource));
    }
    return merged;
  }, [activeFile, activeTexSource, references, secondaryFile, secondaryTexSource]);
  const activeOutlineId = useMemo(() => {
    if (!activeFile.endsWith(".tex") || !editorPosition) return null;
    return activeOutlineNode(outlineNodes, activeFile, editorPosition.line)?.id ?? null;
  }, [activeFile, editorPosition, outlineNodes]);
  // Tab dirtiness is a boolean, but deriving it inside the memo made the whole
  // tab list a fresh array on every keystroke — and the list feeds the tab
  // strip, the sidebar fit, and the active-tab lookup. Compare the buffers
  // here so the memo only recomputes when a document actually becomes dirty.
  const primarySourceDirty = source !== savedSource;
  const secondarySourceDirty = Boolean(secondaryFile) && secondarySource !== secondarySavedSource;
  // Stable handlers: EditorTabs is memoized, and inline arrows here would hand
  // it a new identity on every keystroke, defeating that.
  const selectEditorTab = useCallback((path: string) => {
    if (isPaperTabKey(path)) {
      if (activePaper && paperTabKey(activePaper.arxivId) === path) {
        setFocusedPane("primary");
        return;
      }
      const paper = papers.find((item) => item.arxivId === arxivIdFromTabKey(path));
      if (paper) void openPaper(paper);
      else void closeEditorTab(path);
    } else if (isTwoPane(canvasMode) && (secondaryAsset?.path === path || secondaryFile === path)) {
      setFocusedPane("secondary");
    } else if (projectAssetPaths.has(path)) {
      void openProjectAsset(path);
    } else {
      void openProjectFile(path);
    }
  }, [
    activePaper, canvasMode, closeEditorTab, openPaper, openProjectAsset, openProjectFile, papers,
    projectAssetPaths, secondaryAsset?.path, secondaryFile,
  ]);
  const requestCloseEditorTab = useCallback((path: string) => {
    void closeEditorTab(path);
  }, [closeEditorTab]);
  const setEditorTabPinned = useCallback((path: string, pinned: boolean) => {
    setPinnedTabs((tabs) => pinned
      ? tabs.includes(path) ? tabs : [...tabs, path]
      : tabs.filter((tab) => tab !== path));
    setOpenTabs((tabs) => {
      const without = tabs.filter((tab) => tab !== path);
      const pinnedCount = without.filter((tab) => pinnedTabsRef.current.includes(tab)).length;
      without.splice(pinnedCount, 0, path);
      return without;
    });
  }, []);
  const editorTabItems = useMemo(() => openTabs.map((path): EditorTab => {
    const pinned = pinnedTabs.includes(path);
    const twoPane = isTwoPane(canvasMode);
    if (isPaperTabKey(path)) {
      const id = arxivIdFromTabKey(path);
      const open = activePaper?.arxivId === id;
      const label = papers.find((paper) => paper.arxivId === id)?.title ?? "Paper";
      return { path, pinned, kind: "paper", label, dirty: open && activePaperDirty, beside: open && twoPane };
    }
    if (projectAssetPaths.has(path)) return { path, pinned, kind: "asset", beside: path === secondaryAsset?.path && twoPane };
    return {
      path,
      pinned,
      kind: "file",
      dirty: (path === activeFile && primarySourceDirty) || (path === secondaryFile && secondarySourceDirty),
      beside: (path === secondaryFile || path === secondaryAsset?.path) && twoPane,
    };
  }), [
    activeFile, activePaper?.arxivId, activePaperDirty, canvasMode, openTabs, papers, pinnedTabs, primarySourceDirty,
    projectAssetPaths, secondaryFile, secondaryAsset?.path, secondarySourceDirty,
  ]);
  useLayoutEffect(() => {
    fitSidebarToContent();
  }, [canvasMode, editorTabItems.length, fitSidebarToContent]);
  // The tab that reads as active: the open paper in paper mode, else the focused
  // editor pane. Also the key eviction must never close.
  const primaryTabKey = activePaper ? paperTabKey(activePaper.arxivId) : activeAsset?.path ?? activeFile;
  const activeTabKey = isTwoPane(canvasMode) && focusedPane === "secondary"
    ? secondaryAsset?.path ?? secondaryFile ?? primaryTabKey
    : primaryTabKey;
  // Whatever is on screen is the most-recently-used tab; the split's other pane
  // counts too. Tracking recency here covers every path that opens a tab.
  useEffect(() => {
    if (activeTabKey) noteTabActive(activeTabKey);
  }, [activeTabKey, noteTabActive]);
  useEffect(() => {
    if (secondaryFile && isTwoPane(canvasMode)) {
      noteTabActive(secondaryFile);
    }
  }, [canvasMode, noteTabActive, secondaryFile]);
  useEffect(() => {
    if (activeAsset) noteTabActive(activeAsset.path);
    if (secondaryAsset) noteTabActive(secondaryAsset.path);
  }, [activeAsset, noteTabActive, secondaryAsset]);
  // Cap open tabs: over the limit, close the least-recently-active tab that is
  // neither on screen nor the split's other pane (papers are never dirty; only
  // the active/secondary editors can be, and both are protected here).
  useEffect(() => {
    if (openTabs.length <= appearance.maxOpenTabs) return;
    const keep = new Set([
      activeTabKey,
      activeFile,
      activePaper ? paperTabKey(activePaper.arxivId) : null,
      secondaryFile,
      activeAsset?.path,
      secondaryAsset?.path,
    ].filter(Boolean) as string[]);
    const candidates = openTabs.filter((key) => !keep.has(key) && !pinnedTabs.includes(key));
    if (!candidates.length) return;
    const staleness = (key: string) => {
      const index = tabRecency.current.indexOf(key);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    const victim = candidates.reduce((worst, key) => (staleness(key) > staleness(worst) ? key : worst));
    setOpenTabs((tabs) => tabs.filter((key) => key !== victim));
    tabRecency.current = tabRecency.current.filter((key) => key !== victim);
  }, [
    openTabs, pinnedTabs, appearance.maxOpenTabs, activeTabKey, activeFile, activePaper, activeAsset?.path,
    secondaryAsset?.path, secondaryFile,
  ]);
  useEffect(() => {
    if (!project?.root || workspacePersistenceReadyRoot !== project.root) return;
    persistWorkspaceLayout(project.root, {
      openTabs,
      pinnedTabs,
      activeFile,
      activeTab: activeTabKey,
      secondaryFile,
      focusedPane,
      canvasMode,
      documentMode: documentModeRef.current,
      paperView,
      tabRecency: tabRecency.current.filter((path) => openTabs.includes(path)),
    });
  }, [
    activeFile, activeTabKey, canvasMode, focusedPane, openTabs, pinnedTabs, paperView, project?.root,
    secondaryFile, workspacePersistenceReadyRoot,
  ]);
  // Versionless arXiv ids whose full text is already in the library — the
  // Discover panel shows these hits as done instead of importable.
  const importedArxivIds = useMemo(
    () => new Set(papers.filter((paper) => paper.hasFullText && paper.arxivId).map((paper) => baseArxivId(paper.arxivId))),
    [papers],
  );
  const liveSourceMap = useMemo(() => ({
    ...outlineSources,
    ...(activeTexSource != null ? { [activeFile]: activeTexSource } : {}),
    ...(secondaryFile && secondaryTexSource != null ? { [secondaryFile]: secondaryTexSource } : {}),
  }), [activeFile, activeTexSource, outlineSources, secondaryFile, secondaryTexSource]);
  const liveMacroSources = useMemo(() => Object.values(liveSourceMap), [liveSourceMap]);
  const liveMacros = useMemo(() => parseLocalMacros(liveMacroSources), [liveMacroSources]);
  const graphicsRoots = useMemo(() => parseGraphicsPaths(liveMacroSources), [liveMacroSources]);
  const katexMacros = useMemo(() => katexMacrosFromSources(liveMacroSources), [liveMacroSources]);
  // TODOs come from .md buffers too (todo_source_path on the Rust side), so
  // this cannot ride the .tex-only scalars above. Deferring the source keeps
  // the merge off the paint-critical path: the badge/panel may lag a
  // keystroke under load, which is fine for a count.
  const deferredTodoSource = useDeferredValue(source);
  const todoHits = useMemo(
    () => mergeTodosWithBuffer(diskTodos, activeFile, deferredTodoSource),
    [activeFile, diskTodos, deferredTodoSource],
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
    const secondary = focusedPane === "secondary" && Boolean(secondaryFile);
    const path = secondary ? secondaryFile! : activeFile;
    const text = secondary ? secondarySource : source;
    if (!path.endsWith(".tex")) {
      setError("Open a .tex file before formatting.", "Format");
      return;
    }
    const trace = logAction("Format", "Format document", path);
    void import("./build/texlab-language")
      .then(({ formatLatexDocument }) => formatLatexDocument(path, text))
      .then((formatted) => {
        if (formatted === text) {
          trace.ok("Document is already formatted.");
          return;
        }
        (secondary ? setSecondarySource : setSource)(formatted);
        trace.ok("Formatted with latexindent.");
      })
      .catch((reason) => trace.fail(reason));
  };
  /**
   * Every app-level action, as the command palette lists it (entries with a
   * label) and as the global ⌘/Ctrl shortcuts reach it (entries with a key;
   * `shift` must match). `when: false` hides an entry and disables its key.
   */
  const commands: Array<{
    id: string;
    run: () => void;
    label?: string;
    detail?: string;
    group?: string;
    key?: string;
    shift?: boolean;
    when?: boolean;
  }> = [
    { id: "build", label: t`Build project`, detail: t`Compile LaTeX`, group: t`Build`, run: () => void compile(false, true) },
    { id: "rebuild", label: t`Clean rebuild`, detail: t`latexmk -c then -g`, group: t`Build`, run: () => void cleanAndRebuild() },
    { id: "clean", label: t`Clean aux files`, group: t`Build`, run: () => void cleanProject() },
    { id: "stop-build", label: t`Stop build`, group: t`Build`, run: () => void abortBuild() },
    { id: "sync-pdf", label: t`Jump to PDF`, detail: "⌘⇧J", group: t`Navigate`, key: "j", shift: true, run: () => void revealSourceInPdf() },
    { id: "quick-open", label: t`Quick open file`, detail: "⌘P", group: t`Navigate`, key: "p", run: () => setSearchDialog("quick-open") },
    { id: "goto-line", label: t`Go to line`, detail: "⌘G", group: t`Navigate`, key: "g", run: () => setSearchDialog("goto-line") },
    { id: "goto-symbol", label: t`Go to symbol`, detail: "⌘⇧O", group: t`Navigate`, key: "o", shift: true, run: () => setSearchDialog("goto-symbol") },
    { id: "back", key: "[", run: () => void navigateHistory(-1) },
    { id: "forward", key: "]", run: () => void navigateHistory(1) },
    { id: "palette", key: "p", shift: true, run: () => setCommandPaletteOpen(true) },
    { id: "reopen-tab", key: "t", shift: true, run: () => void reopenClosedTab() },
    {
      id: "view-dual", label: t`Dual source view`, detail: t`Two files side by side`, group: t`View`,
      when: !activePaper && !activeAsset && canvasMode === "source", run: () => openDocumentMode("dual"),
    },
    { id: "view-split", label: t`Source + PDF`, detail: t`split`, group: t`View`, run: () => openDocumentMode("split") },
    {
      id: "swap-panes", label: t`Swap editor panes`, detail: `${activeFile} ↔ ${secondaryFile}`, group: t`View`,
      when: canvasMode === "dual" && Boolean(secondaryFile), run: () => void swapEditorPanes(),
    },
    { id: "insert", label: t`Insert snippet`, detail: "⌘⇧I", group: t`Edit`, key: "i", shift: true, when: canInsert, run: () => setInsertOpen(true) },
    {
      id: "collab",
      label: collabSession ? t`Live sharing…` : t`Start / join live sharing`,
      detail: collabSession
        ? t({ message: `${collabPeers} connected · ${collabSession.room}` })
        : t`Share invite with a collaborator`,
      group: t`Edit`,
      when: isCollabEnabled(),
      run: () => openCollabDialog(),
    },
    { id: "table", label: t`Insert table`, detail: t`Grid generator`, group: t`Edit`, run: () => setTableGeneratorOpen(true) },
    { id: "cite", label: t`Insert citation`, detail: "⌘⇧K", group: t`Edit`, key: "k", shift: true, run: () => setSearchDialog("cite") },
    { id: "ref", label: t`Insert reference`, detail: "⌘⇧L", group: t`Edit`, key: "l", shift: true, run: () => setSearchDialog("ref") },
    { id: "bib", label: t`Add bibliography entry`, group: t`Edit`, run: () => referenceImport.openBibEntry() },
    { id: "discover", label: t`Discover literature`, detail: t`OpenAlex search`, group: t`Research`, run: () => referenceImport.setLiteratureOpen(true) },
    { id: "find", label: t`Find in project`, detail: t`⌘⇧F · source files and papers`, group: t`Edit`, key: "f", shift: true, run: openProjectFind },
    { id: "replace", label: t`Replace in project`, detail: t`⌘⇧H · all .tex files`, group: t`Edit`, key: "h", shift: true, run: openProjectReplace },
    {
      id: "todos", label: t`Manuscript TODOs`, detail: t({ message: `${todoHits.length || t`No`} markers` }), group: t`Edit`,
      run: () => {
        void refreshTodos();
        setTodosOpen(true);
      },
    },
    {
      id: "checklist", label: t`Submission checklist`, detail: t`Words / pages / TODOs`, group: t`Edit`,
      run: () => {
        void refreshTodos();
        void refreshWordCount();
        setChecklistOpen(true);
      },
    },
    { id: "paste-image", label: t`Paste clipboard image as figure`, group: t`Edit`, run: () => void pasteClipboardImage() },
    { id: "format", label: t`Format document`, detail: "latexindent", group: t`Edit`, run: formatFocusedDocument },
    { id: "history", label: t`Open project history`, group: t`Project`, run: () => setHistoryOpen(true) },
    { id: "export-zip", label: t`Export project ZIP`, detail: t`Overleaf / arXiv source pack`, group: t`Project`, run: () => void exportProjectZip() },
    {
      id: "tutorial", label: t`Open guided tutorial`, group: t`Project`, run: () => void openTutorialProject(),
      detail: t`Learn Lattice with the Understanding Attention sample project`,
    },
    { id: "doctor", label: t`Run TeX doctor`, group: t`Project`, run: () => openSettings("doctor") },
    { id: "settings", label: t`Open settings`, group: t`Project`, run: () => openSettings("appearance") },
  ];
  const runCommand = (id: string) => {
    const command = commands.find((item) => item.id === id);
    if (command && command.when !== false) command.run();
  };
  // Read at keypress, so a shortcut always runs the current render's closures.
  const commandsRef = useLatest(commands);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F8") {
        event.preventDefault();
        cycleDiagnostic(event.shiftKey ? -1 : 1);
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLocaleLowerCase();
      const command = commandsRef.current.find((item) => item.key === key && Boolean(item.shift) === event.shiftKey);
      if (!command || command.when === false) return;
      event.preventDefault();
      command.run();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cycleDiagnostic, commandsRef]);

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
          onJoinCollab={() => openCollabDialog("join")}
          onOpenTutorial={() => void openTutorialProject()}
          onSettings={() => openSettings("appearance")}
          onInstallTex={texSetup.openWizard}
          onOpenOverleaf={() => setOverleafPickerOpen(true)}
        />
        <AppCollabDialog
          collab={collab}
          session={collabSession}
          onJoin={joinCollabShare}
          onRejoin={rejoinCollabProjectV2}
          onInstallTex={texSetup.openWizard}
          joinOnly
        />
        {settingsDialog}
        {overleafPicker}
        {overleafReview}
        <TexSetupDialogs setup={texSetup} />
      </>
    );
  }

  const editorEditableForPath = (path: string, ignoreOverleaf = false) => (
    !compileRepair.busy && (collabSession?.canWrite !== false && collabCanWrite)
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

  const primaryOpenSlideActive = !activePaper
    && !activeAsset
    && isOpenSlideDeckPath(activeFile)
    && canvasMode !== "dual"
    && canvasMode !== "columns";

  return (
    <div
      className={`app-shell ${isFullscreen ? "fullscreen" : ""} ${browserHosted ? "browser-hosted" : ""}`}
      ref={shellRef}
    >
      <Suspense fallback={null}>
        <PaperLookupBridge
          state={{ projectRoot: project.root, papers, theme }}
          request={paperLookupRequest}
          onOpen={readDraggedPaper}
          onError={(reason) => setError(toMessage(reason))}
        />
      </Suspense>
      <AppTitlebar
        project={project}
        sidebar={sidebar}
        buildPipeline={buildPipeline}
        buildPreferences={buildPreferences}
        compile={compile}
        tabs={{
          tabs: editorTabItems,
          activePath: activeTabKey,
          animateLayout: !sidebarResizing,
          canCloseLast: canvasMode === "pdf",
          onDropTab: dropProjectPath,
          onSelect: selectEditorTab,
          onClose: requestCloseEditorTab,
          onSetPinned: setEditorTabPinned,
          onReorder: setOpenTabs,
        }}
        projectMenu={{
          open: projectMenuOpen,
          setOpen: setProjectMenuOpen,
          importing: referenceImport.importing,
          recentProjects,
          busyLabel,
          onRecent: chooseRecentProject,
          onOpen: () => void chooseExisting(),
          onNew: () => updateCreateForm({ open: true }),
          onOpenOverleaf: () => setOverleafPickerOpen(true),
          onOpenTutorial: () => void openTutorialProject(),
          onExportZip: () => void exportProjectZip(),
          onSettings: () => openSettings("appearance"),
        }}
        canvasToolbar={(
        <CanvasToolbar
          onPaperLookup={() => setPaperLookupRequest((request) => request + 1)}
          mode={canvasMode}
          selectedDocumentViewMode={focusedPanePreview ? "pdf" : undefined}
          setMode={openDocumentMode}
          supportsDocumentViewModes={paperFocused || (!focusedAsset && isPreviewableSourceFilePath(focusedDocumentPath))}
          onSplit={!isOpenSlideDeckPath(focusedDocumentPath) && !paperFocused && (activeAsset
            ? canvasMode === "asset"
            : canvasMode === "source" || (canvasMode === "pdf" && isPreviewableSourceFilePath(activeFile)))
            ? splitDocumentView
            : undefined}
          onCloseSplit={isTwoPane(canvasMode) ? closeSplitView : undefined}
          markdown={paperFocused || (!focusedAsset && focusedDocumentPath.toLocaleLowerCase().endsWith(".md"))}
          html={!paperFocused && !focusedAsset && isHtmlFilePath(focusedDocumentPath)}
          paperView={paperFocused ? paperView : undefined}
          paperHasBlog={paperBlog !== null}
          paperHasFullText={Boolean(paperMarkdown)}
          onPaperView={paperFocused ? (view) => {
            changePaperView(view);
            if (tutorialActive && tutorialStep === TUTORIAL_STEPS.paperBlog && view === "fulltext") {
              setTutorialStep(TUTORIAL_STEPS.paperFullText);
            }
          } : undefined}
          activePath={paperFocused ? activePaper?.title ?? activeTabKey : activeTabKey}
          activeKind={focusedAsset ? "asset" : paperFocused ? "paper" : "document"}
          canInsert={canInsert}
          dirty={paperFocused ? activePaperDirty : focusedPane === "secondary" ? secondarySourceDirty : primarySourceDirty}
          onInsert={() => setInsertOpen(true)}
          // The tour points these controls out rather than opening them, so
          // their panels stay shut while it runs.
          onCollab={outsideTour(() => openCollabDialog("start"))}
          collabLive={collabStatus === "synced" || collabStatus === "connecting"}
          collabPeers={collabPeers}
          collabPresence={collabPeerList.length > 0 ? (
            <AvatarGroup className="collab-peer-avatars" ariaLabel={t`People in this session`}>
              {collabPeerList.slice(0, 5).map((peer) => (
                <button
                  key={peer.clientId}
                  type="button"
                  className="collab-peer-avatar"
                  style={{ background: peer.color }}
                  title={peer.path
                    ? t({ message: `${peer.name} · ${peer.path} — click to follow` })
                    : peer.name}
                  onClick={() => void followCollabPeer(peer)}
                >
                  {peerInitials(peer.name)}
                </button>
              ))}
              {collabPeerList.length > 5 && (
                <span className="collab-peer-avatar more" title={collabPeerList.slice(5).map((peer) => peer.name).join(", ")}>
                  +{collabPeerList.length - 5}
                </span>
              )}
            </AvatarGroup>
          ) : null}
          onHistory={() => setHistoryOpen(true)}
          onGit={outsideTour(() => {
            synara.requestRuntime();
            setGitOpen(true);
          })}
          commentCount={editorComments.all.filter((comment) => !comment.resolved).length}
          onComments={editorComments.openPanel}
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
              pathForDoc={(id) => overleafDocPaths.get(id) ?? null}
              onJump={jumpToOverleafPeer}
            />
          ) : null}
          onOverleafSync={outsideTour(() => {
            // Manual mode is a review step, not a button that quietly
            // rewrites files: show what would change and let the user decide.
            if (overleafSyncMode === "manual") setOverleafReviewOpen(true);
            else void runOverleafSync();
          })}
          onOverleafOpenCurrent={overleafLink ? outsideTour(openCurrentOverleafProject) : undefined}
          onOverleafOpen={outsideTour(() => setOverleafPickerOpen(true))}
          overleafUnreadChat={
            overleafChat.unread + overleafComments.threads.filter((thread) => !thread.resolved).length + overleafRealtime.changes.length
            + editorComments.comments.filter((comment) => !comment.resolved).length
          }
          onOverleafChat={() => {
            editorComments.openPanel();
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

      <main
        className={`workspace ${sidebarOpen && !sidebarCollapsePreview ? "" : "sidebar-hidden"}`}
        data-sidebar-tracking={sidebarResizing && !sidebarCollapsePreview && !sidebarRestoring || undefined}
        data-sidebar-rebounding={sidebarRebounding || undefined}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && event.propertyName === "grid-template-columns") finishSidebarRestore();
        }}
        style={{
          gridTemplateColumns: sidebarOpen && !sidebarCollapsePreview ? `${sidebarDragWidth ?? sidebarWidth}px 1px minmax(0, 1fr)` : "0px 0px minmax(0, 1fr)",
          gridTemplateAreas: '"sidebar sidebar-resizer canvas"',
        }}
      >
          <AppWorkspaceSidebar
            sidebar={sidebar}
            synara={synara}
            agentVisible={agentVisible}
            agentPanelDropActive={agentPanelDropActive}
            appLocale={appLocale}
            theme={theme}
            project={project}
            chooseSidebarMode={chooseSidebarMode}
            onCheckReferences={() => { setBibliographyAuditRoot(project.root); setBibliographyAuditOpen(true); }}
            navigator={(
            <Suspense fallback={null}>
            <Navigator
              mode={sidebarMode === "papers" ? "papers" : "project"}
              projectKey={project.root}
              searchOpen={projectSearchOpen}
              boardCreateRequest={boardCreateRequest}
              spreadsheetCreateRequest={spreadsheetCreateRequest}
              presentationCreateRequest={presentationCreateRequest}
              onSearchOpenChange={setProjectSearchOpen}
              files={project.files}
              gitStatus={projectGit.gitFiles}
              activeFile={activeAsset || activePaper ? "" : activeFile}
              activeAssetPath={activeAsset?.path ?? ""}
              protectedPaths={[
                ...(rootDocumentPath ? [rootDocumentPath] : []),
                project.manifest.primaryBibliography,
              ]}
              papers={papers}
              activePaper={activePaper}
              onFile={openProjectFileFromClick}
              onLikelyFile={prewarmLikelyProjectFile}
              onAsset={openProjectAssetFromClick}
              onBeginFigureDrag={beginProjectFigureDrag}
              onBeginFileDrag={beginProjectFileDrag}
              onCreateEntry={createProjectEntry}
              onDeleteEntries={deleteProjectEntries}
              onRenameEntry={renameProjectEntry}
              onMoveEntries={moveProjectEntries}
              onCopyEntries={(paths, targetDirectory) => importProjectFiles(
                paths.map((path) => absoluteProjectPath(project.root, path)),
                targetDirectory,
                true,
              )}
              onError={setError}
              onReveal={revealProjectItem}
              onImportAssets={chooseProjectAssets}
              onPasteImage={(targetDirectory) => void importSystemClipboardImage(targetDirectory)}
              assetDropTarget={assetDropTarget}
              assetImporting={assetImporting}
              onPaper={(paper) => void openPaper(paper).then((opened) => advanceTutorialPastPaper(paper.arxivId, opened))}
              onLikelyPaper={prewarmLikelyPaper}
              onFetchFullText={(paper) => void fetchAndOpenPaper(paper)}
              paperFetchStates={paperFetchStates}
              onDeletePaper={deletePaper}
              onEditBibEntry={(paper) => void referenceImport.editBibEntry(paper)}
              importInput={referenceImport.input}
              recentImport={referenceImport.recentImport?.projectRoot === project.root ? referenceImport.recentImport : null}
              importStage={referenceImport.stage ? paperImportStageLabel(referenceImport.stage) : null}
              importStageId={referenceImport.stage}
              setImportInput={referenceImport.setInput}
              onImport={referenceImport.importFromInput}
              onCancelImport={referenceImport.cancelImport}
              importing={referenceImport.importing}
            />
            </Suspense>
            )}
            openBibEntryDialog={referenceImport.openBibEntry}
            setBoardCreateRequest={setBoardCreateRequest}
            setLiteratureOpen={referenceImport.setLiteratureOpen}
            openProjectFind={projectSearch.openFind}
            setProjectSearchOpen={setProjectSearchOpen}
            setPresentationCreateRequest={setPresentationCreateRequest}
            setSpreadsheetCreateRequest={setSpreadsheetCreateRequest}
          />

        <section className="canvas-panel" data-tour="canvas">
          <div className="canvas-body">
          {primaryOpening && (
            <div className="primary-opening-overlay" role="status" aria-live="polite">
              <InfinityLoader size={16} />
              <span>{t({ message: `Opening ${primaryOpening.label}…` })}</span>
            </div>
          )}
          <span className="canvas-tour-card-anchor" data-tour="canvas-tour-card-anchor" aria-hidden="true" />
          <Suspense fallback={<div className="document-canvas-loading" aria-label={t`Preparing editor`} />}>
          <OpenSlideTabPool
            projectRoot={project.root}
            openPaths={openTabs}
            activeWorkspace={primaryOpenSlideActive ? {
              projectRoot: project.root,
              path: activeFile,
              source,
              editable: editorEditableForPath(activeFile),
              locale: appLocale,
              theme,
              onViewState: (openSlide) => rememberFileViewState(activeFile, { openSlide }),
              onMutation: applyOpenSlideMutation,
              onContext: setOpenSlideContext,
              onError: setError,
            } : null}
            getFileViewState={getFileViewState}
          />
          <DocumentCanvas
            projectRoot={project.root}
            locale={appLocale}
            theme={theme}
            mode={canvasMode}
            dualPreviewPanes={dualPreviewPanes}
            canRevealPdfSource={canRevealPdfSource}
            workspaceIndex={workspaceIndex}
            papers={papers}
            source={activePaper ? activePaperSource : source}
            markdownPreviewSource={activePaper ? activePaperPreviewSource : undefined}
            activeFile={activePaperPath ?? activeFile}
            secondaryFile={secondaryFile}
            secondarySource={secondarySource}
            setSecondarySource={setSecondarySourceLive}
            focusedPane={focusedPane}
            onFocusPane={setFocusedPane}
            dualRatioResetGeneration={dualRatioResetGeneration}
            setSource={activePaper ? setActivePaperSource : setPrimarySource}
            onSave={save}
            onVisualMarkdownFlushChange={registerVisualMarkdownFlush}
            onMarkdownModeViewportCaptureChange={registerMarkdownModeViewportCapture}
            setSelection={(value) => agentContext.reportSelection(paperFocused ? "paper" : "editor", value)}
            onPdfTextSelect={(value) => agentContext.reportSelection("pdf", value)}
            onPaperTextSelect={(value) => agentContext.reportSelection("paper", value)}
            onImportAsset={importClipboardImageFile}
            onContextSurfaceActivate={agentContext.activateSurface}
            onViewMarkdownSource={() => {
              markdownModeViewportCaptureRef.current?.();
              if (isTwoPane(canvasMode)) openDocumentMode("source");
              else setCanvasMode("split");
            }}
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
                    if (!agentDocked) {
                      setSidebarMode("agent");
                      setSidebarOpen(true);
                    }
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
            paperSide={paperSide}
            activeAsset={activeAsset}
            secondaryAsset={secondaryAsset}
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
            onEditorLeave={saveWhenLeavingEditor}
            onPrepareFigure={prepareLatexFigure}
            onPasteImageFile={handlePasteImageFile}
            nativeFigureDropActive={nativeEditorDropActive}
            fileDropTargetPane={fileDropTargetPane}
            figurePointerPosition={figurePointerDrag?.insertAtEditor ? {
              x: figurePointerDrag.clientX,
              y: figurePointerDrag.clientY,
            } : null}
            requests={canvasRequests}
            onRequestHandled={settleCanvasRequest}
            onEditorPosition={handleEditorPosition}
            onCompletionActiveChange={handleCompletionActiveChange}
            onViewState={(path, state) => rememberFileViewState(path, { text: state })}
            getFileViewState={getFileViewState}
            onFileViewState={rememberFileViewState}
            onGotoDefinition={(target) => void gotoDefinition(target)}
            onTexlabGoto={(path, line) => { void openProjectFile(path, line); }}
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
            insertOpen={insertOpen}
            onInsertOpenChange={setInsertOpen}
            tableGeneratorOpen={tableGeneratorOpen}
            onTableGeneratorOpenChange={setTableGeneratorOpen}
            editorKeymap={appearance.editorKeymap}
            editorSpellcheck={appearance.editorSpellcheck}
            spellingWords={project.manifest.spellingWords ?? EMPTY_SPELLING_WORDS}
            onAddSpellingWord={addProjectSpellingWord}
            projectPaths={projectPaths}
            graphicsRoots={graphicsRoots}
            buildDiagnostics={
              source === buildPipeline.compiledSources.primary && secondarySource === buildPipeline.compiledSources.secondary
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
            commentAuthorName={collabName.trim() || "Anonymous"}
            commentAuthorId={editorCommentAuthorId}
            onCreateEditorComment={editorComments.create}
            onOpenEditorComments={editorComments.openPanel}
            onResolveEditorComment={editorComments.toggleResolved}
            onReplyEditorComment={editorComments.openReply}
            commentFocusRequest={editorComments.focusRequest}
            onCommentFocusHandled={(nonce) => {
              editorComments.setFocusRequest((current) => (current?.nonce === nonce ? null : current));
            }}
            todoCount={todoHits.length}
            onOpenTodos={() => {
              void refreshTodos();
              setTodosOpen(true);
            }}
            projectWordCount={projectWordCount}
            onPdfPageCount={setPdfPageCount}
            onPdfPageChange={setPdfPageNumber}
            onCreateMissingFile={(path) => {
              void createProjectEntry(path, "file");
            }}
            onOpenMarkdownPath={openMarkdownProjectPath}
            interactivePreviewsEnabled={postStartupInteraction}
            collabSession={
              activePaper && !isTwoPane(canvasMode)
                ? null
                : collabSession
            }
            collabReady={collabReady}
            // Papers live under .research/, which Overleaf deliberately
            // excludes from sync. Collaboration grants still apply to them.
            editorEditable={editorEditableForPath(activeFile, activePaper !== null)}
            secondaryEditorEditable={secondaryFile
              ? editorEditableForPath(secondaryFile)
              : false}
            collabEditorKey={activePaper
              ? `paper:${activePaperPath}`
              : collabSession
                ? `collab:${collabSession.room}:${activeFile}:${collabReady ? "live" : "wait"}`
                : `local:${activeFile}`}
            collabPeers={collabPeerList}
          />
          </Suspense>
          </div>
        </section>

      </main>

      <EditorDropPreviewPortal preview={projectFileDropPreview} />

      <AppCollabDialog
        collab={collab}
        session={collabSession}
        onJoin={joinCollabShare}
        onRejoin={rejoinCollabProjectV2}
        onInstallTex={texSetup.openWizard}
        chat={{ chat: collabChat, selfId: editorCommentAuthorId, canWrite: collabCanWrite }}
      />

      <TexSetupDialogs setup={texSetup} />

      {figurePointerDrag && (
        <div
          className={`figure-drag-ghost ${figurePointerDrag.overCanvas ? "ready" : ""}`}
          style={{ left: figurePointerDrag.clientX + 12, top: figurePointerDrag.clientY + 12 }}
        >
          <Image size={13} />
          <span>{figurePointerDrag.label}</span>
        </div>
      )}

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
        openProjectFile={openProjectFile}
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
            openProjectFile={openProjectFile}
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
        openProjectFile={openProjectFile}
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
        openProjectAsset={openProjectAsset}
        openProjectFile={openProjectFile}
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
          canApply={collabCanWrite}
          onClose={() => setBibliographyAuditOpen(false)}
          onPrepare={save}
          onApplied={() => refreshAfterSave(project.root, false, true)}
          onApply={async (entry, result) => {
            const root = project.root;
            const writable = () => collabCanWrite && collabSessionRef.current?.canWrite !== false;
            if (!writable() || !result.after) throw new Error(t`This reference cannot be updated.`);
            if (!await save()) throw new Error(t`Save pending edits before updating references.`);
            if (projectRootRef.current !== root || !writable()) throw new Error(t`The project or its permissions changed. Check references again.`);
            await invoke("bibliography_audit_apply", { projectRoot: root, path: entry.path, key: entry.key, before: result.before, after: result.after });
            if (projectRootRef.current !== root) return;
            const content = await invoke<string>("read_project_file", { projectRoot: root, path: entry.path });
            if (projectRootRef.current !== root) return;
            commitCleanOpenText(entry.path, content);
            await publishTextToCollabV2(entry.path, content);
            // The drawer refreshes derived citation/history data once per
            // apply action (including bulk), outside the durable-write path.
          }}
        />
      </Suspense>}
      <AppProjectSearchDialogs
        search={projectSearch}
        semanticSearch={semanticSearch}
        captureProjectScope={projectState.captureProjectScope}
        projectRef={projectRef}
        dirty={source !== savedSource}
        activeFile={activeFile}
        loadFile={loadFile}
        openMarkdownProjectPath={openMarkdownProjectPath}
        openProjectFile={openProjectFile}
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

      <AppOnboardingTour
        activeFile={activeFile}
        activePaperPath={activePaperPath}
        canvasMode={canvasMode}
        changePaperView={changePaperView}
        openProjectFile={openProjectFile}
        setCanvasMode={setCanvasMode}
        setCollabOpen={setCollabOpen}
        setGitOpen={setGitOpen}
        setOverleafPickerOpen={setOverleafPickerOpen}
        setSidebarMode={setSidebarMode}
        setSidebarOpen={setSidebarOpen}
        setTutorialActive={setTutorialActive}
        setTutorialStep={setTutorialStep}
        tutorialActive={tutorialActive}
        tutorialStep={tutorialStep}
      />
    </div>
  );
}

export default App;
