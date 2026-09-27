import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Image } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  type CitationInfo,
  type DefinitionTarget,
  type ReferenceInfo,
  type SymbolTarget,
} from "./editor/latex/latex-text";
import { formatBibDocument } from "./papers/bib-format";
import { clipboardImageFileName, fileToBase64, rgbaImageToPngBase64 } from "./editor/insert/clipboard-image";
import { listenForBrowserProjectDrops } from "./project/browser-project-drop";
import { SearchPickerDialog, type SearchPickerItem } from "./components/ui/search-picker-dialog";
import { parsePaperLinkPath } from "./papers/paper-link";
import { canDownloadPaper, citationSourceUrl } from "./papers/paper-source";
import { paperImportStageLabel } from "./papers/paper-import-progress";
import {
  assertCollabWorkspaceLease,
  CollabDiskWriteQueue,
  type CollabWorkspaceLease,
} from "./collab/collab-workspace-lease";
import {
  createEditorCommentReply,
  EDITOR_COMMENTS_PATH,
  loadEditorCommentAuthorId,
  mergeEditorComments,
} from "./editor/comments/editor-comment-data";
import { useAppearance } from "./settings/use-appearance";
import { isBrowserHosted, isBundledChromium } from "./platform/browser-runtime";
import { configureInterfaceSounds, playInterfaceSound } from "./telemetry/interface-sounds";
import { useWorkspaceSidebar } from "./app/use-workspace-sidebar";
import { useFileViewStates } from "./app/use-file-view-states";
import { useProjectSearch } from "./app/use-project-search";
import { useReferenceImport } from "./app/use-reference-import";
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
import { afterNextPaintOpportunity } from "./app/effect-helpers";
import { useCollabChat } from "./collab/use-collab-chat";
import {
  OVERLEAF_COMMENT_PREFIX,
  useOverleafWorkspace,
} from "./app/use-overleaf-workspace";
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
import { AppProjectSearchDialogs, AppSearchDialogs } from "./app/app-search-dialogs";
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
import {
  type EditorComment,
} from "./editor/comments/editor-comment-data";
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
import { collabCommentsMap, readCollabComments, seedCollabCommentsFromContent, writeCollabComments } from "./collab/collab-comments";
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
import {
  activeOutlineNode,
  flattenOutline,
  includedPathsIn,
  parseProjectOutline,
} from "./editor/latex/latex-outline";
import { katexMacrosFromSources } from "./editor/latex/katex-macros";
import {
  editorDropPreviewAt,
  EditorDropPreviewPortal,
  type EditorDropPreview,
  type EditorDropZone,
} from "./canvas/editor-tabs";
import { baseArxivId } from "./papers/arxiv-id";
import { type PdfSyncTarget } from "./pdf/pdf-viewer";
import { findAppendixMarker } from "./editor/latex/appendix-pages";
import { mergeTodosWithBuffer } from "./project/todo-scavenger";
import { referenceAssetPreviewDataUrl } from "./project/reference-preview";
import type {
  ProjectManifest,
  NavigationEntry,
  ProjectSnapshot,
  FileNode,
  AssetPreview,
  FigureDropRequest,
  FigurePointerDrag,
  SyncTexTarget,
  EditorNavigation,
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

type ReferencePreviewCacheEntry = {
  promise: Promise<string | null>;
  characters: number;
};

const REFERENCE_PREVIEW_CACHE_ENTRY_LIMIT = 48;
const REFERENCE_PREVIEW_CACHE_CHARACTER_LIMIT = 24 * 1024 * 1024;

function trimReferencePreviewCache(
  cache: Map<string, ReferencePreviewCacheEntry>,
) {
  for (const [key] of cache) {
    if (cache.size <= REFERENCE_PREVIEW_CACHE_ENTRY_LIMIT) break;
    cache.delete(key);
  }
  let characters = 0;
  for (const entry of cache.values()) characters += entry.characters;
  for (const [key, entry] of cache) {
    if (characters <= REFERENCE_PREVIEW_CACHE_CHARACTER_LIMIT) break;
    if (entry.characters === 0) continue;
    cache.delete(key);
    characters -= entry.characters;
  }
}

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

function collectAssetPaths(nodes: FileNode[], paths = new Set<string>()): Set<string> {
  for (const node of nodes) {
    // SVG is text on disk but remains an image when tabs are selected or restored.
    const isDirectory = node.kind === "directory" || node.contentKind === "directory";
    if (!isDirectory && (isProjectAssetFilePath(node.path)
      || node.kind === "figure" || node.contentKind === "binary" || node.contentKind === "symlink")) {
      paths.add(node.path);
    }
    if (node.children.length) collectAssetPaths(node.children, paths);
  }
  return paths;
}

function collectQuickOpenPaths(nodes: FileNode[], paths: string[] = []): string[] {
  for (const node of nodes) {
    const isDirectory = node.kind === "directory" || node.contentKind === "directory";
    if (!isDirectory && node.path) paths.push(node.path);
    if (node.children.length) collectQuickOpenPaths(node.children, paths);
  }
  return paths;
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
    performance.measure("lattice:document-switch", {
      start: startedAt,
      end: endedAt,
      detail,
    });
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

function normalizeProjectRelativePath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/") || null;
}


function App() {
  const { t } = useLingui();
  const browserHosted = isBrowserHosted();
  const bundledChromium = isBundledChromium();
  const projectState = useProjectState();
  const {
    project, setProject, projectRef, projectBeforeTransitionRef,
    projectOperationGenerationRef,
    cancelProjectTransition, reconcileProjectTree, withTreeMutation,
  } = projectState;
  const library = useProjectLibrary(projectState);
  const {
    papers, citationKeys, setCitationKeys, citations, setCitations, references, setReferences,
    unusedSymbols, history, diskTodos, setDiskTodos, projectWordCount,
    loadHistory, loadTodos, loadWordCount, refreshUnusedSymbols, refreshHistory, refreshTodos, refreshWordCount,
    refreshAfterSave, refreshProject,
  } = library;
  const buffers = useDocumentBuffers();
  const {
    activeFile, setActiveFile, activeFileRef,
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
  const [postStartupInteraction, setPostStartupInteraction] = useState(false);
  const {
    workspaceIndex,
    cancelPreviewPrewarm,
    prewarmLikelyProjectFile,
    prewarmLikelyPaper,
  } = usePreviewPrewarm(project, projectRef, {
    activeFile,
    activePaperId: activePaper?.arxivId,
    paperView,
  });
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
    const enableInteractivePreviews = () => {
      setPostStartupInteraction(true);
      window.removeEventListener("pointerdown", enableInteractivePreviews, true);
      window.removeEventListener("keydown", enableInteractivePreviews, true);
    };
    window.addEventListener("pointerdown", enableInteractivePreviews, true);
    window.addEventListener("keydown", enableInteractivePreviews, true);
    return () => {
      window.removeEventListener("pointerdown", enableInteractivePreviews, true);
      window.removeEventListener("keydown", enableInteractivePreviews, true);
    };
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
  }, []);
  const [navStack, setNavStack] = useState<NavigationEntry[]>([]);
  const [navIndex, setNavIndex] = useState(-1);
  const navLock = useRef(false);
  const {
    statesRef: viewStateRef, get: getFileViewState, remember: rememberFileViewState, allow: allowViewState,
    drop: dropViewState, forget: forgetViewStates, remap: remapViewStates, loadForProject: loadViewStatesForProject,
  } = useFileViewStates(project?.root ?? null, projectRef, projectBeforeTransitionRef);
  const [viewRestore, setViewRestore] = useState<{ path: string; cursor: number; scrollTop: number; id: string } | null>(null);
  const [envRenameRequest, setEnvRenameRequest] = useState<{ newName: string; id: string } | null>(null);
  const [tableGeneratorOpen, setTableGeneratorOpen] = useState(false);
  const projectSearch = useProjectSearch();
  const { openFind: openProjectFind, openReplace: openProjectReplace } = projectSearch;
  const semanticSearch = useLocalSemanticSearch(project?.root, projectRef);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [gotoLineOpen, setGotoLineOpen] = useState(false);
  const [wrapEnvRequest, setWrapEnvRequest] = useState<{ name: string; id: string } | null>(null);
  const openCompileDiagnosticRef = useRef<(diagnostic: CompileDiagnostic) => Promise<void>>(async () => undefined);
  const referencePreviewCache = useRef(new Map<string, ReferencePreviewCacheEntry>());
  const referencePreviewPaths = useRef({ root: "", paths: new Set<string>() });
  const referencePreviewGenerationRef = useRef(0);
  const [referencePreviewGeneration, setReferencePreviewGeneration] = useState(0);
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
  }, [paperView]);
  const changePaperView = useCallback((view: "blog" | "fulltext") => {
    if (view === paperView) return;
    // Blog and full text are distinct editable documents. Publish the old
    // NodeView while its path still owns the callback, then change identity.
    if (visualMarkdownFlushRef.current?.() === false) return;
    setPaperView(view);
  }, [paperView]);
  const [nativeEditorDropActive, setNativeEditorDropActive] = useState(false);
  const [fileDropTargetPane, setFileDropTargetPane] = useState<EditorPaneId | null>(null);
  const [projectFileDropPreview, setProjectFileDropPreview] = useState<EditorDropPreview | null>(null);
  const [agentPanelDropActive, setAgentPanelDropActive] = useState(false);
  const [figureDropRequest, setFigureDropRequest] = useState<FigureDropRequest | null>(null);
  const [figurePointerDrag, setFigurePointerDrag] = useState<FigurePointerDrag | null>(null);
  const nativeDragPathsRef = useRef<string[]>([]);
  const suppressedFigureClick = useRef<string | null>(null);
  const suppressedProjectFileClick = useRef<string | null>(null);
  const openProjectFileRef = useRef<(
    path: string,
    line?: number,
    targetPane?: EditorPaneId,
  ) => Promise<void>>(async () => undefined);
  const openMarkdownProjectPathRef = useRef<(path: string) => void>(() => undefined);
  const dropProjectPathRef = useRef<(path: string, zone: EditorDropZone) => Promise<unknown>>(
    async () => undefined,
  );
  const markdownModeViewportCaptureRef = useRef<(() => void) | null>(null);
  const [editorNavigation, setEditorNavigation] = useState<EditorNavigation | null>(null);
  const requestEditorLine = useCallback((path: string, line: number) => {
    setEditorNavigation({ path, line, id: crypto.randomUUID() });
  }, []);
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
  /**
   * Non-null while the drawer is pinned to one agent turn's checkpoint diff.
   * Kept separate from gitWorkspaceView: the review needs a thread + turn to
   * mean anything, so the tab only exists while a request is present, and
   * switching to Changes / Pull requests drops back to the working tree.
   */
  const [agentTurnReview, setAgentTurnReview] = useState<AgentTurnReview | null>(null);
  const [todosOpen, setTodosOpen] = useState(false);
  const [editorComments, setEditorComments] = useState<EditorComment[]>([]);
  /** Read inside async publishes, where the state captured at call time is already stale. */
  const editorCommentsRef = useRef<EditorComment[]>([]);
  editorCommentsRef.current = editorComments;
  const [editorCommentsOpen, setEditorCommentsOpen] = useState(false);
  const [activeEditorCommentId, setActiveEditorCommentId] = useState<string | null>(null);
  const [commentPanelFocus, setCommentPanelFocus] = useState<{ id: string; projectRoot: string; nonce: string } | null>(null);
  const commentPanelFocusId = commentPanelFocus && commentPanelFocus.projectRoot === project?.root ? commentPanelFocus.id : null;
  const [commentFocusRequest, setCommentFocusRequest] = useState<{ id: string; nonce: string } | null>(null);
  const commentOpenGenerationRef = useRef(0);
  const editorCommentAuthorId = useMemo(() => loadEditorCommentAuthorId(), []);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const dualPreviewPanes = {
    primary: Boolean(
      (canvasMode === "dual" || canvasMode === "columns")
      && dualPanePreview?.projectRoot === project?.root
      && dualPanePreview?.primaryPath === activeFile,
    ),
    secondary: Boolean(
      (canvasMode === "dual" || canvasMode === "columns")
      && secondaryFile
      && dualPanePreview?.projectRoot === project?.root
      && dualPanePreview?.secondaryPath === secondaryFile,
    ),
  };
  const focusedPanePreview = focusedPane === "secondary"
    ? dualPreviewPanes.secondary
    : dualPreviewPanes.primary;
  // A reverse SyncTeX jump needs a pane that still holds an editor. Both panes
  // previewing, or the only other pane holding an asset, leaves nowhere to land.
  const canRevealPdfSource = dualPreviewPanes.primary && dualPreviewPanes.secondary
    ? false
    : dualPreviewPanes.primary
      ? Boolean(secondaryFile) && !secondaryAsset
      : dualPreviewPanes.secondary
        ? !activeAsset
        : true;
  const focusedAsset = (canvasMode === "dual" || canvasMode === "columns")
    && focusedPane === "secondary"
    ? secondaryAsset
    : activeAsset;
  const paperFocused = Boolean(activePaper && focusedPane === "primary");
  const focusedDocumentPath = focusedPane === "secondary" && secondaryFile
    ? secondaryFile
    : activeFile;
  const insertTargetPath = focusedDocumentPath;
  const canInsert = canvasMode !== "pdf"
    && !paperFocused
    && !focusedAsset
    && /\.(?:tex|sty|cls|txt)$/i.test(insertTargetPath);
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
      && (canvasMode === "dual" || canvasMode === "columns")
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
        await invoke<void>("write_project_file", {
          path,
          content: spreadsheetDocContent(doc),
          projectRoot,
        });
        recordSavedPaths([path]);
      },
      dispose: () => doc.destroy(),
    };
  }), [activeCollabVersion, collabCanWrite, recordSavedPaths]);
  const [citeInsertRequest, setCiteInsertRequest] = useState<{ key: string; command: InsertSymbolCommand; id: string } | null>(null);
  const [bibliographyAuditRoot, setBibliographyAuditRoot] = useState<string | null>(null);
  const [bibliographyAuditOpen, setBibliographyAuditOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [goToSymbolOpen, setGoToSymbolOpen] = useState(false);
  const [refCitePicker, setRefCitePicker] = useState<"cite" | "ref" | null>(null);
  const closedTabsRef = useRef<string[]>([]);
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
    beginSidebarResize, nudgeSidebar, fitSidebarToContent,
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
  const [buildPreferences, setBuildPreferences] = useState<BuildPreferences>(loadBuildPreferences);
  const autoBuildModeRef = useRef(buildPreferences.autoBuildMode);
  useEffect(() => {
    autoBuildModeRef.current = buildPreferences.autoBuildMode;
  }, [buildPreferences.autoBuildMode]);
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
  const { resetQueue: resetBuildQueue, cycleDiagnostic } = buildPipeline;
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
  const forwardSyncPosition = (() => {
    if (!editorPosition || !pdfUrl || !editorPosition.path.toLocaleLowerCase().endsWith(".tex")) {
      return null;
    }
    if (canvasMode === "dual" || canvasMode === "columns") {
      if (
        editorPosition.path === activeFile
        && !activeAsset
        && !dualPreviewPanes.primary
      ) return editorPosition;
      if (
        editorPosition.path === secondaryFile
        && !secondaryAsset
        && !dualPreviewPanes.secondary
      ) return editorPosition;
      return null;
    }
    return (canvasMode === "split" || canvasMode === "pdf")
      && !activeAsset
      && editorPosition.path === activeFile
      ? editorPosition
      : null;
  })();
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
    if (!synara.origin || !gitOpen) return;
    const closeSourceControl = (event: MessageEvent) => {
      if (
        event.source !== synara.sourceControlFrameRef.current?.contentWindow ||
        event.origin !== synara.origin ||
        event.data?.type !== "lattice:close-source-control"
      ) {
        return;
      }
      setGitOpen(false);
    };
    window.addEventListener("message", closeSourceControl);
    return () => window.removeEventListener("message", closeSourceControl);
  }, [gitOpen, synara.origin]);

  const projectGit = useProjectTreeWatch(projectState, sidebarMode === "project");
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
    setRecentProjects(rememberRecentProject({
      name: snapshot.manifest.name,
      path: snapshot.root,
    }));
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

  const flushAndCheckPrimaryDirty = useCallback((owner: "file" | "paper" | "asset") => {
    if (visualMarkdownFlushRef.current?.() === false) return true;
    if (owner === "file") return sourceRef.current !== savedSourceRef.current;
    if (owner === "paper") {
      return paperBuffersDirty();
    }
    return false;
  }, []);

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
  }, [activeCollabVersion, collabPathMutationGeneration, markDiskMtime]);

  useLeavePresenceOnClose(collabV2ControllerRef);

  const handleRemoteCollabDeleteV2 = useCallback(async (
    path: string,
    lease: CollabWorkspaceLease,
    deleteFromDisk: () => Promise<void>,
  ) => {
    if (!lease.isCurrent()) return;
    collabPathMutationGenerationRef.current.set(path, collabPathMutationGeneration(path) + 1);
    const controller = collabV2ControllerRef.current;
    const initialPlan = planRemoteCollabDeleteUiV2({
      path,
      activeFile: activeFileRef.current,
      secondaryFile: secondaryFileRef.current,
      openTabs: openTabsRef.current,
      tabRecency: tabRecency.current,
      liveTextPaths: controller?.catalogTextPaths() ?? [],
    });

    dropViewState(path);
    setOpenTabs(initialPlan.openTabs);
    setPinnedTabs((tabs) => tabs.filter((tab) => tab !== path));
    tabRecency.current = initialPlan.tabRecency;
    setNavStack((entries) => entries.filter((entry) => entry.path !== path));
    setViewRestore((request) => request?.path === path ? null : request);
    setEditorNavigation((request) => request?.path === path ? null : request);

    if (initialPlan.deletedSecondary) {
      secondaryFileRef.current = null;
      showSecondaryText(null);
      setFocusedPane("primary");
    }
    if (initialPlan.deletedActive) {
      // Fence the stale buffer before any refresh await. Otherwise autosave can
      // recreate a path the shared catalog has authoritatively deleted.
      collabDetachRef.current?.();
      collabDetachRef.current = null;
      activeFileRef.current = "";
      setActiveFile("");
      setSource("");
      setSavedSource("");
    }

    await deleteFromDisk();
    const projectGeneration = projectOperationGenerationRef.current;
    const snapshot = await refreshProject({ expectedRoot: lease.projectRoot, generation: projectGeneration });
    if (!lease.isCurrent() || collabV2ControllerRef.current !== controller || !initialPlan.deletedActive) return;
    const livePaths = controller?.catalogTextPaths() ?? [];
    const preferredPaths = [
      ...snapshot.manifest.rootDocuments.filter((document) => document.isDefault).map((document) => document.path),
      ...snapshot.manifest.rootDocuments.map((document) => document.path),
    ];
    const replacement = planRemoteCollabDeleteUiV2({
      path,
      activeFile: path,
      secondaryFile: null,
      openTabs: initialPlan.openTabs,
      tabRecency: initialPlan.tabRecency,
      liveTextPaths: livePaths,
      preferredPaths,
    }).replacement;
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
    collabPathMutationGeneration, dropViewState, loadFile, refreshProject,
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
      if (writtenPaths.some((path) => /\.(?:md|mdx|tex)$/i.test(path))) semanticSearch.requestReindex();
      return true;
    } catch (reason) {
      // Autosave runs constantly, so this path gets a plain notification rather
      // than a `logAction` trace — a start line per keystroke pause would bury
      // everything else in the log.
      notifyError("Save", `Could not save ${activeFile || "the project"}`, {
        detail: toMessage(reason),
      });
      return false;
    }
  }, [
    activeFile, activeAsset, activePaper, activeCollabVersion, collabPathMutationGeneration, collabSession,
    externalEditConflictMessage, markPaperSaved, project, publishTextToCollabV2, recordSavedPaths,
    refreshAfterSave, semanticSearch.requestReindex, setPrimarySaved, setPrimarySource, setSecondarySaved,
    setSecondarySourceLive,
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
    if (pane === "primary") {
      if (activeFileRef.current !== path) return;
      commitPrimaryText(content);
    } else {
      if (secondaryFileRef.current !== path) return;
      commitSecondaryText(content);
    }
  }, [activeCollabVersion]);

  useLayoutEffect(() => {
    hasLateProjectTransitionEditRef.current = () => {
      if (visualMarkdownFlushRef.current?.() === false) return true;
      const primaryDirty = activePaper
        ? paperBuffersDirty()
        : !activeAsset && sourceRef.current !== savedSourceRef.current;
      return primaryDirty || secondarySourceRef.current !== secondarySavedRef.current;
    };
  }, [activeAsset, activePaper]);

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
        try {
          const primarySaved = savedSourceRef.current;
          const stat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", {
            path: activeFile,
          });
          if (!readIsCurrent() || !stat.exists || savedSourceRef.current !== primarySaved) return;
          if (diskMtimeRef.current == null) {
            diskMtimeRef.current = stat.mtimeMs;
          } else if (stat.mtimeMs > diskMtimeRef.current) {
            const content = await invoke<string>("read_project_file", { path: activeFile });
            if (!readIsCurrent() || savedSourceRef.current !== primarySaved) return;
            diskMtimeRef.current = stat.mtimeMs;
            if (content !== primarySaved) {
              externalOverleafEditsRef.current([activeFile]);
              if (sourceRef.current === savedSourceRef.current) {
                await acceptExternalText(activeFile, content, "primary");
                if (buildPreferences.autoBuildMode === "automatic") {
                  void compileRef.current();
                }
              }
            }
          }
          if (secondaryFile) {
            const secondarySaved = secondarySavedRef.current;
            const secondaryStat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", {
              path: secondaryFile,
            });
            if (!readIsCurrent() || !secondaryStat.exists || secondarySavedRef.current !== secondarySaved) return;
            if (secondaryMtimeRef.current == null) {
              secondaryMtimeRef.current = secondaryStat.mtimeMs;
              return;
            }
            if (secondaryStat.mtimeMs <= secondaryMtimeRef.current) return;
            const content = await invoke<string>("read_project_file", { path: secondaryFile });
            if (!readIsCurrent() || secondarySavedRef.current !== secondarySaved) return;
            secondaryMtimeRef.current = secondaryStat.mtimeMs;
            if (content === secondarySaved) return;
            externalOverleafEditsRef.current([secondaryFile]);
            if (secondarySourceRef.current !== secondarySavedRef.current) return;
            await acceptExternalText(secondaryFile, content, "secondary");
            if (buildPreferences.autoBuildMode === "automatic") {
              void compileRef.current();
            }
          }
        } catch {
          // Ignore transient filesystem races while the editor is open.
        }
      })();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [acceptExternalText, activeAsset, activeFile, activePaper, buildPreferences.autoBuildMode, project, secondaryFile]);

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
      && canvasMode !== "dual" && canvasMode !== "columns"
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
    const secondaryFocused = (canvasMode === "dual" || canvasMode === "columns")
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
      const projectGeneration = projectOperationGenerationRef.current;
      const isLatestSecondaryLoad = () => (
        requestGeneration === secondaryFileLoadGenerationRef.current
        && projectOperationGenerationRef.current === projectGeneration
        && projectRef.current?.root === projectRoot
      );
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
          const published = await publishTextToCollabV2(secondaryFile, secondarySource);
          if (!published) {
            await invoke("write_project_file", {
              path: secondaryFile,
              content: secondarySource,
              projectRoot: project?.root,
            });
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
          const content = await invoke<string>("read_project_file", {
            path,
            projectRoot: project?.root,
          });
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
    const clearOpening = () => setPrimaryOpening((current) => (
      current?.generation === loadGeneration ? null : current
    ));
    setPrimaryOpening({
      generation: loadGeneration,
      label: path.split("/").at(-1) ?? path,
    });
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
    const primaryDirty = sourceRef.current !== savedSourceRef.current
      || (Boolean(activePaper) && (
        paperBuffersDirty()
      ));
    const targetAliasesDirtyPaper = Boolean(activePaper) && (
      paperBuffersDirty()
    ) && (
      path === `.research/papers/${activePaper?.arxivId}/paper.md`
      || path === `.research/papers/${activePaper?.arxivId}/blog.md`
    );
    if (
      primaryDirty
      || (secondaryFile && secondarySource !== secondarySavedSource)
    ) {
      if (path === secondaryFile || targetAliasesDirtyPaper) {
        // save() rewrites this destination from either the secondary buffer or
        // the Paper editor; overlapping it with the read below would hand the
        // incoming editor pre-save contents after the write succeeds.
        const saved = await save();
        if (!saved) {
          clearOpening();
          return;
        }
        if (fileLoadGenerationRef.current !== loadGeneration) {
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
      canCommit: () => !flushAndCheckPrimaryDirty(
        activePaper ? "paper" : activeAsset ? "asset" : "file",
      ),
      navigateToLine: restoreSecondary ? undefined : line,
    });
    clearOpening();
    if (!applied) return;
    recordNavigationTiming("file", path, switchStartedAt, {
      openingPaintMs,
      flushMs,
      saveAndReadMs: performance.now() - contentLoadStartedAt,
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
  }, [
    acceptExternalText,
    activeAsset,
    activeCollabVersion,
    activeFile,
    activePaper,
    activePaperDirty,
    canvasMode,
    cancelPreviewPrewarm,
    collabSession,
    flushAndCheckPrimaryDirty,
    focusedPane,
    loadFile,
    markDiskMtime,
    project?.root,
    // Harmless here today only because `activeCollabVersion` is listed above and
    // is the sole value this callback's identity tracks — but that is a coincidence
    // of two lists agreeing, not a guarantee. Listed so it stays true.
    publishTextToCollabV2,
    pushNavigation,
    save,
    savedSource,
    secondaryFile,
    secondarySavedSource,
    secondarySource,
    source,
  ]);
  useEffect(() => {
    openProjectFileRef.current = openProjectFile;
  }, [openProjectFile]);

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
  }, [openProjectFile, pushNavigation]);

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
      : dualPreviewPanes.secondary
        ? "primary"
        : null;
    try {
      const target = await invoke<SyncTexTarget>("synctex_edit", { page, x, y });
      // A citation resolves into the bibliography, a macro into a .sty. Those
      // files own the whole editor area when opened deliberately, but a jump
      // out of the PDF must keep the preview it was made from on screen.
      await openProjectFile(target.path, target.line, jumpPane ?? undefined, { revealSource: false });
      if (!jumpPane) {
        setCanvasMode((mode) => (
          mode === "pdf" || mode === "asset"
            ? "split"
            : mode === "columns"
              ? "split"
              : mode === "dual"
                ? "split"
                : mode
        ));
      }
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
  }, [activeCollabVersion, collabCanWrite, commitOpenText, v2WorkspaceCallbacks]);

  // ---- Overleaf bridge -----------------------------------------------------
  // Link discovery, syncing, the realtime channel and everything that rides it
  // (presence, chat, comment threads, tracked changes) live in
  // `src/app/use-overleaf-workspace.ts`. It has to be called here rather than
  // beside the rest of App's state: every sync path goes through save, compile,
  // loadFile and refreshProject, all of which are declared above.
  const wholeFileEditingPaths = useMemo(() => {
    const paths: string[] = [];
    if (
      !activePaper
      && !activeAsset
      && !dualPreviewPanes.primary
      && canvasMode !== "pdf"
      && isWholeFileEditorPath(activeFile)
    ) paths.push(activeFile);
    if (
      (canvasMode === "dual" || canvasMode === "columns")
      && secondaryFile
      && !secondaryAsset
      && !dualPreviewPanes.secondary
      && isWholeFileEditorPath(secondaryFile)
    ) paths.push(secondaryFile);
    return paths;
  }, [
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
    setOverleafCollabOpen, setOverleafCollabTab, conflictPath, setConflictPath,
    overleafSyncRef, refreshOverleafLink, publishProjectToOverleaf, runOverleafSync, flushDeferredWholeFileSync,
    settleRemoteDeletes, openCurrentOverleafProject, jumpToOverleafPeer, overleafRealtime, overleafPresence,
    overleafChat, overleafComments, overleafCommentsRef, overleafTrackChanges, overleafDocPaths,
    overleafEditorComments, overleafActiveCursors,
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
    const deckPath = isOpenSlideDeckPath(mutation.path)
      ? mutation.path
      : isOpenSlideDeckPath(activeFileRef.current)
        ? activeFileRef.current
        : null;
    if (deckPath) recordSavedPaths([deckPath]);
    if (mutation.kind === "delete" && activeFileRef.current === mutation.path) {
      const replacement = flattenProjectPaths(snapshot.files).find((candidate) => (
        candidate !== mutation.path && isProjectSourceFilePath(candidate)
      ));
      if (replacement) await loadFile(replacement, { restoreView: false });
      else {
        activeFileRef.current = "";
        sourceRef.current = "";
        savedSourceRef.current = "";
        setActiveFile("");
        setSource("");
        setSavedSource("");
      }
    }
    return mutation.kind === "delete"
      ? [{ path: mutation.path, kind: "delete" }]
      : [{
          path: mutation.path,
          kind: mutation.kind,
          ...(written.text !== undefined ? { text: written.text } : { base64: written.base64 }),
        }];
  }, [
    activeCollabVersion, collabCanWrite, collabDiskWriteQueueRef, loadFile, recordSavedPaths, refreshHistory,
    refreshProject, v2WorkspaceCallbacks,
  ]);

  /** Both kinds of comment, as the editor and the panel want them. */
  const allEditorComments = useMemo(
    () => [...editorComments, ...overleafEditorComments],
    [editorComments, overleafEditorComments],
  );

  useLayoutEffect(() => {
    agentCommentsOptionsRef.current = () => {
      if (!project || projectRootRef.current !== project.root) return null;
      return {
        workspaceRoot: project.root,
        localComments: editorCommentsRef.current,
        overleafThreads: overleafComments.threads,
        overleafAnchors: [...overleafComments.anchors.values()],
        docPaths: overleafDocPaths,
        currentSources: new Map([
          [activeFileRef.current, sourceRef.current],
          ...(secondaryFileRef.current ? [[secondaryFileRef.current, secondarySourceRef.current] as const] : []),
        ]),
        overleaf: { status: overleafLink ? "cached" : "not-linked" },
      };
    };
    return () => { agentCommentsOptionsRef.current = null; };
  }, [project, overleafComments.threads, overleafComments.anchors, overleafDocPaths, overleafLink]);

  const revealSourceInPdf = useCallback(async () => {
    if (!forwardSyncPosition || locatingPdf) return;
    const position = forwardSyncPosition;
    const requestGeneration = forwardSyncGenerationRef.current + 1;
    forwardSyncGenerationRef.current = requestGeneration;
    const projectGeneration = projectOperationGenerationRef.current;
    const projectRoot = projectRef.current?.root;
    const fileLoadGeneration = fileLoadGenerationRef.current;
    const documentViewGeneration = documentViewGenerationRef.current;
    const isCurrentRequest = () => (
      forwardSyncGenerationRef.current === requestGeneration
      && projectOperationGenerationRef.current === projectGeneration
      && projectRef.current?.root === projectRoot
      && fileLoadGenerationRef.current === fileLoadGeneration
      && documentViewGenerationRef.current === documentViewGeneration
      && editorPositionRef.current?.path === position.path
      && editorPositionRef.current?.line === position.line
      && editorPositionRef.current?.column === position.column
    );
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
        setError(null);
        setNotice(null);
        setWarning("This source line has no matching position in the PDF.");
        return;
      }
      setWarning(null);
      setPdfSyncTarget({ ...target, id: crypto.randomUUID() });
      setCanvasMode((mode) => {
        if (mode === "dual" || mode === "columns") return "split";
        if (mode === "source") return "split";
        return mode;
      });
      setError(null);
    } catch (reason) {
      if (!isCurrentRequest()) return;
      const message = toMessage(reason);
      if (message === "This bibliography entry is not included in the compiled PDF.") {
        setError(null);
        setNotice(null);
        setWarning(message);
      } else {
        setWarning(null);
        setError(message);
      }
    } finally {
      if (forwardSyncGenerationRef.current === requestGeneration) setLocatingPdf(false);
    }
  }, [
    forwardSyncPosition, locatingPdf, pdfUrl, runBuild, save, savedSource, secondaryFile, secondarySavedSource,
    secondarySource, source,
  ]);

  const navigateOutline = useCallback(async (path: string, line: number) => {
    const requestGeneration = outlineSyncGenerationRef.current + 1;
    outlineSyncGenerationRef.current = requestGeneration;
    const projectGeneration = projectOperationGenerationRef.current;
    const projectRoot = projectRef.current?.root;
    const isCurrentRequest = (checkPosition = true) => (
      outlineSyncGenerationRef.current === requestGeneration
      && projectOperationGenerationRef.current === projectGeneration
      && projectRef.current?.root === projectRoot
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
      const target = await invoke<PdfSyncResponse | null>("synctex_view", {
        path,
        line,
        column: 0,
      });
      if (!isCurrentRequest()) return;
      if (target) setPdfSyncTarget({ ...target, id: crypto.randomUUID() });
      setCanvasMode((mode) => (
        mode === "source" || mode === "dual" || mode === "columns" ? "split" : mode
      ));
      setError(null);
    } catch {
      // The source jump is still useful when this PDF has no SyncTeX map.
    }
  }, [openProjectFile]);

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
      buildPipeline.setDiagnosticsExpanded(true);
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeFile, openProjectFile, project]);
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
      for (const pane of ["primary", "secondary"] as const) {
        if (!owns()) return;
        if (pane === "primary" ? activePaper || activeAssetRef.current : secondaryAssetRef.current) continue;
        const path = pane === "primary" ? activeFileRef.current : secondaryFileRef.current;
        const clean = pane === "primary"
          ? sourceRef.current === savedSourceRef.current
          : secondarySourceRef.current === secondarySavedRef.current;
        if (!path || !clean) continue;
        const content = await invoke<string>("read_project_file", { path, projectRoot: root });
        if (!owns()) return;
        const stillClean = pane === "primary"
          ? activeFileRef.current === path && sourceRef.current === savedSourceRef.current
          : secondaryFileRef.current === path && secondarySourceRef.current === secondarySavedRef.current;
        if (stillClean) await acceptExternalText(path, content, pane);
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
  }, [runBuild, save]);
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
      activeFileRef.current = "";
      sourceRef.current = "";
      savedSourceRef.current = "";
      setActiveFile("");
      setSource("");
      setSavedSource("");
      loadViewStatesForProject(snapshot.root);
      projectRef.current = snapshot;
      projectBeforeTransitionRef.current = null;
      setProject(snapshot);
      rememberProject(snapshot);
      setProjectMenuOpen(false);
      resetAgentSelection();
      setEditorComments([]);
      setEditorCommentsOpen(false);
      setActiveEditorCommentId(null);
      setCommentPanelFocus(null);
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
      const rootDocument =
        snapshot.manifest.rootDocuments.find((document) => document.path === "main.tex")
        ?? snapshot.manifest.rootDocuments.find((document) => document.isDefault)
        ?? snapshot.manifest.rootDocuments[0];
      const isLatestBibliography = library.claimBibliographyRefresh();
      const bibliographyIndex = await loadBibliographyIndex();
      const [nextPapers, , , nextReferences] = bibliographyIndex;
      if (!ownsProjectRestore()) return;
      // Opening a file cancels workspace restoration, not the project's paper
      // scan. Apply metadata before the editor-generation guards below, but do
      // not overwrite a newer bibliography refresh triggered by a save.
      if (isLatestBibliography()) library.applyBibliographyIndex(bibliographyIndex);
      else setReferences(nextReferences ?? []);
      const allPaths = flattenProjectPaths(snapshot.files);
      const assetPaths = collectAssetPaths(snapshot.files);
      const sourcePaths = new Set(allPaths.filter((path) => (
        !isPaperTabKey(path)
        && !assetPaths.has(path)
        && isProjectSourceFilePath(path)
      )));
      // Root documents are authoritative even while a collaboration snapshot
      // is still materializing its file tree (or a lightweight test fixture
      // omits the duplicate tree node).
      for (const document of snapshot.manifest.rootDocuments) {
        if (isProjectSourceFilePath(document.path)) sourcePaths.add(document.path);
      }
      const paperKeys = new Set(nextPapers.map((paper) => paperTabKey(paper.arxivId)));
      const validTab = (path: string) => sourcePaths.has(path) || assetPaths.has(path) || paperKeys.has(path);
      const restored = loadWorkspaceLayout(snapshot.root);
      documentModeRef.current = restored?.documentMode ?? "split";
      // Reopen the complete per-project workspace when possible. Older releases
      // only remembered one file, so that value remains the migration fallback.
      const remembered = loadLastFile(snapshot.root);
      const primaryFile = restored?.activeFile && sourcePaths.has(restored.activeFile)
        ? restored.activeFile
        : remembered && sourcePaths.has(remembered)
          ? remembered
          : rootDocument?.path && sourcePaths.has(rootDocument.path)
            ? rootDocument.path
            : [...sourcePaths][0];
      if (
        !ownsProjectRestore()
        || fileLoadGenerationRef.current !== primaryRestoreGeneration
        || secondaryFileLoadGenerationRef.current !== secondaryRestoreGeneration
      ) return;
      if (primaryFile) {
        const primaryApplied = await loadFile(primaryFile, {
          expectedProjectRoot: snapshot.root,
          projectGeneration,
        });
        if (!primaryApplied || !ownsProjectRestore()) return;
      }
      const appliedPrimaryGeneration = fileLoadGenerationRef.current;
      if (!ownsProjectRestore()) return;
      const secondaryFile = restored?.secondaryFile
        && restored.secondaryFile !== primaryFile
        && sourcePaths.has(restored.secondaryFile)
        ? restored.secondaryFile
        : null;
      if (secondaryFile) {
        try {
          if (
            !ownsProjectRestore()
            || fileLoadGenerationRef.current !== appliedPrimaryGeneration
            || secondaryFileLoadGenerationRef.current !== secondaryRestoreGeneration
          ) return;
          const content = await invoke<string>("read_project_file", {
            path: secondaryFile,
            projectRoot: snapshot.root,
          });
          if (
            !ownsProjectRestore()
            || fileLoadGenerationRef.current !== appliedPrimaryGeneration
            || secondaryFileLoadGenerationRef.current !== secondaryRestoreGeneration
          ) return;
          showSecondaryText(secondaryFile, content);
        } catch {
          if (
            ownsProjectRestore()
            && secondaryFileLoadGenerationRef.current === secondaryRestoreGeneration
          ) {
            showSecondaryText(null);
          }
        }
      }
      if (
        !ownsProjectRestore()
        || fileLoadGenerationRef.current !== appliedPrimaryGeneration
        || secondaryFileLoadGenerationRef.current !== secondaryRestoreGeneration
      ) return;
      const restoredTabs = restored
        ? restored.openTabs.filter(validTab)
        : primaryFile
          ? [primaryFile]
          : [];
      if (restored) {
        const restoredPins = new Set((restored.pinnedTabs ?? []).filter(validTab));
        restoredTabs.sort((left, right) => Number(restoredPins.has(right)) - Number(restoredPins.has(left)));
      }
      const activeTab = restored?.activeTab && validTab(restored.activeTab)
        ? restored.activeTab
        : primaryFile ?? restoredTabs[0] ?? "";
      if (activeTab && !restoredTabs.includes(activeTab)) restoredTabs.push(activeTab);
      const restoredMode: CanvasMode = paperKeys.has(activeTab)
        ? restored?.canvasMode === "source" || restored?.canvasMode === "split"
          ? restored.canvasMode
          : "pdf"
        : assetPaths.has(activeTab)
          ? "asset"
          : isHtmlFilePath(activeTab)
            ? restored?.activeTab === activeTab
              && (restored.canvasMode === "source" || restored.canvasMode === "split" || restored.canvasMode === "pdf")
              ? restored.canvasMode
              : "pdf"
          : !isPreviewableSourceFilePath(activeTab)
            ? restored?.canvasMode === "dual" || restored?.canvasMode === "columns"
              ? restored.canvasMode
              : "source"
          : (restored?.canvasMode === "dual" || restored?.canvasMode === "columns") && !secondaryFile
            ? "split"
            : restored?.canvasMode ?? "split";
      if (isHtmlFilePath(activeTab)) htmlViewModesRef.current.set(activeTab, restoredMode as DocumentViewMode);
      setOpenTabs(restoredTabs);
      setPinnedTabs(restored?.pinnedTabs?.filter(validTab) ?? []);
      tabRecency.current = restored?.tabRecency.filter((path) => restoredTabs.includes(path)) ?? [];
      for (const path of restoredTabs) {
        if (!tabRecency.current.includes(path)) tabRecency.current.push(path);
      }
      setFocusedPane(
        secondaryFile
        && (restoredMode === "dual" || restoredMode === "columns")
        && restored?.focusedPane === "secondary"
          ? "secondary"
          : "primary",
      );
      setCanvasMode(restoredMode);
      setPaperView(restored?.paperView ?? "blog");
      setNavStack(primaryFile ? [{ path: primaryFile, line: 1 }] : []);
      setNavIndex(primaryFile ? 0 : -1);
      await refreshUnusedSymbols();
      await loadHistory();
      setEditorComments(await invoke<EditorComment[]>("list_editor_comments").catch(() => []));
      await loadTodos();
      await loadWordCount();
      setPdfPageCount(null);
      setChecklistOpen(false);
      if (paperKeys.has(activeTab) || assetPaths.has(activeTab)) {
        pendingWorkspaceSurfaceRef.current = {
          root: snapshot.root,
          activeTab,
          canvasMode: restoredMode,
          paperView: restored?.paperView ?? "blog",
        };
      } else {
        setWorkspacePersistenceReadyRoot(snapshot.root);
      }
      // Never animate shell opacity from 0 — a cancelled/interrupted tween leaves the
      // whole window blank white with the UI still "mounted".
      if (shellRef.current) shellRef.current.style.opacity = "1";
    },
    [
      beginProjectTransition, loadViewStatesForProject, loadFile,
      refreshUnusedSymbols, rememberProject, resetAgentSelection, resetForProject, runBuild, settleCollabBeforeProjectSwitch,
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
  /// takes it in place. The backend deliberately does not bind these on
  /// creation, so this is the only thing that decides where they land.
  const revealNewProject = useCallback(async (root: string) => {
    if (project?.root) {
      await openProjectWindow(root);
      return;
    }
    await enterProject(await invoke<ProjectSnapshot>("open_project", { path: root }));
  }, [enterProject, openProjectWindow, project?.root]);

  const openClonedOverleafProject = useCallback(async (root: string) => {
    setBusyLabel("Opening the Overleaf project…");
    const openHere = !project?.root;
    try {
      if (openHere && !await startProjectTransition()) return;
      await revealNewProject(root);
      setError(null);
    } catch (reason) {
      if (openHere) cancelProjectTransition();
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, project?.root, revealNewProject, startProjectTransition]);

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
          if (project && (source !== savedSource || (secondaryFile && secondarySource !== secondarySavedSource)) && !(await save())) return;
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
          const workspaceGeneration = collabWorkspaceGenerationRef.current + 1;
          collabWorkspaceGenerationRef.current = workspaceGeneration;
          const lease: CollabWorkspaceLease = { projectRoot: snapshot.root, generation: workspaceGeneration, isCurrent: () => collabWorkspaceGenerationRef.current === workspaceGeneration && projectRootRef.current === snapshot.root };
          collabWorkspaceLeaseRef.current = lease;
          setCollabProjectName(record.title);
          collabRoleRef.current = "guest";
          controller = await CollabProjectControllerV2.start({ deployment: v2Invite.deployment, projectInstanceId: v2Invite.projectInstanceId, credentialRef, credentialStore: store, permission: v2Invite.permission, onStatus: mapV2Status, onCatalog: handleV2Catalog, displayName: collabName, participantId: editorCommentAuthorId, onPeers: setCollabPeerList, onPermanentError: handleV2PermanentError });
          collabV2ControllerRef.current = controller;
          collabSessionRef.current = controller;
          const materialized = await controller.materializeProject(lease, v2WorkspaceCallbacks(lease));
          assertCollabWorkspaceLease(lease);
          await refreshProject();
          collabRoleRef.current = "guest";
          setCollabRole("guest");
          setActiveCollabVersion(2);
          setCollabRoom(controller.room);
          setCollabFileCount(controller.fileCount());
          // loadFile awaits openPath before publishing the session/ready state.
          // Publishing first lets DocumentCanvas render against activePath=""
          // and used to crash the entire joining app in setActivePath().
          await bindJoinedDocument(controller, materialized.openPath);
          setCollabStatus("synced");
          setNotice(`Joined v2 shared workspace · ${controller.fileCount()} files`);
          playInterfaceSound("collaboration-ready");
        } catch (reason) {
          setCollabReady(false);
          if (controller) {
            if (collabV2ControllerRef.current === controller) await clearCollabLocalState().catch(() => undefined);
            else controller.destroy();
          }
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
  }, [handleV2PermanentError, cancelProjectTransition, clearCollabLocalState, collabInvite, collabName, collabRoom, collabRoleRef, collabWorkspaceGenerationRef, editorCommentAuthorId, enterProject, handleV2Catalog, bindJoinedDocument, mapV2Status, preCollabProjectRootRef, project, refreshProject, save, savedSource, secondaryFile, secondarySavedSource, secondarySource, setCollabFileCount, setCollabPeerList, setCollabProjectName, setCollabRole, setCollabRoom, setCollabStatus, source, startProjectTransition, v2WorkspaceCallbacks]);

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
        if (project && (source !== savedSource || (secondaryFile && secondarySource !== secondarySavedSource)) && !(await save())) return;
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
        const generation = collabWorkspaceGenerationRef.current + 1; collabWorkspaceGenerationRef.current = generation;
        const lease: CollabWorkspaceLease = { projectRoot: root, generation, isCurrent: () => collabWorkspaceGenerationRef.current === generation && projectRootRef.current === root };
        collabWorkspaceLeaseRef.current = lease;
        collabRoleRef.current = record.permission === "host" ? "host" : "guest";
        controller = await CollabProjectControllerV2.start({ deployment: record.host, projectInstanceId: record.projectInstanceId, credentialRef, credentialStore: store, permission: record.permission, onStatus: mapV2Status, onCatalog: handleV2Catalog, displayName: collabName, participantId: editorCommentAuthorId, onPeers: setCollabPeerList, onPermanentError: handleV2PermanentError });
        collabV2ControllerRef.current = controller;
        collabSessionRef.current = controller;
        setCollabProjectName(record.title);
        const materialized = await controller.materializeProject(lease, v2WorkspaceCallbacks(lease));
        await refreshProject();
        collabRoleRef.current = record.permission === "host" ? "host" : "guest"; setCollabRole(collabRoleRef.current); setActiveCollabVersion(2); setCollabRoom(controller.room); setCollabFileCount(controller.fileCount()); await bindJoinedDocument(controller, materialized.openPath);
        rememberCollabProjectV2({ ...record, projectRoot: root, lastUsed: Date.now() }); refreshRecentRooms(); setCollabStatus("synced");
        playInterfaceSound("collaboration-ready");
      } catch (reason) {
        if (controller) {
          if (collabV2ControllerRef.current === controller) await clearCollabLocalState().catch(() => undefined);
          else controller.destroy();
        }
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
        setError(toMessage(reason)); setCollabStatus("error");
      }
      finally { setBusyLabel(null); }
    })();
  }, [handleV2PermanentError, cancelProjectTransition, clearCollabLocalState, collabName, collabRoleRef, collabWorkspaceGenerationRef, editorCommentAuthorId, enterProject, handleV2Catalog, bindJoinedDocument, mapV2Status, project, refreshProject, refreshRecentRooms, save, savedSource, secondaryFile, secondarySavedSource, secondarySource, setCollabFileCount, setCollabPeerList, setCollabProjectName, setCollabRole, setCollabRoom, setCollabStatus, source, startProjectTransition, v2WorkspaceCallbacks]);

  useEffect(() => {
    pendingJoinRef.current = rejoinCollabProjectV2;
  }, [rejoinCollabProjectV2]);



  const chooseExisting = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "Open a LaTeX project" });
    if (!selected) return;
    // Same rule as the recent-projects list: a window in use keeps the project
    // it has, and the chosen one gets a window of its own.
    if (project?.root) {
      await openProjectWindow(String(selected));
      return;
    }
    setBusyLabel("Opening project…");
    try {
      if (!(await save())) return;
      if (!await startProjectTransition()) return;
      await enterProject(await invoke<ProjectSnapshot>("open_project", { path: selected }));
    } catch (reason) {
      cancelProjectTransition();
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, enterProject, openProjectWindow, project?.root, save, startProjectTransition]);

  const createProject = useCallback(async () => {
    if (!createForm.name.trim()) {
      updateCreateForm({ error: "Enter a project name." });
      return;
    }
    const parent = await open({ directory: true, multiple: false, title: "Choose where to create the project" });
    if (!parent) return;
    setBusyLabel("Creating project…");
    // Only an empty window is about to lose what it is showing, so only it has
    // to save and take the switch lock first.
    const openHere = !project?.root;
    try {
      if (openHere && !(await save())) return;
      if (openHere && !await startProjectTransition()) return;
      const snapshot = await invoke<ProjectSnapshot>("create_project", {
        parent,
        name: createForm.name,
        venue: createForm.venue,
      });
      updateCreateForm({ open: false });
      await revealNewProject(snapshot.root);
    } catch (reason) {
      if (openHere) cancelProjectTransition();
      updateCreateForm({ error: toMessage(reason) });
    } finally {
      setBusyLabel(null);
    }
  }, [
    cancelProjectTransition, createForm.name, createForm.venue, project?.root, revealNewProject, save,
    startProjectTransition, updateCreateForm,
  ]);

  const openTutorialProject = useCallback(async () => {
    autoTutorialAttemptedRef.current = true;
    setBusyLabel("Preparing tutorial…");
    try {
      if (!(await save())) {
        autoTutorialAttemptedRef.current = false;
        return false;
      }
      if (!await startProjectTransition()) {
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
  }, [cancelProjectTransition, enterProject, save, setSidebarOpen, startProjectTransition]);
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
    setBusyLabel(t`Importing ZIP…`);
    const openHere = !project?.root;
    try {
      if (openHere && !(await save())) return;
      if (openHere && !await startProjectTransition()) return;
      const snapshot = await invoke<ProjectSnapshot>("import_project_zip", { zipPath, parent });
      await revealNewProject(snapshot.root);
    } catch (reason) {
      if (openHere) cancelProjectTransition();
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, project?.root, revealNewProject, save, startProjectTransition]);

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
    if (!(await save())) return;
    setBusyLabel("Switching project…");
    try {
      if (!await startProjectTransition()) return;
      await enterProject(await invoke<ProjectSnapshot>("open_project", { path }));
    } catch (reason) {
      cancelProjectTransition();
      setRecentProjects(forgetRecentProject(path));
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, enterProject, openProjectWindow, project?.root, save, startProjectTransition]);

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
  }, [activePaper, buildPreferences.autoBuildMode, save, saveAndCompileAutomatically]);

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
      commit: (content) => {
        setSource(content);
        setSavedSource(content);
      },
    },
    onCite: (key) => {
      setCiteInsertRequest({ key, command: "cite", id: crypto.randomUUID() });
      setCanvasMode((mode) => (mode === "pdf" || mode === "asset" ? "split" : mode));
    },
  });

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
    const projectRoot = projectRef.current?.root;
    const projectGeneration = projectOperationGenerationRef.current;
    const isLatestLoad = () => (
      loadGeneration === fileLoadGenerationRef.current
      && projectOperationGenerationRef.current === projectGeneration
      && projectRef.current?.root === projectRoot
    );
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
      // Full text and the overview are independent: an arxiv2md conversion can
      // fail while alphaXiv still supplied a useful blog. Keep either readable
      // result instead of letting one rejected promise discard the other.
      // Existing library rows must stay local on open. Refreshing alphaXiv in
      // the foreground made a cached Paper switch wait hundreds of milliseconds
      // (and occasionally seconds) on the network before showing local bytes.
      const readPaper = () => Promise.allSettled([
        invoke<string>("read_paper", { arxivId: paper.arxivId }),
        invoke<string | null>("read_paper_blog_local", { arxivId: paper.arxivId }),
      ]);
      const paperPath = `.research/papers/${paper.arxivId}/paper.md`;
      const blogPath = `.research/papers/${paper.arxivId}/blog.md`;
      const activePaperBufferDirty = paperBuffersDirty();
      const targetAliasesDirtyBuffer = (
        activePaper?.arxivId === paper.arxivId && activePaperBufferDirty
      ) || (
        (activeFile === paperPath || activeFile === blogPath)
        && sourceRef.current !== savedSourceRef.current
      ) || (
        (secondaryFile === paperPath || secondaryFile === blogPath)
        && secondarySource !== secondarySavedSource
      );
      let results: Awaited<ReturnType<typeof readPaper>>;
      if (targetAliasesDirtyBuffer) {
        if (!(await save())) return null;
        if (!isLatestLoad()) return null;
        results = await readPaper();
      } else {
        const [saved, loaded] = await Promise.all([save(), readPaper()]);
        if (!saved) return null;
        results = loaded;
      }
      const [fullTextResult, blogResult] = results;
      if (!isLatestLoad()) return null;
      const fullText = fullTextResult.status === "fulfilled" ? fullTextResult.value : "";
      const blog = blogResult.status === "fulfilled" ? blogResult.value : null;
      if (!fullText && !blog) {
        throw fullTextResult.status === "rejected"
          ? fullTextResult.reason
          : new Error(t`No readable paper content is available.`);
      }
      // The old editor stayed live while save/read ran. If it changed in that
      // interval, keep it on screen for autosave instead of replacing it with
      // the Paper and dropping the late edit.
      if (flushAndCheckPrimaryDirty(activePaper ? "paper" : activeAsset ? "asset" : "file")) return null;
      setPaperBuffers(fullText, blog);
      setPaperView((current) => (
        current === "fulltext" && fullText
          ? "fulltext"
          : blog
            ? "blog"
            : "fulltext"
      ));
      if (!fullText && blog) setNotice("Full paper text is unavailable; showing the overview instead.");
      setActivePaper(paper);
      setPaperSide("left");
      showActiveAsset(null);
      setFocusedPane("primary");
      setCanvasMode("pdf");
      const key = paperTabKey(paper.arxivId);
      addOpenTab(key);
      recordNavigationTiming("paper", paper.title, switchStartedAt, {
        openingPaintMs,
        flushMs,
        saveAndReadMs: performance.now() - contentLoadStartedAt,
      });
      return { hasBlog: blog !== null, hasFullText: Boolean(fullText) };
    } catch (reason) {
      if (isLatestLoad()) setError(toMessage(reason));
      return null;
    } finally {
      clearOpening();
      if (paperLoadGenerationRef.current === loadGeneration) {
        paperLoadGenerationRef.current = null;
      }
    }
  }, [
    activeAsset, activeFile, activePaper, activePaperDirty, cancelPreviewPrewarm, flushAndCheckPrimaryDirty,
    save, secondaryFile, secondarySavedSource, secondarySource, t,
  ]);

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
    setPaperFetchStates((current) => ({ ...current, [key]: "loading" }));
    try {
      // Two fetchable shapes: an arXiv id (HTML or PDF route) and a cited
      // webpage (Firecrawl capture). Both return the same bundle contract, so
      // everything after this line treats them identically.
      const result = paper.arxivId && !paper.arxivId.startsWith("web-")
        ? await invoke<{ arxivId: string; paperPath: string; blogPath?: string | null }>("fetch_paper", {
          arxivId: paper.arxivId,
        })
        : await invoke<{ arxivId: string; paperPath: string; blogPath?: string | null }>("fetch_web_reference", {
          url: paper.url,
        });
      await refreshProject();
      const fetched = (await invoke<PaperSummary[]>("list_papers"))
        .find((item) => item.arxivId === result.arxivId) ?? { ...paper, hasFullText: true };
      setPaperFetchStates((current) => ({ ...current, [key]: "success" }));
      if (paperFetchTimers.current[key]) window.clearTimeout(paperFetchTimers.current[key]);
      paperFetchTimers.current[key] = window.setTimeout(() => {
        setPaperFetchStates((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
        delete paperFetchTimers.current[key];
      }, 1100);
      if (fileLoadGenerationRef.current !== loadGeneration) return;
      const opened = await openPaper(fetched, loadGeneration);
      if (!opened || fileLoadGenerationRef.current !== loadGeneration) return;
      if (tutorialActive && tutorialStep === TUTORIAL_STEPS.importVit && result.arxivId === "2010.11929") {
        if (opened?.hasBlog) changePaperView("blog");
        setTutorialStep(opened?.hasBlog ? TUTORIAL_STEPS.paperBlog : TUTORIAL_STEPS.paperFullText);
      }
    } catch (reason) {
      setPaperFetchStates((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      if (fileLoadGenerationRef.current === loadGeneration) setError(toMessage(reason));
    } finally {
      if (paperLoadGenerationRef.current === loadGeneration) {
        paperLoadGenerationRef.current = null;
      }
      referenceImport.clearStage();
    }
  }, [changePaperView, openPaper, refreshProject, tutorialActive, tutorialStep]);

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
    const projectRoot = projectRef.current?.root;
    const projectGeneration = projectOperationGenerationRef.current;
    const isLatestLoad = () => (
      loadGeneration === fileLoadGenerationRef.current
      && projectOperationGenerationRef.current === projectGeneration
      && projectRef.current?.root === projectRoot
    );
    try {
      if (!(await save())) return false;
      if (!isLatestLoad()) return false;
      const asset = await invoke<AssetPreview>("read_project_asset", { path });
      if (!isLatestLoad() || flushAndCheckPrimaryDirty(activePaper ? "paper" : activeAsset ? "asset" : "file")) return false;
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
  }, [activeAsset, activePaper, flushAndCheckPrimaryDirty, save]);

  type DropPaneContent =
    | { kind: "source"; path: string; source: string; savedSource: string }
    | { kind: "asset"; path: string; asset: AssetPreview }
    | {
        kind: "paper";
        path: string;
        paper: PaperSummary;
        markdown: string;
        savedMarkdown: string;
        blog: string | null;
        savedBlog: string | null;
        view: "blog" | "fulltext";
      };

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
    const projectGeneration = projectOperationGenerationRef.current;
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
      && projectOperationGenerationRef.current === projectGeneration
      && projectRef.current?.root === projectRoot
    );
    const sourceContent = (
      sourcePath: string,
      content: string,
      savedContent = content,
    ): DropPaneContent => ({
      kind: "source",
      path: sourcePath,
      source: content,
      savedSource: savedContent,
    });
    const assetContent = (asset: AssetPreview): DropPaneContent => ({
      kind: "asset",
      path: asset.path,
      asset,
    });
    const paperContent = (
      paper: PaperSummary,
      markdown: string,
      savedMarkdown: string,
      blog: string | null,
      savedBlog: string | null,
      view: "blog" | "fulltext",
    ): DropPaneContent => ({
      kind: "paper",
      path: paperTabKey(paper.arxivId),
      paper,
      markdown,
      savedMarkdown,
      blog,
      savedBlog,
      view,
    });
    const activePaperContent = (): DropPaneContent | null => activePaper
      ? paperContent(
          activePaper,
          paperMarkdownRef.current,
          savedPaperMarkdownRef.current,
          paperBlogRef.current,
          savedPaperBlogRef.current,
          paperView,
        )
      : null;
    const primarySourceContent = (): DropPaneContent | null => (
      activeFileRef.current
        ? sourceContent(activeFileRef.current, sourceRef.current, savedSourceRef.current)
        : null
    );
    const currentPanes = (): { left: DropPaneContent | null; right: DropPaneContent | null } => {
      const currentPaper = activePaperContent();
      if (currentPaper) {
        const other = secondaryAssetRef.current
          ? assetContent(secondaryAssetRef.current)
          : secondaryFileRef.current
            ? sourceContent(
                secondaryFileRef.current,
                secondarySourceRef.current,
                secondarySavedRef.current,
              )
            : null;
        if ((canvasMode === "dual" || canvasMode === "columns") && other) {
          return paperSide === "right"
            ? { left: other, right: currentPaper }
            : { left: currentPaper, right: other };
        }
        return { left: currentPaper, right: null };
      }
      if (canvasMode === "asset") {
        return {
          left: activeAssetRef.current ? assetContent(activeAssetRef.current) : null,
          right: null,
        };
      }
      if (canvasMode === "dual" || canvasMode === "columns") {
        return {
          left: activeAssetRef.current
            ? assetContent(activeAssetRef.current)
            : primarySourceContent(),
          right: secondaryAssetRef.current
            ? assetContent(secondaryAssetRef.current)
            : secondaryFileRef.current
              ? sourceContent(
                secondaryFileRef.current,
                secondarySourceRef.current,
                secondarySavedRef.current,
              )
              : null,
        };
      }
      if (canvasMode === "split") {
        // Legacy source + asset splits stored the asset in activeAsset. Treat
        // it as the right pane while normalizing future drops to dual panes.
        return {
          left: primarySourceContent(),
          right: activeAssetRef.current ? assetContent(activeAssetRef.current) : null,
        };
      }
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
    const loadDropContent = async (): Promise<DropPaneContent | null> => {
      if (isPaperTabKey(path)) {
        const currentPaper = activePaperContent();
        if (currentPaper?.path === path) return currentPaper;
        const paper = papers.find((item) => paperTabKey(item.arxivId) === path);
        if (!paper) return null;
        const [fullTextResult, blogResult] = await Promise.allSettled([
          invoke<string>("read_paper", { arxivId: paper.arxivId }),
          invoke<string | null>("read_paper_blog_local", { arxivId: paper.arxivId }),
        ]);
        if (!isCurrentDrop()) return null;
        const markdown = fullTextResult.status === "fulfilled" ? fullTextResult.value : "";
        const blog = blogResult.status === "fulfilled" ? blogResult.value : null;
        if (!markdown && !blog) {
          throw fullTextResult.status === "rejected"
            ? fullTextResult.reason
            : new Error(t`No readable paper content is available.`);
        }
        const view = paperView === "fulltext" && markdown
          ? "fulltext"
          : blog
            ? "blog"
            : "fulltext";
        return paperContent(paper, markdown, markdown, blog, blog, view);
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
        secondaryFileLoadGenerationRef.current += 1;
        showSecondaryText(path, outgoingSource, outgoingSavedSource);
        showSecondaryAsset(null);
        documentModeRef.current = "dual";
        if (!hasExistingPaneDivider) {
          setDualRatioResetGeneration((generation) => generation + 1);
        }
        updateDualPreviews(
          sourceContent(fallback, sourceRef.current, savedSourceRef.current),
          sourceContent(path, outgoingSource, outgoingSavedSource),
        );
        setCanvasMode("dual");
        setFocusedPane("secondary");
        setError(null);
        return;
      }
      const target = await loadDropContent();
      if (!target || !isCurrentDrop()) return;
      const current = currentPanes();
      let left = current.left;
      let right = current.right;
      if (zone === "left") {
        if (sameContent(target, left)) {
          setFocusedPane(target.kind === "paper" ? "primary" : activePaper ? "secondary" : "primary");
          return;
        }
        const displaced = left;
        left = target;
        if (!right) right = displaced;
        else if (sameContent(target, right)) right = displaced;
      } else {
        if (sameContent(target, right)) {
          setFocusedPane(target.kind === "paper" ? "primary" : "secondary");
          return;
        }
        const displaced = right;
        right = target;
        if (!left) left = displaced;
        else if (sameContent(target, left)) left = displaced;
      }
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

        secondaryFileLoadGenerationRef.current += 1;
        if (other.kind === "source") {
          showSecondaryText(other.path, other.source, other.savedSource);
          showSecondaryAsset(null);
        } else if (other.kind === "asset") {
          showSecondaryText(null);
          showSecondaryAsset(other.asset);
        }
        addOpenTab(other.path);
        documentModeRef.current = "dual";
        if (!hasExistingPaneDivider) {
          setDualRatioResetGeneration((generation) => generation + 1);
        }
        setDualPanePreview(null);
        setCanvasMode("dual");
        setFocusedPane(target.kind === "paper" ? "primary" : "secondary");
        setError(null);
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

      secondaryFileLoadGenerationRef.current += 1;
      if (right.kind === "source") {
        showSecondaryText(right.path, right.source, right.savedSource);
        showSecondaryAsset(null);
        addOpenTab(right.path);
      } else {
        showSecondaryText(null);
        showSecondaryAsset(right.asset);
        addOpenTab(right.path);
      }
      documentModeRef.current = "dual";
      if (!hasExistingPaneDivider) {
        setDualRatioResetGeneration((generation) => generation + 1);
      }
      updateDualPreviews(left, right);
      setCanvasMode("dual");
      setFocusedPane(zone === "left" ? "primary" : "secondary");
      setError(null);
    } catch (reason) {
      if (isCurrentDrop()) setError(toMessage(reason));
    }
  }, [
    activeCollabVersion, canvasMode, dualPanePreview, loadFile, openPaper, openProjectAsset, openProjectFile,
    openTabs, activePaper, paperSide, paperView, papers, projectAssetPaths, save, t,
  ]);
  const closeSplitView = useCallback(() => {
    if (canvasMode !== "dual" && canvasMode !== "columns") return;
    const focusedPath = focusedPane === "secondary"
      ? secondaryAsset?.path ?? secondaryFile
      : activePaper
        ? paperTabKey(activePaper.arxivId)
        : activeAsset?.path ?? activeFile;
    if (focusedPath) {
      void dropProjectPath(focusedPath, "center", {
        preservePreview: focusedPanePreview,
      });
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
      closedTabsRef.current = [
        path,
        ...closedTabsRef.current.filter((item) => item !== path),
      ].slice(0, 20);
    };

    if (canvasMode === "dual" || canvasMode === "columns") {
      const primaryPath = activePaper
        ? paperTabKey(activePaper.arxivId)
        : activeAsset?.path ?? activeFile;
      const secondaryPath = secondaryAsset?.path ?? secondaryFile;
      const closingPrimary = path === primaryPath;
      const closingSecondary = path === secondaryPath;
      const survivingPath = closingPrimary
        ? secondaryPath
        : closingSecondary
          ? primaryPath
          : null;
      if (survivingPath && survivingPath !== path) {
        const currentDualPreview = dualPanePreview?.projectRoot === projectRef.current?.root
          ? dualPanePreview
          : null;
        const survivingPreview = currentDualPreview
          && (closingPrimary
            ? currentDualPreview.secondaryPath === survivingPath
            : currentDualPreview.primaryPath === survivingPath);
        const closingDirtySource = (path === activeFile && sourceRef.current !== savedSourceRef.current)
          || (path === secondaryFile && secondarySourceRef.current !== secondarySavedRef.current);
        if (closingDirtySource && !(await save())) return;
        if (await dropProjectPath(survivingPath, "center", {
          preservePreview: Boolean(survivingPreview),
        }) !== true) return;
        finishClose();
        return;
      }
    }

    const closingActivePaper = Boolean(
      isPaperTabKey(path)
      && activePaper
      && paperTabKey(activePaper.arxivId) === path,
    );
    const fileFallback = [...remaining].reverse().find((key) => (
      !isPaperTabKey(key) && !projectAssetPaths.has(key)
    ));
    if (closingActivePaper) {
      const loadGeneration = fileLoadGenerationRef.current + 1;
      fileLoadGenerationRef.current = loadGeneration;
      setPrimaryOpening(null);
      // Deferred visual edits are not represented by activePaperDirty yet.
      // Flush before the dirty check and keep all ownership/tab mutations
      // behind a successful save and fallback load.
      if (visualMarkdownFlushRef.current?.() === false) return;
      if (
        (paperBuffersDirty())
        && !(await save())
      ) return;
      if (fileLoadGenerationRef.current !== loadGeneration) return;
      if (flushAndCheckPrimaryDirty("paper")) return;
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
        if (canvasMode === "dual" || canvasMode === "columns") {
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
      if (path !== activeFile) return;
    }
    if (path !== activeFile) return;
    if (fileFallback) await openProjectFile(fileFallback);
  }, [
    activeAsset, activeFile, activePaper, canvasMode, dropProjectPath, dualPanePreview,
    flushAndCheckPrimaryDirty, loadFile, openProjectFile, projectAssetPaths, save, secondaryAsset,
    secondaryFile,
  ]);

  useEffect(() => {
    dropProjectPathRef.current = dropProjectPath;
  }, [dropProjectPath]);

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
            setCanvasMode(
              pending.canvasMode === "source" || pending.canvasMode === "split"
                ? pending.canvasMode
                : "pdf",
            );
          }
        }
      } else {
        if (!(await openProjectAsset(pending.activeTab))) return;
      }
      if (projectRef.current?.root === pending.root) {
        setWorkspacePersistenceReadyRoot(pending.root);
      }
    })();
  }, [changePaperView, openPaper, openProjectAsset, papers, project?.root]);

  useEffect(() => {
    referencePreviewCache.current.clear();
  }, [project?.root, references]);

  useEffect(() => {
    const projectRoot = project?.root;
    if (!projectRoot) return;
    let stopped = false;
    let unlisten: (() => void) | null = null;
    void listen<{ root: string; paths?: string[] | null }>("project-fs-changed", (event) => {
      if (stopped || event.payload.root !== projectRoot) return;
      const changedPaths = event.payload.paths;
      let touchesLoadedImage = !changedPaths?.length;
      if (!touchesLoadedImage && changedPaths) {
        for (const rawPath of changedPaths) {
          const changedPath = normalizeProjectRelativePath(rawPath);
          if (!changedPath) {
            touchesLoadedImage = true;
            break;
          }
          const loaded = referencePreviewPaths.current;
          if (loaded.root === projectRoot && Array.from(loaded.paths).some((loadedPath) => (
            loadedPath === changedPath || loadedPath.startsWith(`${changedPath}/`)
          ))) {
            touchesLoadedImage = true;
            break;
          }
        }
      }
      if (!touchesLoadedImage) return;
      // Relative images can be replaced without changing their path or the
      // surrounding HTML/Markdown. Refresh mounted previews only when the
      // watcher names one of their assets; paper-library and .git churn must
      // not make an unrelated document repaint.
      referencePreviewCache.current.clear();
      referencePreviewGenerationRef.current += 1;
      setReferencePreviewGeneration(referencePreviewGenerationRef.current);
    }).then((dispose) => {
      if (stopped) dispose();
      else unlisten = dispose;
    });
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [project?.root]);

  const loadReferenceImage = useCallback((path: string) => {
    const projectRoot = project?.root ?? "";
    if (referencePreviewPaths.current.root !== projectRoot) {
      referencePreviewPaths.current = { root: projectRoot, paths: new Set() };
    }
    const normalizedPath = normalizeProjectRelativePath(path);
    if (normalizedPath) referencePreviewPaths.current.paths.add(normalizedPath);
    const key = `${projectRoot}\0${referencePreviewGenerationRef.current}\0${path}`;
    const cached = referencePreviewCache.current.get(key);
    if (cached) {
      referencePreviewCache.current.delete(key);
      referencePreviewCache.current.set(key, cached);
      return cached.promise;
    }
    const preview = invoke<AssetPreview>("read_project_asset", { path, projectRoot })
      .then(referenceAssetPreviewDataUrl)
      .then((dataUrl) => {
        const current = referencePreviewCache.current.get(key);
        if (current?.promise === preview) {
          if (dataUrl === null) {
            // A paper import can expose its Markdown before every extracted
            // asset is readable. Do not memoize that transient miss forever;
            // ProjectImageHost performs a small bounded retry sequence.
            referencePreviewCache.current.delete(key);
            return dataUrl;
          }
          current.characters = dataUrl?.length ?? 0;
          referencePreviewCache.current.delete(key);
          referencePreviewCache.current.set(key, current);
          trimReferencePreviewCache(referencePreviewCache.current);
        }
        return dataUrl;
      })
      .catch((reason) => {
        if (referencePreviewCache.current.get(key)?.promise === preview) {
          referencePreviewCache.current.delete(key);
        }
        throw reason;
      });
    const entry = { promise: preview, characters: 0 };
    referencePreviewCache.current.set(key, entry);
    trimReferencePreviewCache(referencePreviewCache.current);
    return preview;
  }, [project?.root]);

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
  }, [changePaperView, openPaper, openProjectAssetFromClick, openProjectFileFromClick, papers]);
  useEffect(() => {
    openMarkdownProjectPathRef.current = openMarkdownProjectPath;
  }, [openMarkdownProjectPath]);

  const beginProjectFigureDrag = useCallback((path: string, label: string, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let dragging = false;
    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (!dragging && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 5) return;
      if (!dragging) document.body.classList.add("dragging-project-item");
      dragging = true;
      pointerEvent.preventDefault();
      const preview = editorDropPreviewAt(path, pointerEvent.clientX, pointerEvent.clientY);
      setProjectFileDropPreview(preview);
      setFigurePointerDrag({
        path,
        label,
        clientX: pointerEvent.clientX,
        clientY: pointerEvent.clientY,
        overCanvas: Boolean(preview),
        insertAtEditor: false,
      });
    };
    const clear = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      document.body.classList.remove("dragging-project-item");
      setProjectFileDropPreview(null);
      setFigurePointerDrag(null);
    };
    const finish = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      const preview = dragging
        ? editorDropPreviewAt(path, pointerEvent.clientX, pointerEvent.clientY)
        : null;
      clear();
      if (!dragging) return;
      suppressedFigureClick.current = path;
      window.setTimeout(() => {
        if (suppressedFigureClick.current === path) suppressedFigureClick.current = null;
      }, 0);
      if (preview) void dropProjectPathRef.current(path, preview.zone);
    };
    const cancel = () => clear();
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  }, []);

  const beginProjectFileDrag = useCallback((path: string, _label: string, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let dragging = false;
    const move = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (!dragging && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 5) {
        return;
      }
      if (!dragging) document.body.classList.add("dragging-project-item");
      dragging = true;
      const pane = editorPaneAt({ x: pointerEvent.clientX, y: pointerEvent.clientY });
      setFileDropTargetPane(pane);
      setProjectFileDropPreview(editorDropPreviewAt(
        path,
        pointerEvent.clientX,
        pointerEvent.clientY,
      ));
    };
    const clear = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      document.body.classList.remove("dragging-project-item");
      setFileDropTargetPane(null);
      setProjectFileDropPreview(null);
    };
    const finish = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      const preview = dragging
        ? editorDropPreviewAt(path, pointerEvent.clientX, pointerEvent.clientY)
        : null;
      clear();
      if (!dragging) return;
      suppressedProjectFileClick.current = path;
      window.setTimeout(() => {
        if (suppressedProjectFileClick.current === path) {
          suppressedProjectFileClick.current = null;
        }
      }, 0);
      if (preview) void dropProjectPathRef.current(path, preview.zone);
    };
    const cancel = () => clear();
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  }, []);

  const ensureSecondaryFile = useCallback(async (preferred?: string | null) => {
    const primaryPath = activeFileRef.current;
    const eligible = (path: string) => (
      path !== primaryPath
      && openTabs.includes(path)
      && !isPaperTabKey(path)
      && !projectAssetPaths.has(path)
    );
    const preferredCandidate = preferred
      && eligible(preferred)
      ? preferred
      : null;
    const recentCandidate = tabRecency.current.find(eligible) ?? null;
    const candidate = preferredCandidate
      ?? recentCandidate
      ?? (secondaryFile && secondaryFile !== primaryPath ? secondaryFile : null)
      ?? openTabs.find((path) => path !== primaryPath && path.endsWith(".tex"))
      ?? openTabs.find(eligible)
      ?? null;
    if (!candidate) return null;
    if (candidate === secondaryFile) return candidate;
    const requestGeneration = secondaryFileLoadGenerationRef.current + 1;
    secondaryFileLoadGenerationRef.current = requestGeneration;
    const projectRoot = projectRef.current?.root;
    const projectGeneration = projectOperationGenerationRef.current;
    const primaryLoadGeneration = fileLoadGenerationRef.current;
    const isLatestRequest = () => (
      requestGeneration === secondaryFileLoadGenerationRef.current
      && projectOperationGenerationRef.current === projectGeneration
      && projectRef.current?.root === projectRoot
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
  }, [activeCollabVersion, openTabs, projectAssetPaths, secondaryFile]);

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
          const restoring = dropProjectPath(promotedSplit.primaryPath, "left", {
            preserveSplitRatio: true,
          });
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
        && (canvasMode === "dual" || canvasMode === "columns")
      ) {
        const projectRoot = projectRef.current?.root;
        if (!projectRoot) return;
        const panePath = focusedPane === "secondary" ? secondaryFile : activeFile;
        const paneAsset = focusedPane === "secondary" ? secondaryAsset : activeAsset;
        if (!panePath || paneAsset || !isPreviewableSourceFilePath(panePath)) return;
        setDualPanePreview((current) => {
          const primaryPath = current?.projectRoot === projectRoot ? current.primaryPath : null;
          const secondaryPath = current?.projectRoot === projectRoot ? current.secondaryPath : null;
          const next = focusedPane === "secondary"
            ? {
                projectRoot,
                primaryPath,
                secondaryPath: mode === "pdf" ? panePath : null,
              }
            : {
                projectRoot,
                primaryPath: mode === "pdf" ? panePath : null,
                secondaryPath,
              };
          return next.primaryPath || next.secondaryPath ? next : null;
        });
        documentModeRef.current = canvasMode;
        markdownModeViewportCaptureRef.current?.();
        return;
      }
      if (
        mode === "split"
        && (canvasMode === "dual" || canvasMode === "columns")
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
        temporarilyPromotedSplitRef.current = {
          projectRoot,
          primaryPath: originalPrimaryPath,
          splitPath: secondaryFile,
        };
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
      if (nextMode !== "pdf" && activeFile) {
        addOpenTab(activeFile);
      }
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
    activeAsset, activeFile, activePaper, activePaperDirty, canvasMode, dropProjectPath, ensureSecondaryFile,
    focusedPane, save, secondaryAsset, secondaryFile,
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
    const projectRoot = projectRef.current?.root;
    const projectGeneration = projectOperationGenerationRef.current;
    const isLatestSwap = () => (
      fileLoadGenerationRef.current === loadGeneration
      && projectOperationGenerationRef.current === projectGeneration
      && projectRef.current?.root === projectRoot
    );
    try {
      if (visualMarkdownFlushRef.current?.() === false) return;
      const outgoingPrimary = sourceRef.current;
      const outgoingSecondary = secondarySourceRef.current;
      if (outgoingPrimary !== savedSourceRef.current || secondarySource !== secondarySavedSource) {
        if (!(await save())) return;
      }
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
      const secondaryContent = outgoingPrimary;
      showSecondaryText(nextSecondary, secondaryContent);
      setOpenTabs((tabs) => {
        const next = new Set(tabs);
        next.add(nextPrimary);
        next.add(nextSecondary);
        return [...next];
      });
      setFocusedPane((pane) => (pane === "primary" ? "secondary" : "primary"));
      // loadFile may have retargeted the layout for the new primary's type;
      // a swap must land back in the supported two-editor mode either way.
      setCanvasMode("dual");
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [
    activeFile, flushAndCheckPrimaryDirty, loadFile, save, secondaryFile, secondarySavedSource,
    secondarySource,
  ]);

  const createProjectEntry = useCallback(async (
    path: string,
    kind: "file" | "folder" | "presentation",
  ) => {
    try {
      const createdPath = kind === "presentation"
        ? await invoke<string>("create_open_slide_deck", {
            deckId: path,
            projectRoot: project?.root,
          })
        : await invoke<string>("create_project_entry", {
            path,
            kind,
            projectRoot: project?.root,
          });
      allowViewState(createdPath);
      await refreshProject();
      await refreshHistory();
      if (kind !== "folder") {
        // Mid-share creates must join the v2 catalog before loadFile, so the
        // editor binds the shared doc instead of a local-only file.
        await shareCreatedFileWithCollabV2(
          createdPath,
          createdPath.toLocaleLowerCase().endsWith(".tldr")
            ? "board"
            : isSpreadsheetPath(createdPath)
              ? "spreadsheet"
              : "text",
        );
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
      if (request.args.documentType === "board") {
        await waitForAgentCanvasAdapter(createdPath, remainingMs);
      } else {
        await waitForAgentSpreadsheetDocument(createdPath, remainingMs);
      }
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
      for (const importedPath of imported) {
        allowViewState(importedPath);
      }
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
  }, [allowViewState, assetImporting, project?.root, refreshProject, shareCreatedFileWithCollabV2]);

  const importProjectSources = useCallback(async (
    paths: string[],
    targetDirectory = "",
  ): Promise<string[]> => {
    if (!paths.length || assetImporting) return [];
    setAssetImporting(true);
    try {
      const imported = await invoke<string[]>("import_project_sources", {
        paths,
        targetDirectory,
        projectRoot: project?.root,
      });
      for (const importedPath of imported) {
        allowViewState(importedPath);
      }
      await reconcileProjectTree();
      await refreshHistory();
      setError(null);
      // After setError(null): a share failure must remain visible.
      for (const path of imported) await shareCreatedFileWithCollabV2(
        path,
        path.toLocaleLowerCase().endsWith(".tldr")
          ? "board"
          : isSpreadsheetPath(path)
            ? "spreadsheet"
            : "text",
      );
      return imported;
    } catch (reason) {
      setError(toMessage(reason));
      return [];
    } finally {
      setAssetImporting(false);
      setAssetDropTarget(null);
    }
  }, [allowViewState, assetImporting, project?.root, reconcileProjectTree, refreshHistory, shareCreatedFileWithCollabV2]);

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
  ): Promise<string[]> => {
    if ((!paths.length && !browserFiles.length) || assetImporting) return [];
    setAssetImporting(true);
    try {
      const uploads = browserFiles.length
        ? await Promise.all(browserFiles.map(async (file) => ({ name: file.name, base64: await fileToBase64(file) })))
        : undefined;
      const imported = await invoke<{ path: string; kind: "text" | "board" | "spreadsheet" | "binary" }[]>(
        "import_project_files",
        { paths, targetDirectory, projectRoot: project?.root, ...(copyExisting ? { copyExisting: true } : {}), ...(uploads ? { uploads } : {}) },
      );
      for (const file of imported) {
        allowViewState(file.path);
      }
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
  }, [allowViewState, assetImporting, project?.root, reconcileProjectTree, refreshHistory, shareCreatedFileWithCollabV2]);

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
    let dispose: (() => void) | undefined;
    let active = true;
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent((event) => {
        if (!active) return;
        if (event.payload.type === "leave") {
          nativeDragPathsRef.current = [];
          setAssetDropTarget(null);
          setNativeEditorDropActive(false);
          setFileDropTargetPane(null);
          setAgentPanelDropActive(false);
          return;
        }
        if (event.payload.type === "enter") {
          nativeDragPathsRef.current = event.payload.paths;
        }
        const dragPaths = event.payload.type === "over"
          ? nativeDragPathsRef.current
          : event.payload.paths;
        const editorPosition = dropEditorAt(event.payload.position);
        const canvasTarget = dropCanvasAt(event.payload.position);
        const targetDirectory = dropDirectoryAt(event.payload.position);
        const agentPanelTarget = dropAgentPanelAt(event.payload.position);
        const dropKind = classifyExternalProjectDrop(dragPaths);
        const editorPath = editorPosition?.pane === "secondary"
          ? secondaryFileRef.current
          : activeFileRef.current;
        const insertsIntoEditor = Boolean(
          editorPosition
          && dropKind === "asset"
          && /\.(?:tex|md)$/i.test(editorPath ?? ""),
        );
        // The tree accepts every drop kind, so the highlight only tracks
        // geometry (null when the pointer is not over the Project tree).
        setAssetDropTarget(targetDirectory);
        setNativeEditorDropActive(insertsIntoEditor);
        setAgentPanelDropActive(agentPanelTarget && dropKind !== "unsupported");
        setFileDropTargetPane(
          editorPosition && (
            dropKind === "source"
            || (dropKind === "asset" && !insertsIntoEditor)
          )
            ? editorPosition.pane
            : null,
        );
        if (event.payload.type === "drop") {
          setAssetDropTarget(null);
          setNativeEditorDropActive(false);
          setFileDropTargetPane(null);
          setAgentPanelDropActive(false);
          nativeDragPathsRef.current = [];
          if (!event.payload.paths.length) return;
          if (agentPanelTarget && dropKind !== "unsupported") {
            // The agent iframe never sees native drops (Tauri intercepts
            // them), so read the bytes here and relay them over the embed
            // bridge into the composer, same as its "+" attachment menu.
            // Checked ahead of the source/mixed branches: any file the agent
            // can read (figures and text sources alike) becomes an attachment.
            void invoke<AgentComposerFilePayload[]>("read_agent_composer_files", {
              paths: event.payload.paths,
            })
              .then((files) => synara.postMessage(buildAgentComposerFilesMessage(files)))
              .catch((error) => setError(toMessage(error)));
          } else if (dropKind === "source" && (editorPosition || canvasTarget)) {
            void importProjectSources(event.payload.paths).then(async (paths) => {
              for (const path of paths) {
                await openProjectFileRef.current(
                  path,
                  undefined,
                  editorPosition?.pane ?? "primary",
                );
              }
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
              if (paths.length) {
                setFigureDropRequest({
                  id: crypto.randomUUID(),
                  paths,
                  clientX: editorPosition.x,
                  clientY: editorPosition.y,
                  pane: editorPosition.pane,
                });
              }
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
      .then((unlisten) => {
        if (active) dispose = unlisten;
        else unlisten();
      })
      .catch(() => {
        // Browser-based tests and previews do not expose native file paths.
      });
    return () => {
      active = false;
      dispose?.();
    };
  }, [importProjectAssets, importProjectFiles, importProjectSources, openProjectAsset, synara.postMessage, project]);

  const prepareLatexFigure = useCallback(async (path: string): Promise<string | null> => {
    try {
      const prepared = await invoke<string>("prepare_latex_figure", {
        path,
        projectRoot: project?.root,
      });
      if (prepared !== path) await refreshProject();
      setError(null);
      return prepared;
    } catch (reason) {
      setError(toMessage(reason));
      return null;
    }
  }, [project?.root, refreshProject]);

  const handleFigureDropHandled = useCallback((id: string) => {
    setFigureDropRequest((request) => request?.id === id ? null : request);
  }, []);

  const handleEditorNavigationHandled = useCallback((id: string) => {
    setEditorNavigation((request) => request?.id === id ? null : request);
  }, []);

  const handleEditorPosition = useCallback((position: EditorPosition) => {
    editorPositionRef.current = position;
    setEditorPosition((current) => (
      current
      && current.path === position.path
      && current.line === position.line
      && current.column === position.column
        ? current
        : position
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
      if (target.kind === "include") {
        const paths = flattenProjectPaths(project.files);
        const resolved = paths.includes(target.path)
          ? target.path
          : paths.find((path) => path === target.path || path.endsWith(`/${target.path}`));
        if (!resolved) {
          setError(`Could not find included file “${target.path}”.`);
          return;
        }
        await openProjectFile(resolved, 1);
        setError(null);
        return;
      }
      if (target.kind === "asset") {
        const paths = flattenProjectPaths(project.files);
        const resolved = paths.includes(target.path)
          ? target.path
          : paths.find((path) => path === target.path || path.endsWith(`/${target.path}`));
        if (!resolved) {
          setError(`Could not find figure “${target.path}”.`);
          return;
        }
        await openProjectAsset(resolved);
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
      // Do this before refresh awaits so autosave cannot recreate a deleted
      // open buffer and a background tab cannot later reopen a missing file.
      const deletedActiveFile = wasDeleted(activeFile);
      const deletedSecondaryFile = wasDeleted(secondaryFile);
      const deletedActiveAsset = wasDeleted(activeAsset?.path);
      const deletedSecondaryAsset = wasDeleted(secondaryAsset?.path);
      const remainingTabs = openTabsRef.current.filter((tab) => !wasDeleted(tab));
      openTabsRef.current = remainingTabs;
      setOpenTabs(remainingTabs);
      setPinnedTabs((tabs) => tabs.filter((tab) => !wasDeleted(tab)));
      tabRecency.current = tabRecency.current.filter((tab) => !wasDeleted(tab));
      closedTabsRef.current = closedTabsRef.current.filter((tab) => !wasDeleted(tab));
      setNavStack((entries) => entries.filter((entry) => !wasDeleted(entry.path)));
      setViewRestore((request) => request && wasDeleted(request.path) ? null : request);
      setEditorNavigation((request) => request && wasDeleted(request.path) ? null : request);

      if (deletedActiveFile) {
        fileLoadGenerationRef.current += 1;
        collabDetachRef.current?.();
        collabDetachRef.current = null;
        activeFileRef.current = "";
        sourceRef.current = "";
        savedSourceRef.current = "";
        setPrimaryOpening(null);
        setActiveFile("");
        setSource("");
        setSavedSource("");
      }
      if (deletedActiveAsset) {
        showActiveAsset(null);
      }
      if (deletedSecondaryFile || deletedSecondaryAsset) {
        secondaryFileLoadGenerationRef.current += 1;
        clearSecondaryPane();
        setFocusedPane("primary");
        if (
          (canvasMode === "dual" || canvasMode === "columns")
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
        if (!preview) return null;
        const primaryPath = preview.primaryPath && !wasDeleted(preview.primaryPath)
          ? preview.primaryPath
          : null;
        const secondaryPath = preview.secondaryPath && !wasDeleted(preview.secondaryPath)
          ? preview.secondaryPath
          : null;
        return primaryPath || secondaryPath ? { ...preview, primaryPath, secondaryPath } : null;
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
    activeAsset, activeCollabVersion, activeFile, activePaper, canvasMode, dualPanePreview,
    forgetViewStates, loadFile, overleafLink, project, refreshHistory, refreshProject, secondaryAsset,
    secondaryFile, settleRemoteDeletes, t,
  ]);

  const applyProjectEntryPathChanges = useCallback((changes: readonly ProjectPathChange[]) => {
    if (changes.length === 0) return;
    const remapPath = (path: string) => remapProjectPath(path, changes);

    remapViewStates(changes, remapPath);
    setProject((current) => current ? applyProjectPathChanges(current, changes) : current);
    projectGit.setGitStatus((current) => ({
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
  }, [remapOpenPaths, remapViewStates]);

  const renameProjectEntry = useCallback((path: string, name: string) => withTreeMutation(async () => {
    try {
      const requestedPath = `${path.includes("/") ? `${path.slice(0, path.lastIndexOf("/") + 1)}` : ""}${name}`;
      const v2 = collabV2ControllerRef.current;
      const renamedPath = activeCollabVersion === 2 && v2
        ? await v2.rename(path, requestedPath, {
          rename: (oldPath, _newPath, projectRoot) => collabDiskWriteQueueRef.current.run(collabWorkspaceLeaseRef.current!, oldPath, () => invoke<string>("rename_project_entry", { path: oldPath, newName: name, projectRoot })),
          delete: async () => { throw new Error("Unexpected delete during rename"); },
        })
        : await invoke<string>("rename_project_entry", {
          path,
          newName: name,
          projectRoot: project?.root,
        });
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
  }), [activeCollabVersion, applyProjectEntryPathChanges, markDiskMtime, project?.root, reconcileProjectTree, withTreeMutation]);

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
            let content: string;
            if (activeCollabVersion === 2 && v2?.hasTextPath(movedPath)) {
              const ytext = await v2.openPath(movedPath, "secondary", { sideload: true });
              content = ytext.toString();
            } else if (planned.previousPath === originalPrimaryPath) {
              content = sourceRef.current;
            } else if (planned.previousPath === originalSecondaryPath) {
              content = secondarySourceRef.current;
            } else {
              content = await invoke<string>("read_project_file", {
                path: movedPath,
                projectRoot: project?.root,
              });
            }
            const rewritten = rewriteMovedDocumentAssetPaths(
              content,
              planned.previousPath,
              movedPath,
              projectAssetPaths,
            );
            if (rewritten !== content) {
              if (planned.previousPath === originalPrimaryPath) setPrimarySource(rewritten);
              if (planned.previousPath === originalSecondaryPath) setSecondarySourceLive(rewritten);
              const published = await publishTextToCollabV2(movedPath, rewritten);
              if (!published) {
                await invoke("write_project_file", {
                  path: movedPath,
                  content: rewritten,
                  projectRoot: project?.root,
                });
              }
              if (planned.previousPath === originalPrimaryPath && sourceRef.current === rewritten) {
                savedSourceRef.current = rewritten;
                setSavedSource(rewritten);
              }
              if (planned.previousPath === originalSecondaryPath && secondarySourceRef.current === rewritten) {
                secondarySavedRef.current = rewritten;
                setSecondarySavedSource(rewritten);
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
            .map((change) => ({
              previousPath: change.nextPath,
              nextPath: change.previousPath,
            }))
          : [];
        applyProjectEntryPathChanges(rollbackChanges);
        setError(toMessage(reason));
        await reconcileProjectTree().catch(() => undefined);
        throw reason;
      }
    });
  }, [
    activeCollabVersion, applyProjectEntryPathChanges, markDiskMtime, project?.root, projectAssetPaths,
    publishTextToCollabV2, reconcileProjectTree, save, setPrimarySource, setSecondarySourceLive, t,
  ]);

  const submitRename = useCallback(async (name: string) => {
    if (!renameTarget) return;
    try {
      if (renameTarget.kind === "label" || renameTarget.kind === "citation") {
        const result = renameTarget.kind === "label"
          ? await invoke<RenameSymbolResult>("rename_label", {
            oldLabel: renameTarget.label,
            newLabel: name,
          })
          : await invoke<RenameSymbolResult>("rename_citation_key", {
            oldKey: renameTarget.key,
            newKey: name,
          });
        const [nextCitationKeys, nextCitations, nextReferences] = await Promise.all([
          invoke<string[]>("list_citation_keys"),
          invoke<CitationInfo[]>("list_citations"),
          invoke<ReferenceInfo[]>("list_references"),
        ]);
        setCitationKeys(nextCitationKeys);
        setCitations(nextCitations);
        setReferences(nextReferences);
        await refreshUnusedSymbols();
        await refreshHistory();
        if (result.changedFiles.includes(activeFile)) await loadFile(activeFile);
        setOutlineSources({});
        setReferenceHits((current) => current && {
          kind: renameTarget.kind,
          symbol: name,
          occurrences: [],
        });
        if (renameTarget.kind === "label") {
          const occurrences = await invoke<SymbolOccurrence[]>("find_label_occurrences", { label: name });
          setReferenceHits({ kind: "label", symbol: name, occurrences });
        } else {
          const occurrences = await invoke<SymbolOccurrence[]>("find_citation_occurrences", { key: name });
          setReferenceHits({ kind: "citation", symbol: name, occurrences });
        }
      } else if (renameTarget.kind === "environment") {
        setEnvRenameRequest({ newName: name, id: crypto.randomUUID() });
      } else if (renameTarget.kind === "wrap-environment") {
        setWrapEnvRequest({ name, id: crypto.randomUUID() });
      }
      setRenameError(null);
      setRenameTarget(null);
    } catch (reason) {
      setRenameError(toMessage(reason));
    }
  }, [activeFile, loadFile, refreshHistory, refreshUnusedSymbols, renameTarget]);

  const findSymbolReferences = useCallback(async (target: SymbolTarget) => {
    try {
      if (target.kind === "label") {
        const occurrences = await invoke<SymbolOccurrence[]>("find_label_occurrences", { label: target.label });
        setReferenceHits({ kind: "label", symbol: target.label, occurrences });
      } else {
        const occurrences = await invoke<SymbolOccurrence[]>("find_citation_occurrences", { key: target.key });
        setReferenceHits({ kind: "citation", symbol: target.key, occurrences });
      }
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, []);

  const beginSymbolRename = useCallback((target: SymbolTarget) => {
    setRenameError(null);
    setRenameTarget(target.kind === "label"
      ? { kind: "label", label: target.label }
      : { kind: "citation", key: target.key });
  }, []);

  const openSymbolOccurrence = useCallback(async (occurrence: SymbolOccurrence) => {
    try {
      await openProjectFile(occurrence.path, occurrence.line);
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [openProjectFile]);

  const importClipboardImageFile = useCallback(async (file: File): Promise<string | null> => {
    try {
      const base64 = await fileToBase64(file);
      const path = await invoke<string>("import_clipboard_image", {
        targetDirectory: "figures",
        fileName: clipboardImageFileName(file.type || "image/png"),
        base64Data: base64,
        projectRoot: project?.root,
      });
      await refreshProject();
      setError(null);
      // After setError(null): a share failure must remain visible.
      await shareCreatedFileWithCollabV2(path, "binary");
      return path;
    } catch (reason) {
      setError(toMessage(reason));
      return null;
    }
  }, [project?.root, refreshProject, shareCreatedFileWithCollabV2]);

  const handlePasteImageFile = useCallback((file: File) => {
    void importClipboardImageFile(file).then((path) => {
      if (!path) return;
      setFigureDropRequest({
        id: crypto.randomUUID(),
        paths: [path],
        clientX: -1,
        clientY: -1,
      });
    });
    return true;
  }, [importClipboardImageFile]);

  const importSystemClipboardImage = useCallback(async (
    targetDirectory: string,
  ): Promise<string | null> => {
    if (!project) return null;
    try {
      const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
      const image = await readImage();
      const size = await image.size();
      const rgba = await image.rgba();
      const base64 = await rgbaImageToPngBase64(rgba, size.width, size.height);
      const path = await invoke<string>("import_clipboard_image", {
        targetDirectory,
        fileName: clipboardImageFileName("image/png"),
        base64Data: base64,
        projectRoot: project.root,
      });
      await refreshProject();
      // After setError(null): a share failure must remain visible.
      setError(null);
      await shareCreatedFileWithCollabV2(path, "binary");
      return path;
    } catch (reason) {
      setError(toMessage(reason) || "No image found on the clipboard.");
      return null;
    }
  }, [project, refreshProject, shareCreatedFileWithCollabV2]);

  const pasteClipboardImage = useCallback(async () => {
    if (!project || !activeFile?.endsWith(".tex")) {
      setError("Open a .tex file before pasting a figure.");
      return;
    }
    const path = await importSystemClipboardImage("figures");
    if (!path) return;
    setCanvasMode((mode) => (mode === "pdf" || mode === "asset" ? "split" : mode));
    setFigureDropRequest({
      id: crypto.randomUUID(),
      paths: [path],
      clientX: -1,
      clientY: -1,
    });
  }, [activeFile, importSystemClipboardImage, project]);




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
    const projectGeneration = projectOperationGenerationRef.current;
    const operationIsCurrent = () => (
      projectRef.current?.root === projectRoot
      && projectOperationGenerationRef.current === projectGeneration
    );
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
      const confirmationTitle = t({
        message: `Remove “${{ title: paper.title }}” from the bibliography?`,
      });
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
        if (
          activeFileRef.current === change.path
          && sourceRef.current !== change.before
          && sourceRef.current !== change.after
        ) {
          conflictPath = change.path;
          break;
        }
        if (
          secondaryFileRef.current === change.path
          && secondarySourceRef.current !== change.before
          && secondarySourceRef.current !== change.after
        ) {
          conflictPath = change.path;
          break;
        }
        const controller = collabV2ControllerRef.current;
        if (activeCollabVersion === 2 && controller?.hasTextPath(change.path)) {
          const ytext = await controller.openPath(change.path, "secondary", { sideload: true });
          if (!operationIsCurrent()) return;
          const collabText = ytext.toString();
          if (collabText !== change.before && collabText !== change.after) {
            conflictPath = change.path;
            break;
          }
        }
      }
      if (conflictPath) {
        let reverted = false;
        if (result.transactionId) {
          try {
            await invoke("revert_transaction", {
              transactionId: result.transactionId,
              projectRoot,
            });
            reverted = true;
          } catch {
            // Revert itself is compare-and-swap guarded. If disk also changed,
            // leave both versions intact and direct the user to History.
          }
        }
        if (operationIsCurrent()) {
          setError(reverted
            ? `${conflictPath} changed while the reference was being removed. Nothing was removed; try again.`
            : `${conflictPath} changed while the reference was being removed. The newer text was preserved; review the removal in History.`);
          await refreshProject();
          await refreshHistory();
        }
        return;
      }

      const changedFiles = result.changedFiles?.length
        ? result.changedFiles
        : bibliographyPath
          ? [bibliographyPath]
          : [];
      const returnedChanges = new Map(
        (result.changes ?? []).map((change) => [change.path, change.after]),
      );
      for (const path of changedFiles) {
        const content = returnedChanges.get(path)
          ?? await invoke<string>("read_project_file", { path, projectRoot });
        const published = collabSession
          ? await publishTextToCollabV2(path, content)
          : false;
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
    activeFile, activePaper, activeCollabVersion, collabSession, markDiskMtime, project, publishTextToCollabV2,
    refreshHistory, refreshProject, save, secondaryFile, t,
  ]);

  const openSettings = useCallback((tab: SettingsTab = "appearance") => {
    if (isSynaraSettingsTab(tab)) synara.requestRuntime();
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  const revert = useCallback(
    async (id: string) => {
      if (!await confirmAction(
        "Restore the project to the state before this change? The restore will be added as a new history entry.",
      )) return;
      try {
        await invoke("revert_transaction", { transactionId: id, projectRoot: project?.root });
        if (activeFile) await loadFile(activeFile);
        await refreshProject();
        await refreshHistory();
        await compile();
      } catch (reason) {
        setError(toMessage(reason));
      }
    },
    [activeFile, compile, loadFile, project?.root, refreshHistory, refreshProject],
  );

  const deleteHistory = useCallback(async (id: string) => {
    if (!await confirmAction("Delete this history entry? This cannot be undone.")) return;
    try {
      await invoke("delete_history_entry", { transactionId: id });
      await refreshHistory();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [refreshHistory]);

  const persistEditorComments = useCallback(async (next: EditorComment[]) => {
    // What this client held before the edit is what makes a delete expressible
    // in the shared map: only a comment we actually had may be removed there.
    const previous = editorCommentsRef.current;
    setEditorComments(next);
    try {
      await invoke("save_editor_comments", { comments: next });
      const controller = collabV2ControllerRef.current;
      if (activeCollabVersion !== 2 || !controller) return;
      // The controller owns this document — it registers the file on first use
      // and pins it, so both sides keep writing to the same one.
      const doc = await controller.openCommentsDoc();
      if (!doc) return;
      seedCollabCommentsFromContent(doc);
      writeCollabComments(doc, next, previous);
      // The map now holds our edit merged with whatever peers wrote while we
      // were composing it, so adopt that union rather than our own view.
      const shared = readCollabComments(doc);
      setEditorComments(shared);
      await invoke("save_editor_comments", { comments: shared });
    } catch (reason) {
      // The comments document is opened unpinned, so the provider pool is free
      // to evict (destroy) it between publishes. Reaching a destroyed client is
      // a teardown, not a failed save — the comment is already on disk — and
      // the next publish reopens it.
      if (isClientDestroyedErrorV2(reason)) return;
      setError(toMessage(reason));
    }
  }, [activeCollabVersion]);

  /**
   * Live-update the comments panel from the shared comments file. Peer
   * publishes land in the file's Yjs doc and mirror to disk, but without this
   * observer the panel's state only refreshed on project reload. Local-origin
   * transactions (our own publishes) are skipped — state is already set.
   * collabFileCount re-runs the check so a comments file created mid-share
   * gets observed once it appears in the catalog.
   */
  useEffect(() => {
    const v2 = collabV2ControllerRef.current;
    if (activeCollabVersion !== 2 || !collabSession || !v2?.hasTextPath(EDITOR_COMMENTS_PATH)) return;
    let cancelled = false;
    let detach: (() => void) | undefined;
    void v2.openCommentsDoc().then((doc) => {
      if (cancelled || !doc) return;
      seedCollabCommentsFromContent(doc);
      const map = collabCommentsMap(doc);
      // Read what is already in the map, not just what changes next: the file
      // only enters the catalog when the first comment is written, so a peer
      // cannot attach until after that comment exists — and an observer never
      // reports it. Merge rather than replace, since local comments may not
      // have reached the map yet.
      const apply = () => setEditorComments((current) => mergeEditorComments(readCollabComments(doc), current));
      apply();
      const onMap = () => apply();
      map.observe(onMap);
      detach = () => map.unobserve(onMap);
    }).catch(() => undefined);
    return () => { cancelled = true; detach?.(); };
  }, [activeCollabVersion, collabFileCount, collabSession]);

  /** An Overleaf thread's id, when this comment is one of theirs. */
  const overleafThreadOf = useCallback((commentId: string) => (
    commentId.startsWith(OVERLEAF_COMMENT_PREFIX)
      ? commentId.slice(OVERLEAF_COMMENT_PREFIX.length)
      : null
  ), []);

  const toggleEditorCommentResolved = useCallback((id: string) => {
    const threadId = overleafThreadOf(id);
    if (threadId) {
      const thread = overleafCommentsRef.current.threads.find((item) => item.id === threadId);
      void overleafCommentsRef.current
        .setResolved(threadId, !thread?.resolved)
        .catch((reason) => setError(toMessage(reason)));
      return;
    }
    void persistEditorComments(editorComments.map((item) => (
      item.id === id
        ? { ...item, resolved: !item.resolved, updatedAt: new Date().toISOString() }
        : item
    )));
    // `overleafCommentsRef` reaches this through the workspace hook's return
    // value, so the lint rule cannot see it is a stable `useRef` identity.
  }, [editorComments, overleafCommentsRef, overleafThreadOf, persistEditorComments]);

  const replyToEditorComment = useCallback((commentId: string, body: string) => {
    const threadId = overleafThreadOf(commentId);
    if (threadId) {
      void overleafCommentsRef.current
        .reply(threadId, body)
        .catch((reason) => setError(toMessage(reason)));
      return;
    }
    const reply = createEditorCommentReply({
      body,
      authorId: editorCommentAuthorId,
      authorName: collabName.trim() || "Anonymous",
    });
    if (!reply) return;
    void persistEditorComments(editorComments.map((item) => (
      item.id === commentId
        ? { ...item, replies: [...item.replies, reply], updatedAt: new Date().toISOString() }
        : item
    )));
  }, [collabName, editorCommentAuthorId, editorComments, overleafCommentsRef, overleafThreadOf, persistEditorComments]);

  const openEditorComments = useCallback(() => {
    setCommentPanelFocus(null);
    if (overleafLink) {
      setEditorCommentsOpen(false);
      setOverleafCollabTab("comments");
      setOverleafCollabOpen(true);
    } else {
      setEditorCommentsOpen(true);
    }
  }, [overleafLink, setOverleafCollabOpen, setOverleafCollabTab]);

  const openEditorCommentReply = useCallback((commentId: string) => {
    openEditorComments();
    if (project) setCommentPanelFocus({ id: commentId, projectRoot: project.root, nonce: crypto.randomUUID() });
  }, [openEditorComments, project]);

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
        onOpenInBrowser={async () => {
          if (!await startProjectTransition()) {
            throw new Error(t`Save the current workspace before opening it in a browser.`);
          }
          try {
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
          } catch (reason) {
            cancelProjectTransition();
            throw reason;
          }
        }}
        onReturnToDesktop={async () => {
          if (!await startProjectTransition()) {
            throw new Error(t`Save the current workspace before opening it in the desktop app.`);
          }
          try {
            await invoke("return_to_desktop");
            setSettingsOpen(false);
          } catch (reason) {
            cancelProjectTransition();
            throw reason;
          }
        }}
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
          void openClonedOverleafProject(root);
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
  const quickOpenPaths = useMemo(
    () => (project ? collectQuickOpenPaths(project.files) : []),
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
    const uniqueMissing = missing.filter((path, index) => missing.indexOf(path) === index);
    if (!uniqueMissing.length) return;
    void Promise.all(uniqueMissing.map(async (path) => {
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
  const goToSymbolItems = useMemo((): SearchPickerItem[] => {
    const sections = flattenOutline(outlineNodes)
      .filter((node) => node.kind !== "input")
      .map((node) => ({
        id: `section:${node.id}`,
        label: node.title,
        detail: `${node.path || activeFile}:${node.line}`,
        group: "Section",
      }));
    const labels = liveReferences.map((reference) => ({
      id: `label:${reference.path}:${reference.label}`,
      label: reference.label,
      detail: `${reference.path}:${reference.line}${reference.title && reference.title !== reference.label ? ` · ${reference.title}` : ""}`,
      group: "Label",
    }));
    return [...sections, ...labels];
  }, [activeFile, liveReferences, outlineNodes]);
  const citePickerItems = useMemo((): SearchPickerItem[] => (
    (citations.length
      ? citations.map((citation) => ({
        id: `cite:${citation.key}`,
        label: citation.key,
        detail: [citation.title, citation.authors, citation.year].filter(Boolean).join(" · "),
        group: "Citation",
      }))
      : citationKeys.map((key) => ({
        id: `cite:${key}`,
        label: key,
        group: "Citation",
      })))
  ), [citationKeys, citations]);
  const refPickerItems = useMemo((): SearchPickerItem[] => (
    liveReferences.map((reference) => ({
      id: `ref:${reference.path}:${reference.label}`,
      label: reference.label,
      detail: `${reference.path}:${reference.line}`,
      group: "Reference",
    }))
  ), [liveReferences]);
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
    } else if (projectAssetPaths.has(path)) {
      if (
        (canvasMode === "dual" || canvasMode === "columns")
        && secondaryAsset?.path === path
      ) {
        setFocusedPane("secondary");
        return;
      }
      void openProjectAsset(path);
    } else {
      if (
        (canvasMode === "dual" || canvasMode === "columns")
        && secondaryFile === path
      ) {
        setFocusedPane("secondary");
        return;
      }
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
  const editorTabItems = useMemo(
    () => openTabs.map((path) => {
      if (isPaperTabKey(path)) {
        const id = arxivIdFromTabKey(path);
        return {
          path,
          pinned: pinnedTabs.includes(path),
          kind: "paper" as const,
          label: papers.find((paper) => paper.arxivId === id)?.title ?? "Paper",
          dirty: activePaper?.arxivId === id && activePaperDirty,
          beside: activePaper?.arxivId === id
            && (canvasMode === "dual" || canvasMode === "columns"),
        };
      }
      if (projectAssetPaths.has(path)) {
        return {
          path,
          pinned: pinnedTabs.includes(path),
          kind: "asset" as const,
          beside: path === secondaryAsset?.path
            && (canvasMode === "dual" || canvasMode === "columns"),
        };
      }
      return {
        path,
        pinned: pinnedTabs.includes(path),
        kind: "file" as const,
        dirty: (path === activeFile && primarySourceDirty)
          || (path === secondaryFile && secondarySourceDirty),
        beside: (path === secondaryFile || path === secondaryAsset?.path)
          && (canvasMode === "dual" || canvasMode === "columns"),
      };
    }),
    [
      activeFile,
      activePaper?.arxivId,
      activePaperDirty,
      canvasMode,
      openTabs,
      papers,
      pinnedTabs,
      primarySourceDirty,
      projectAssetPaths,
      secondaryFile,
      secondaryAsset?.path,
      secondarySourceDirty,
    ],
  );
  useLayoutEffect(() => {
    fitSidebarToContent();
  }, [canvasMode, editorTabItems.length, fitSidebarToContent]);
  // The tab that reads as active: the open paper in paper mode, else the focused
  // editor pane. Also the key eviction must never close.
  const activeTabKey = activePaper
    ? (canvasMode === "dual" || canvasMode === "columns") && focusedPane === "secondary"
      ? secondaryAsset?.path ?? secondaryFile ?? paperTabKey(activePaper.arxivId)
      : paperTabKey(activePaper.arxivId)
    : (canvasMode === "dual" || canvasMode === "columns")
      ? focusedPane === "secondary"
        ? secondaryAsset?.path ?? secondaryFile ?? activeAsset?.path ?? activeFile
        : activeAsset?.path ?? activeFile
      : activeAsset?.path ?? activeFile;
  // Whatever is on screen is the most-recently-used tab; the split's other pane
  // counts too. Tracking recency here covers every path that opens a tab.
  useEffect(() => {
    if (activeTabKey) noteTabActive(activeTabKey);
  }, [activeTabKey, noteTabActive]);
  useEffect(() => {
    if (secondaryFile && (canvasMode === "dual" || canvasMode === "columns")) {
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
  const graphicsRoots = useMemo(
    () => parseGraphicsPaths(liveMacroSources),
    [liveMacroSources],
  );
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
    void invoke<{ page: number } | null>("synctex_view", {
      path: appendixMarkerPath,
      line: appendixMarkerLine,
      column: 0,
    })
      .then((target) => {
        if (!cancelled) setMainBodyPages(target ? Math.max(0, target.page - 1) : null);
      })
      .catch(() => {
        if (!cancelled) setMainBodyPages(null);
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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F8") {
        event.preventDefault();
        cycleDiagnostic(event.shiftKey ? -1 : 1);
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.altKey) return;
      if (event.key === "[" && !event.shiftKey) {
        event.preventDefault();
        void navigateHistory(-1);
        return;
      }
      if (event.key === "]" && !event.shiftKey) {
        event.preventDefault();
        void navigateHistory(1);
        return;
      }
      if (event.key.toLocaleLowerCase() === "p" && !event.shiftKey) {
        event.preventDefault();
        setQuickOpenOpen(true);
      }
      if (event.key.toLocaleLowerCase() === "p" && event.shiftKey) {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
      if (event.key.toLocaleLowerCase() === "o" && event.shiftKey) {
        event.preventDefault();
        setGoToSymbolOpen(true);
      }
      if (event.key.toLocaleLowerCase() === "g" && !event.shiftKey) {
        event.preventDefault();
        setGotoLineOpen(true);
      }
      if (event.key.toLocaleLowerCase() === "j" && event.shiftKey) {
        event.preventDefault();
        void revealSourceInPdf();
      }
      if (event.key.toLocaleLowerCase() === "t" && event.shiftKey) {
        event.preventDefault();
        void reopenClosedTab();
      }
      if (event.key.toLocaleLowerCase() === "k" && event.shiftKey) {
        event.preventDefault();
        setRefCitePicker("cite");
      }
      if (event.key.toLocaleLowerCase() === "l" && event.shiftKey) {
        event.preventDefault();
        setRefCitePicker("ref");
      }
      if (event.key.toLocaleLowerCase() === "i" && event.shiftKey) {
        if (!canInsert) return;
        event.preventDefault();
        setInsertOpen(true);
      }
      if (event.key.toLocaleLowerCase() === "h" && event.shiftKey) {
        event.preventDefault();
        openProjectReplace();
      }
      if (event.key.toLocaleLowerCase() === "f" && event.shiftKey) {
        event.preventDefault();
        openProjectFind();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canInsert, cycleDiagnostic, navigateHistory, openProjectFind, openProjectReplace, reopenClosedTab, revealSourceInPdf]);

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
        abortBuild={abortBuild}
        activeTabKey={activeTabKey}
        build={build}
        building={building}
        buildPreferences={buildPreferences}
        busyLabel={busyLabel}
        canvasMode={canvasMode}
        canvasToolbar={(
        <CanvasToolbar
          onPaperLookup={() => setPaperLookupRequest((request) => request + 1)}
          mode={canvasMode}
          selectedDocumentViewMode={focusedPanePreview ? "pdf" : undefined}
          setMode={openDocumentMode}
          supportsDocumentViewModes={paperFocused
            || (!focusedAsset && isPreviewableSourceFilePath(focusedDocumentPath))}
          onSplit={
            !isOpenSlideDeckPath(focusedDocumentPath)
            && !paperFocused
            && (
              (Boolean(activeAsset) && canvasMode === "asset")
              || (
                !activeAsset
                && (
                  canvasMode === "source"
                  || (canvasMode === "pdf" && isPreviewableSourceFilePath(activeFile))
                )
              )
            )
              ? splitDocumentView
              : undefined
          }
          onCloseSplit={canvasMode === "dual" || canvasMode === "columns"
            ? closeSplitView
            : undefined}
          markdown={paperFocused
            || (!focusedAsset
              && focusedDocumentPath.toLocaleLowerCase().endsWith(".md"))}
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
          dirty={paperFocused
            ? activePaperDirty
            : focusedPane === "secondary"
              ? secondarySourceDirty
              : source !== savedSource}
          onInsert={() => setInsertOpen(true)}
          onCollab={() => {
            // The tour points this row out rather than opening it, so the
            // panels stay shut while it runs.
            if (tutorialActive) return;
            openCollabDialog("start");
          }}
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
          onGit={() => {
            if (tutorialActive) return;
            synara.requestRuntime();
            setGitOpen(true);
          }}
          commentCount={allEditorComments.filter((comment) => !comment.resolved).length}
          onComments={openEditorComments}
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
          onOverleafSync={() => {
            if (tutorialActive) return;
            // Manual mode is a review step, not a button that quietly
            // rewrites files: show what would change and let the user decide.
            if (overleafSyncMode === "manual") setOverleafReviewOpen(true);
            else void runOverleafSync();
          }}
          onOverleafOpenCurrent={overleafLink ? () => {
            if (tutorialActive) return;
            openCurrentOverleafProject();
          } : undefined}
          onOverleafOpen={() => {
            if (tutorialActive) return;
            setOverleafPickerOpen(true);
          }}
          overleafUnreadChat={
            overleafChat.unread + overleafComments.threads.filter((thread) => !thread.resolved).length + overleafRealtime.changes.length
            + editorComments.filter((comment) => !comment.resolved).length
          }
          onOverleafChat={() => {
            openEditorComments();
            void overleafChat.refresh();
          }}
        />
        )}
        chooseExisting={chooseExisting}
        chooseRecentProject={chooseRecentProject}
        cleanAndRebuild={cleanAndRebuild}
        cleaning={cleaning}
        compile={compile}
        dropProjectPath={dropProjectPath}
        editorTabItems={editorTabItems}
        exportProjectZip={exportProjectZip}
        importing={referenceImport.importing}
        openSettings={openSettings}
        openTutorialProject={openTutorialProject}
        project={project}
        projectMenuOpen={projectMenuOpen}
        recentProjects={recentProjects}
        requestCloseEditorTab={requestCloseEditorTab}
        setEditorTabPinned={setEditorTabPinned}
        selectEditorTab={selectEditorTab}
        onNewProject={() => updateCreateForm({ open: true })}
        setOpenTabs={setOpenTabs}
        setOverleafPickerOpen={setOverleafPickerOpen}
        setProjectMenuOpen={setProjectMenuOpen}
        setSidebarOpen={setSidebarOpen}
        sidebarOpen={sidebarOpen}
        sidebarResizing={sidebarResizing}
        sidebarWidth={sidebarWidth}
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
            agentDocked={agentDocked}
            agentVisible={agentVisible}
            onDockAgent={() => {
              setAgentDocked(true);
              setSidebarMode("project");
              setSidebarOpen(false);
            }}
            onCloseAgentDock={() => setAgentDocked(false)}
            agentPanelDropActive={agentPanelDropActive}
            appLocale={appLocale}
            beginSidebarResize={beginSidebarResize}
            changeSynaraPermissionMode={synara.changePermissionMode}
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
              onPaper={(paper) => void openPaper(paper).then((opened) => {
                if (
                  tutorialActive
                  && tutorialStep === TUTORIAL_STEPS.importVit
                  && paper.arxivId === "2010.11929"
                ) {
                  if (opened?.hasBlog) changePaperView("blog");
                  setTutorialStep(opened?.hasBlog ? TUTORIAL_STEPS.paperBlog : TUTORIAL_STEPS.paperFullText);
                }
              })}
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
            nudgeSidebar={nudgeSidebar}
            openBibEntryDialog={referenceImport.openBibEntry}
            project={project}
            retrySynaraRuntime={synara.retry}
            setBoardCreateRequest={setBoardCreateRequest}
            setLiteratureOpen={referenceImport.setLiteratureOpen}
            openProjectFind={projectSearch.openFind}
            setProjectSearchOpen={setProjectSearchOpen}
            setPresentationCreateRequest={setPresentationCreateRequest}
            setSpreadsheetCreateRequest={setSpreadsheetCreateRequest}
            sidebarMode={sidebarMode}
            sidebarModeActionsRef={sidebar.sidebarModeActionsRef}
            sidebarModeHeaderRef={sidebar.sidebarModeHeaderRef}
            sidebarModeTier={sidebar.sidebarModeTier}
            sidebarWidth={sidebarWidth}
            sidebarOpen={sidebarOpen}
            sidebarResizing={sidebarResizing}
            onCollapseSidebar={() => setSidebarOpen(false)}
            synaraAutoModeAvailable={synara.autoModeAvailable}
            synaraFrameMounted={synara.frameMounted}
            synaraFrameReady={synara.frameReady}
            synaraIframeRef={synara.frameRef}
            synaraOrigin={synara.origin}
            synaraPermissionMode={synara.permissionMode}
            synaraRuntime={synara.runtime}
            theme={theme}
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
              if (canvasMode === "dual" || canvasMode === "columns") {
                openDocumentMode("source");
              } else {
                setCanvasMode("split");
              }
            }}
            onOpenSlideMutation={applyOpenSlideMutation}
            onOpenSlideContext={setOpenSlideContext}
            onOpenSlideError={setError}
            pdfUrl={pdfUrl}
            pdfBase64={null}
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
            canOpenCitation={(key) => papers.some((item) => item.citationKey?.toLocaleLowerCase() === key.toLocaleLowerCase()
              && (item.hasFullText || item.hasBlog))
              || Boolean(citationSourceUrl(citations.find((item) => item.key.toLocaleLowerCase() === key.toLocaleLowerCase())))}
            onOpenCitation={(key) => {
              const paper = papers.find((item) => item.citationKey?.toLocaleLowerCase() === key.toLocaleLowerCase()
                && (item.hasFullText || item.hasBlog));
              if (paper) void openPaper(paper);
              else {
                const url = citationSourceUrl(citations.find((item) => item.key.toLocaleLowerCase() === key.toLocaleLowerCase()));
                if (url) void openUrl(url).catch((reason) => setError(toMessage(reason)));
              }
            }}
            citationKeys={citationKeys}
            citations={citations}
            references={liveReferences}
            unusedLabels={texlabActive ? [] : unusedSymbols.labels}
            unusedCitations={texlabActive ? [] : unusedSymbols.citations}
            onLoadReferenceImage={loadReferenceImage}
            referenceImageGeneration={referencePreviewGeneration}
            onEditorLeave={saveWhenLeavingEditor}
            onPrepareFigure={prepareLatexFigure}
            onPasteImageFile={handlePasteImageFile}
            nativeFigureDropActive={nativeEditorDropActive}
            fileDropTargetPane={fileDropTargetPane}
            figurePointerPosition={figurePointerDrag?.insertAtEditor ? {
              x: figurePointerDrag.clientX,
              y: figurePointerDrag.clientY,
            } : null}
            figureDropRequest={figureDropRequest}
            onFigureDropHandled={handleFigureDropHandled}
            editorNavigation={editorNavigation}
            onEditorNavigationHandled={handleEditorNavigationHandled}
            onEditorPosition={handleEditorPosition}
            onCompletionActiveChange={handleCompletionActiveChange}
            onViewState={(path, state) => rememberFileViewState(path, { text: state })}
            getFileViewState={getFileViewState}
            onFileViewState={rememberFileViewState}
            viewRestore={viewRestore}
            onViewRestoreHandled={(id) => setViewRestore((current) => current?.id === id ? null : current)}
            onGotoDefinition={(target) => void gotoDefinition(target)}
            onTexlabGoto={(path, line) => { void openProjectFile(path, line); }}
            onFindReferences={(target) => void findSymbolReferences(target)}
            onRenameSymbol={beginSymbolRename}
            onRenameEnvironment={(name) => {
              setRenameError(null);
              setRenameTarget({ kind: "environment", name });
            }}
            onWrapEnvironment={() => {
              setRenameError(null);
              setRenameTarget({ kind: "wrap-environment" });
            }}
            envRenameRequest={envRenameRequest}
            onEnvRenameHandled={(id) => setEnvRenameRequest((current) => current?.id === id ? null : current)}
            wrapEnvRequest={wrapEnvRequest}
            onWrapEnvHandled={(id) => setWrapEnvRequest((current) => current?.id === id ? null : current)}
            localMacros={liveMacros}
            katexMacros={katexMacros}
            onGotoLineRequest={() => setGotoLineOpen(true)}
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
            citeInsertRequest={citeInsertRequest}
            onCiteInsertHandled={(id) => setCiteInsertRequest((current) => current?.id === id ? null : current)}
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
            editorComments={allEditorComments}
            overleafPresenceCursors={overleafActiveCursors}
            overleafChanges={overleafRealtime.changes}
            overleafTrackChangeActions={{
              authorName: overleafTrackChanges.authorName,
              canAct: () => overleafRealtime.canWrite,
              onAccept: (change) => void overleafTrackChanges.accept([change.id]),
              onReject: (change) => void overleafTrackChanges.reject([change]),
            }}
            activeEditorCommentId={activeEditorCommentId}
            commentAuthorName={collabName.trim() || "Anonymous"}
            commentAuthorId={editorCommentAuthorId}
            onCreateEditorComment={(comment) => {
              // A document being edited live with Overleaf gets Overleaf's
              // comments, so the person in the browser sees what you wrote.
              // Anything else keeps this project's own.
              const commentDocId = Array.from(overleafDocPaths.entries())
                .find(([, path]) => path === comment.path)?.[0] ?? null;
              if (overleafLink && commentDocId) {
                if (!overleafRealtime.liveFile || overleafRealtime.docId !== commentDocId) {
                  setError("This file is not live with Overleaf right now. Reconnect before commenting.");
                  return;
                }
                const target = {
                  projectRoot: project.root,
                  docId: commentDocId,
                  path: comment.path,
                };
                void overleafComments
                  .create(target, comment.from, comment.quote, comment.body)
                  .catch((reason) => setError(toMessage(reason)));
                return;
              }
              void persistEditorComments([...editorComments, comment]);
              setActiveEditorCommentId(comment.id);
            }}
            onOpenEditorComments={openEditorComments}
            onResolveEditorComment={toggleEditorCommentResolved}
            onReplyEditorComment={openEditorCommentReply}
            commentFocusRequest={commentFocusRequest}
            onCommentFocusHandled={(nonce) => {
              setCommentFocusRequest((current) => (current?.nonce === nonce ? null : current));
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
              activePaper && canvasMode !== "dual" && canvasMode !== "columns"
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
            primaryOpenSlideExternallyRendered
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
        activeFile={activeFile}
        agentTurnReview={agentTurnReview}
        appLocale={appLocale}
        compile={compile}
        deleteHistory={deleteHistory}
        gitOpen={gitOpen}
        gitRemoteUrl={projectGit.gitRemoteUrl}
        gitWorkspaceView={gitWorkspaceView}
        historyOpen={historyOpen}
        loadFile={loadFile}
        openProjectFile={openProjectFile}
        overleafLink={overleafLink}
        project={project}
        projectHistory={projectHistory}
        refreshHistory={refreshHistory}
        refreshProject={refreshProject}
        retrySynaraRuntime={synara.retry}
        revert={revert}
        runOverleafSync={runOverleafSync}
        setAgentTurnReview={setAgentTurnReview}
        setGitOpen={setGitOpen}
        setGitWorkspaceView={setGitWorkspaceView}
        setHistoryOpen={setHistoryOpen}
        synaraIframeRef={synara.frameRef}
        synaraOrigin={synara.origin}
        synaraRuntime={synara.runtime}
        synaraSourceControlFrameRef={synara.sourceControlFrameRef}
        theme={theme}
      />

      <AppEditorPanels
        renderCommentsSurface={overleafLink ? (localComments) => (
          <AppOverleafCollabDrawer
            key={`${project.root}:${commentPanelFocusId ? commentPanelFocus?.nonce : "comments"}`}
            localComments={localComments}
            localCommentCount={editorComments.filter((comment) => !comment.resolved).length}
            hasLocalComments={editorComments.length > 0}
            focusLocalComments={!!commentPanelFocusId && !overleafThreadOf(commentPanelFocusId)}
            focusThreadId={commentPanelFocusId ? overleafThreadOf(commentPanelFocusId) : null}
            activeFileRef={activeFileRef}
            openProjectFile={openProjectFile}
            overleaf={overleaf}
            onClose={() => {
              setOverleafCollabOpen(false);
              setCommentPanelFocus(null);
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
        commentOpenGenerationRef={commentOpenGenerationRef}
        commentPanelFocusId={commentPanelFocusId}
        commentPanelFocusNonce={commentPanelFocusId ? commentPanelFocus?.nonce : undefined}
        editorCommentAuthorId={editorCommentAuthorId}
        editorComments={editorComments}
        editorCommentsOpen={editorCommentsOpen}
        mainBodyPages={mainBodyPages}
        openProjectFile={openProjectFile}
        onCloseComments={() => {
          setEditorCommentsOpen(false);
          setOverleafCollabOpen(false);
          setCommentPanelFocus(null);
        }}
        pdfPageCount={pdfPageCount}
        persistEditorComments={persistEditorComments}
        project={project}
        projectWordCount={projectWordCount}
        refreshTodos={refreshTodos}
        replyToEditorComment={replyToEditorComment}
        setActiveEditorCommentId={setActiveEditorCommentId}
        setChecklistOpen={setChecklistOpen}
        setCommentFocusRequest={setCommentFocusRequest}
        setProject={setProject}
        setTodosOpen={setTodosOpen}
        todoHits={todoHits}
        todosOpen={todosOpen}
        toggleEditorCommentResolved={toggleEditorCommentResolved}
        unusedSymbols={unusedSymbols}
      />

      <AppSearchDialogs
        activeFile={activeFile}
        citePickerItems={citePickerItems}
        editorPosition={editorPosition}
        gotoLineOpen={gotoLineOpen}
        goToSymbolItems={goToSymbolItems}
        goToSymbolOpen={goToSymbolOpen}
        liveReferences={liveReferences}
        openProjectAsset={openProjectAsset}
        openProjectFile={openProjectFile}
        outlineNodes={outlineNodes}
        prewarmLikelyProjectFile={prewarmLikelyProjectFile}
        quickOpenOpen={quickOpenOpen}
        quickOpenPaths={quickOpenPaths}
        refCitePicker={refCitePicker}
        refPickerItems={refPickerItems}
        setCanvasMode={setCanvasMode}
        setCiteInsertRequest={setCiteInsertRequest}
        setEditorNavigation={setEditorNavigation}
        setGotoLineOpen={setGotoLineOpen}
        setGoToSymbolOpen={setGoToSymbolOpen}
        setQuickOpenOpen={setQuickOpenOpen}
        setRefCitePicker={setRefCitePicker}
        source={source}
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

      {/* The command palette stays here rather than in a component of its own.
          It is a dispatch table over every action App owns — the same table the
          global keydown handler above drives — so its interface is the whole
          app: 49 of App's values, only 18 of which no other surface needs.
          Behind a props interface that is 150 lines of plumbing for no seam. */}
      <SearchPickerDialog
        open={commandPaletteOpen}
        title={t`Command palette`}
        placeholder={t`Run a command…`}
        items={[
          { id: "build", label: t`Build project`, detail: t`Compile LaTeX`, group: t`Build` },
          { id: "rebuild", label: t`Clean rebuild`, detail: t`latexmk -c then -g`, group: t`Build` },
          { id: "clean", label: t`Clean aux files`, group: t`Build` },
          { id: "stop-build", label: t`Stop build`, group: t`Build` },
          { id: "sync-pdf", label: t`Jump to PDF`, detail: "⌘⇧J", group: t`Navigate` },
          { id: "quick-open", label: t`Quick open file`, detail: "⌘P", group: t`Navigate` },
          { id: "goto-line", label: t`Go to line`, detail: "⌘G", group: t`Navigate` },
          { id: "goto-symbol", label: t`Go to symbol`, detail: "⌘⇧O", group: t`Navigate` },
          ...(!activePaper && !activeAsset && canvasMode === "source"
            ? [{ id: "view-dual", label: t`Dual source view`, detail: t`Two files side by side`, group: t`View` }]
            : []),
          { id: "view-split", label: t`Source + PDF`, detail: t`split`, group: t`View` },
          ...(canvasMode === "dual" && secondaryFile
            ? [{ id: "swap-panes", label: t`Swap editor panes`, detail: `${activeFile} ↔ ${secondaryFile}`, group: t`View` }]
            : []),
          ...(canInsert
            ? [{ id: "insert", label: t`Insert snippet`, detail: "⌘⇧I", group: t`Edit` }]
            : []),
          ...(isCollabEnabled() ? [{
            id: "collab",
            label: collabSession ? t`Live sharing…` : t`Start / join live sharing`,
            detail: collabSession
              ? t({ message: `${collabPeers} connected · ${collabSession.room}` })
              : t`Share invite with a collaborator`,
            group: t`Edit`,
          }] : []),
          { id: "table", label: t`Insert table`, detail: t`Grid generator`, group: t`Edit` },
          { id: "cite", label: t`Insert citation`, detail: "⌘⇧K", group: t`Edit` },
          { id: "ref", label: t`Insert reference`, detail: "⌘⇧L", group: t`Edit` },
          { id: "bib", label: t`Add bibliography entry`, group: t`Edit` },
          { id: "discover", label: t`Discover literature`, detail: t`OpenAlex search`, group: t`Research` },
          { id: "find", label: t`Find in project`, detail: t`⌘⇧F · source files and papers`, group: t`Edit` },
          { id: "replace", label: t`Replace in project`, detail: t`⌘⇧H · all .tex files`, group: t`Edit` },
          {
            id: "todos",
            label: t`Manuscript TODOs`,
            detail: t({ message: `${todoHits.length || t`No`} markers` }),
            group: t`Edit`,
          },
          { id: "checklist", label: t`Submission checklist`, detail: t`Words / pages / TODOs`, group: t`Edit` },
          { id: "paste-image", label: t`Paste clipboard image as figure`, group: t`Edit` },
          { id: "format", label: t`Format document`, detail: "latexindent", group: t`Edit` },
          { id: "history", label: t`Open project history`, group: t`Project` },
          { id: "export-zip", label: t`Export project ZIP`, detail: t`Overleaf / arXiv source pack`, group: t`Project` },
          { id: "tutorial", label: t`Open guided tutorial`, detail: t`Learn Lattice with the Understanding Attention sample project`, group: t`Project` },
          { id: "doctor", label: t`Run TeX doctor`, group: t`Project` },
          { id: "settings", label: t`Open settings`, group: t`Project` },
        ]}
        onClose={() => setCommandPaletteOpen(false)}
        onSelect={(item) => {
          setCommandPaletteOpen(false);
          switch (item.id) {
            case "build": void compile(false, true); break;
            case "rebuild": void cleanAndRebuild(); break;
            case "clean": void cleanProject(); break;
            case "stop-build": void abortBuild(); break;
            case "sync-pdf": void revealSourceInPdf(); break;
            case "quick-open": setQuickOpenOpen(true); break;
            case "goto-line": setGotoLineOpen(true); break;
            case "goto-symbol": setGoToSymbolOpen(true); break;
            case "view-dual":
              if (!activePaper && !activeAsset && canvasMode === "source") openDocumentMode("dual");
              break;
            case "view-split": openDocumentMode("split"); break;
            case "swap-panes":
              if (canvasMode === "dual" && secondaryFile) void swapEditorPanes();
              break;
            case "insert": setInsertOpen(true); break;
            case "collab": openCollabDialog(); break;
            case "table": setTableGeneratorOpen(true); break;
            case "cite": setRefCitePicker("cite"); break;
            case "ref": setRefCitePicker("ref"); break;
            case "bib": referenceImport.openBibEntry(); break;
            case "discover": referenceImport.setLiteratureOpen(true); break;
            case "find": projectSearch.openFind(); break;
            case "replace": projectSearch.openReplace(); break;
            case "todos":
              void refreshTodos();
              setTodosOpen(true);
              break;
            case "checklist":
              void refreshTodos();
              void refreshWordCount();
              setChecklistOpen(true);
              break;
            case "paste-image": void pasteClipboardImage(); break;
            case "format": {
              const path = focusedPane === "secondary" && secondaryFile ? secondaryFile : activeFile;
              const text = focusedPane === "secondary" && secondaryFile ? secondarySource : source;
              if (!path.endsWith(".tex")) {
                setError("Open a .tex file before formatting.", "Format");
                break;
              }
              const trace = logAction("Format", "Format document", path);
              void import("./build/texlab-language")
                .then(({ formatLatexDocument }) => formatLatexDocument(path, text))
                .then((formatted) => {
                  if (formatted === text) {
                    trace.ok("Document is already formatted.");
                    return;
                  }
                  if (focusedPane === "secondary" && secondaryFile) setSecondarySource(formatted);
                  else setSource(formatted);
                  trace.ok("Formatted with latexindent.");
                })
                .catch((reason) => trace.fail(reason));
              break;
            }
            case "history": setHistoryOpen(true); break;
            case "export-zip": void exportProjectZip(); break;
            case "tutorial": void openTutorialProject(); break;
            case "doctor": openSettings("doctor"); break;
            case "settings": openSettings("appearance"); break;
            default: break;
          }
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
