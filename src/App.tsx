import { Suspense, lazy, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Image } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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
import { appendBibEntry, formatBibEntry, type BibEntryDraft } from "./papers/bib-entry";
import { type ResolvedCitationDraft } from "./papers/bib-entry-dialog";
import { clipboardImageFileName, fileToBase64, rgbaImageToPngBase64 } from "./editor/insert/clipboard-image";
import { SearchPickerDialog, type SearchPickerItem } from "./components/ui/search-picker-dialog";
import { MarkdownWorkspaceIndex } from "./editor/markdown/markdown-workspace-index";
import { parsePaperLinkPath } from "./papers/paper-link";
import { PAPER_IMPORT_PROGRESS_EVENT, paperImportStageLabel } from "./papers/paper-import-progress";
import { TexSetupWizard } from "./build/tex-setup-wizard";
import {
  isMissingTexBuildError,
  isRequiredSetupMissing,
} from "./build/tex-setup";
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
import { isBrowserHosted } from "./platform/browser-runtime";
import { configureInterfaceSounds, playInterfaceSound } from "./telemetry/interface-sounds";
import { usePanelLayout } from "./app/use-panel-layout";
import { resolveSidebarModeTier, type SidebarModeTier } from "./app/sidebar-mode-layout";
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
import { AppCollabDialog, AppOverleafCollabDrawer, CollabDialog } from "./app/app-collab-surfaces";
import { AppEditorPanels } from "./app/app-editor-panels";
import { AppHistoryDrawers } from "./app/app-history-drawers";
import { AppOnboardingTour } from "./app/app-onboarding-tour";
import { AppProjectDialogs } from "./app/app-project-dialogs";
import { AppProjectSearchDialogs, AppSearchDialogs } from "./app/app-search-dialogs";
import { AppTitlebar } from "./app/app-titlebar";
import { AppWorkspaceSidebar } from "./app/app-workspace-sidebar";
import { CanvasToolbar } from "./canvas/canvas-toolbar";
import { AvatarGroup } from "./components/ui/avatar-group";
import { InfinityLoader } from "./components/ui/activity-icons";
import { OverleafPresenceAvatars } from "./overleaf/overleaf-presence";
import { ReferencesPanel, type SymbolOccurrence } from "./project/references-panel";
import {
  isSynaraPermissionMode,
  type AgentTurnReview,
  type SynaraPermissionMode,
} from "./app/app-synara-embed";
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
  loadFileViewStates,
  persistFileViewStates,
  loadWorkspaceLayout,
  persistWorkspaceLayout,
  persistOverleafRemoteDelete,
  persistOverleafSyncMode,
  LOCAL_SEMANTIC_SEARCH_KEY,
  loadLocalSemanticSearchEnabled,
  persistLocalSemanticSearchEnabled,
  hasSeenTutorial,
  markTutorialSeen,
  resolveAppLocale,
} from "./settings/app-settings";
import {
  type EditorComment,
} from "./editor/comments/editor-comment-data";
import {
  executeAgentCanvasToolRequest,
  parseAgentCanvasToolRequest,
} from "./agent/agent-canvas-tools";
import {
  executeAgentSpreadsheetToolRequest,
  parseAgentSpreadsheetToolRequest,
  registerAgentSpreadsheetDocumentResolver,
} from "./agent/agent-spreadsheet-tools";
import { isSpreadsheetPath } from "./editor/spreadsheet/spreadsheet-types";
import { seedSpreadsheetDoc, spreadsheetDocContent } from "./editor/spreadsheet/spreadsheet-yjs";
import {
  clearPreCollabProjectRoot,
  rememberPreCollabProjectRoot,
} from "./collab/collab-return";
import { pdfBytesFingerprint, pdfBytesToObjectUrl } from "./pdf/pdf-bytes";
import { rewriteMovedDocumentAssetPaths } from "./editor/insert/figure-insertion";
import {
  peerInitials,
  saveCollabDisplayName,
  peerCursorLocationV2,
  waitForPeerCursorLocationV2,
  type CollabPeer,
  type EditorCollabSession,
} from "./collab/collab-session";
import { collabCredentialStore } from "./collab/collab-credentials";
import { loadCollabFeaturePolicy } from "./collab/collab-feature-policy";
import { CollabControlErrorV2, CollabControlV2Client } from "./collab/collab-control-v2";
import { acceptCollabInvitationV2 } from "./collab/collab-join-v2";
import { CollabProjectControllerV2, type CollabMaterializeCallbacksV2 } from "./collab/collab-project-v2";
import { isClientDestroyedErrorV2 } from "./collab/collab-text-v2";
import { collabCommentsMap, readCollabComments, seedCollabCommentsFromContent, writeCollabComments } from "./collab/collab-comments";
import {
  mayApplyProjectRefreshV2,
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
  diagnosticsFingerprint,
  EMPTY_DIAGNOSTICS,
  flattenProjectPaths,
  missingTexDependencyFile,
  resolveDiagnosticPath,
  type CompileDiagnostic,
} from "./build/compile-diagnostics";
import { Welcome } from "./project/project-dialogs";
import { TUTORIAL_STEPS } from "./onboarding/onboarding-steps";
import {
  activeOutlineNode,
  flattenOutline,
  includedPathsIn,
  parseProjectOutline,
} from "./editor/latex/latex-outline";
import { type HistoryItem } from "./history/history-drawer";
import { katexMacrosFromSources } from "./editor/latex/katex-macros";
import {
  editorDropPreviewAt,
  EditorDropPreviewPortal,
  type EditorDropPreview,
  type EditorDropZone,
} from "./canvas/editor-tabs";
import { type ProjectFindHit } from "./project/project-find-dialog";
import {
  DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS,
  type LocalSemanticSearchStatus,
} from "./project/project-semantic-search";
import { type ReplacePreviewResult } from "./project/project-replace-dialog";
import { baseArxivId } from "./papers/arxiv-id";
import { type PdfSyncTarget } from "./pdf/pdf-viewer";
import { findAppendixMarker } from "./editor/latex/appendix-pages";
import { mergeTodosWithBuffer, type TodoHit } from "./project/todo-scavenger";
import { referenceAssetPreviewDataUrl } from "./project/reference-preview";
import type {
  ProjectVenue,
  ProjectManifest,
  WordCount,
  UnusedSymbols,
  FileViewState,
  NavigationEntry,
  ProjectSnapshot,
  FileNode,
  GitFileStatus,
  GitStatus,
  AssetPreview,
  FigureDropRequest,
  FigurePointerDrag,
  SyncTexTarget,
  EditorNavigation,
  EditorPosition,
  PdfSyncResponse,
  BuildResult,
  PaperSummary,
  RenameTarget,
  RenameSymbolResult,
  CanvasMode,
  EditorPaneId,
  DocumentViewMode,
  SettingsTab,
  InsertSymbolCommand,
  DoctorReport,
} from "./app-types";
import {
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
  isPreviewableSourceFilePath,
  isProjectAssetFilePath,
  isProjectSourceFilePath,
  isPaperTabKey,
  markdownFrontmatterEnd,
  paperKey,
  paperTabKey,
  projectItemPath,
  remapProjectPath,
  stripFrontmatter,
  toMessage,
  type ProjectPathChange,
} from "./app-utils";
import {
  LATTICE_AGENT_COMPILE_RESULT,
  parseAgentCompileResultMessage,
  parseAgentProjectHistorySnapshot,
  synaraProjectRelativeFilePath,
  type AgentGitWorkspaceView,
  type AgentCheckpointHistoryEntry,
  type AgentCompileResultMessage,
} from "./agent/synara-runtime";
import {
  buildAgentHostContext,
  LATTICE_HOST_CONTEXT_REQUEST,
  LATTICE_HOST_CONTEXT_SELECTION_CLEAR,
  selectedMarkdownImageProjectPath,
  type AgentHostContextSnapshot,
  type AgentHostSelectionImage,
  type AgentHostSurface,
} from "./agent/agent-host-context";
import {
  buildAgentPaperLibrary,
  LATTICE_PAPER_LIBRARY_REQUEST,
  type AgentPaperLibrarySnapshot,
} from "./agent/agent-paper-library";
import {
  buildAgentComposerFilesMessage,
  type AgentComposerFilePayload,
} from "./agent/agent-composer-files";
import { useSynaraRuntime } from "./agent/use-synara-runtime";
import { useSynaraNotificationBridge } from "./agent/synara-notifications";
import { useSynaraConfirmationBridge } from "./agent/synara-confirmations";
import { logAction, notifyError } from "./telemetry/app-notify";
// setError / setWarning / setNotice are the ~170-call-site toast shims; they
// live beside the hooks extracted out of this file so both can use them.
import { setError, setNotice, setWarning } from "./app/notify";
import { addAppLog } from "./telemetry/app-log-store";
import {
  APP_WINDOW_MIN_HEIGHT,
  minimumWindowWidth,
} from "./app/window-layout";
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
const CompileDiagnosticsPanel = lazy(() =>
  import("./build/compile-diagnostics-panel").then((module) => ({ default: module.CompileDiagnosticsPanel })),
);
const loadDocumentCanvas = () => import("./canvas/document-canvas");
const DocumentCanvas = lazy(() =>
  loadDocumentCanvas().then((module) => ({ default: module.DocumentCanvas })),
);

/** Shared empty word list: `?? []` in JSX rebuilds the editor's lint pass. */
const EMPTY_SPELLING_WORDS: string[] = [];
const loadCanvasPrewarm = () => import("./canvas/canvas-prewarm");

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

const LATTICE_AGENT_PERMISSION_MODE_REQUEST = "lattice:request-agent-permission-mode";
const LATTICE_AGENT_PERMISSION_MODE_SET = "lattice:set-agent-permission-mode";
const LATTICE_AGENT_PANEL_OPENED = "lattice:agent-panel-opened";
const LATTICE_HOST_POINTER = "lattice:host-pointer";
const SYNARA_AGENT_PERMISSION_MODE_STATUS = "synara:agent-permission-mode";
const SYNARA_LAYOUT_METRICS = "synara:layout-metrics";
const SYNARA_EMBED_READY = "synara:embed-ready";
const SYNARA_OPEN_SETTINGS = "synara:open-settings";
const SYNARA_OPEN_REVIEW = "synara:open-review";
const SYNARA_OPEN_FILE = "synara:open-file";
const SYNARA_SIDEBAR_MINIMUM = 310;
const SYNARA_SIDEBAR_MAXIMUM_MINIMUM = 720;
const TRAFFIC_LIGHT_OPTICAL_Y_OFFSET_CSS_PX = 0.25;

function isSynaraSettingsTab(tab: SettingsTab): boolean {
  return tab === "agent" || tab === "mcp" || tab === "api";
}

function collectAssetPaths(nodes: FileNode[], paths = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.kind === "figure" || node.contentKind === "binary" || node.contentKind === "symlink") paths.add(node.path);
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

function getCurrentWindowSafely() {
  try {
    return getCurrentWindow();
  } catch {
    // Browser previews, recovery pages, and a briefly unavailable Tauri
    // bridge should not replace the entire application with a white screen.
    return null;
  }
}

/** Let React commit an opening state and WebKit paint it before heavy sync work. */
function afterNextPaintOpportunity(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => window.setTimeout(resolve, 0));
  });
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

function allowRememberedFileViewPath(removedPaths: string[], path: string): string[] {
  return removedPaths.filter((removed) => (
    removed !== path && !path.startsWith(`${removed}/`)
  ));
}

function App() {
  const { t } = useLingui();
  const browserHosted = isBrowserHosted();
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const workspaceIndex = useMemo(
    () => new MarkdownWorkspaceIndex((path) => invoke<string>("read_project_file", { path })),
    [],
  );
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    const paths = flattenProjectPaths(project.files);
    const canvasModule = loadDocumentCanvas();

    // Chunk downloads can overlap the normal project setup without mounting
    // hidden previews or changing user-visible state. Idle-gated: firing the
    // burst immediately (visual editor + pdf viewer + worker can total ~4 MB)
    // competes with the first real editor mount for main-thread time.
    let moduleWarmIdle: number | null = null;
    let moduleWarmTimer: ReturnType<typeof setTimeout> | null = null;
    const warmModules = () => {
      // The canvas chunk is part of what this warms, so keep waiting on it even
      // though the prewarm helpers now live in their own module.
      void Promise.all([canvasModule, loadCanvasPrewarm()]).then(([, warm]) => {
        if (!cancelled) warm.prewarmProjectPreviewModules(paths);
      });
    };
    if ("requestIdleCallback" in window) {
      moduleWarmIdle = window.requestIdleCallback(warmModules, { timeout: 3_000 });
    } else {
      moduleWarmTimer = globalThis.setTimeout(warmModules, 300);
    }
    // Keep the lightweight search index warm, but do not parse every Markdown
    // file into ProseMirror in the background. A project with many papers can
    // otherwise spend hundreds of milliseconds in each "idle" callback while
    // the user is scrolling or trying to open a file.
    void workspaceIndex.update(project.files);
    return () => {
      cancelled = true;
      if (moduleWarmIdle != null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(moduleWarmIdle);
      }
      if (moduleWarmTimer != null) globalThis.clearTimeout(moduleWarmTimer);
    };
  }, [workspaceIndex, project]);
  const [tutorialActive, setTutorialActive] = useState(false);
  const [tutorialStep, setTutorialStep] = useState(0);
  const autoTutorialAttemptedRef = useRef(false);
  const [postStartupInteraction, setPostStartupInteraction] = useState(false);
  const projectRef = useRef<ProjectSnapshot | null>(project);
  // Incremented before any command that can replace the backend project root.
  // Long-running work captures this value so results from A cannot update B
  // during the short gap between the backend switch and React committing B.
  const projectOperationGenerationRef = useRef(0);
  const projectRefreshGenerationRef = useRef(0);
  const fileLoadGenerationRef = useRef(0);
  // Set as soon as a Paper intent reserves the primary surface, including the
  // network-fetch phase before openPaper starts. A later local-file intent in
  // the secondary pane can then cancel that pending whole-canvas replacement
  // instead of letting it unexpectedly collapse the user's split workspace.
  const paperLoadGenerationRef = useRef<number | null>(null);
  const secondaryFileLoadGenerationRef = useRef(0);
  const documentViewGenerationRef = useRef(0);
  const projectBeforeTransitionRef = useRef<ProjectSnapshot | null>(null);
  /**
   * Per-checkpoint file fingerprints from agent history snapshots. Snapshots
   * re-arrive on every thread update (and stream while a turn is still
   * editing), so a rebuild must only follow entries whose files actually
   * changed — and never the first snapshot of a thread, which replays history.
   */
  const agentCheckpointFingerprintsRef = useRef(new Map<string, string>());
  const agentHistoryPrimedThreadsRef = useRef(new Set<string>());
  const agentEditsBuildTimerRef = useRef<number | null>(null);
  const queuedAgentCompileBuildRef = useRef(false);
  const pendingAgentCompileResultsRef = useRef(new Map<string, {
    threadId: string; turnId: string; checkpointRef: string;
  }>());
  // null means no queued build; false/true retain the strongest pending intent.
  const queuedBuildForceRef = useRef<boolean | null>(null);
  // A manual request made during an automatic build still deserves one outcome
  // cue after the queued pass; automatic builds by themselves remain silent.
  const queuedBuildSoundRef = useRef(false);
  const resetAgentCompileTracking = useCallback((cancelQueuedBuild = false) => {
    agentCheckpointFingerprintsRef.current.clear();
    agentHistoryPrimedThreadsRef.current.clear();
    queuedAgentCompileBuildRef.current = false;
    pendingAgentCompileResultsRef.current.clear();
    if (cancelQueuedBuild) {
      queuedBuildForceRef.current = null;
      queuedBuildSoundRef.current = false;
    }
    if (agentEditsBuildTimerRef.current !== null) {
      window.clearTimeout(agentEditsBuildTimerRef.current);
      agentEditsBuildTimerRef.current = null;
    }
  }, []);
  const overleafSyncingRef = useRef(false);
  /** Resolves when the in-flight Overleaf sync has finished its disk refresh. */
  const overleafSyncSettledRef = useRef<Promise<void> | null>(null);
  const resolveOverleafSyncRef = useRef<(() => void) | null>(null);
  const visualMarkdownFlushRef = useRef<(() => boolean) | null>(null);
  const saveBeforeProjectTransitionRef = useRef<() => Promise<boolean>>(async () => true);
  const hasLateProjectTransitionEditRef = useRef<() => boolean>(() => false);
  const [primaryOpening, setPrimaryOpening] = useState<{
    generation: number;
    label: string;
  } | null>(null);
  const previewPrewarmRef = useRef<{
    generation: number;
    idle: number | null;
    timer: ReturnType<typeof setTimeout> | null;
    target: string | null;
    warmed: Set<string>;
    inFlight: Set<string>;
  }>({
    generation: 0,
    idle: null,
    timer: null,
    target: null,
    warmed: new Set(),
    inFlight: new Set(),
  });
  const cancelPreviewPrewarm = useCallback(() => {
    const state = previewPrewarmRef.current;
    state.generation += 1;
    state.target = null;
    if (state.timer != null) globalThis.clearTimeout(state.timer);
    state.timer = null;
    if (state.idle != null && "cancelIdleCallback" in window) window.cancelIdleCallback(state.idle);
    state.idle = null;
  }, []);
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
  const beginProjectTransition = useCallback((force = false) => {
    // Let sync finish its disk refresh before attempting a switch. Cancelling
    // only its UI phase after a failed switch could leave newly pulled bytes
    // hidden behind an old editor buffer that later overwrites them.
    if (overleafSyncingRef.current && !force) return false;
    if (projectRef.current) projectBeforeTransitionRef.current = projectRef.current;
    projectOperationGenerationRef.current += 1;
    fileLoadGenerationRef.current += 1;
    secondaryFileLoadGenerationRef.current += 1;
    resetAgentCompileTracking(true);
    cancelPreviewPrewarm();
    setPrimaryOpening(null);
    // A root-changing backend command may finish before React commits the new
    // snapshot. Nulling only the imperative identity closes that gap without
    // flashing the welcome screen or discarding the rendered old project.
    projectRef.current = null;
    return true;
  }, [cancelPreviewPrewarm, resetAgentCompileTracking]);
  const cancelProjectTransition = useCallback(() => {
    if (!projectRef.current) projectRef.current = projectBeforeTransitionRef.current;
    projectBeforeTransitionRef.current = null;
  }, []);
  const projectTreeMutationCountRef = useRef(0);
  const postSaveRefreshGenerationRef = useRef(0);
  useLayoutEffect(() => {
    projectRef.current = project;
    projectBeforeTransitionRef.current = null;
  }, [project]);
  const schedulePreviewPrewarm = useCallback((
    key: string,
    task: (isCurrent: () => boolean) => Promise<boolean>,
  ) => {
    const state = previewPrewarmRef.current;
    if (state.warmed.has(key) || state.inFlight.has(key) || state.target === key) return;
    cancelPreviewPrewarm();
    state.target = key;
    const generation = state.generation;
    const isCurrent = () => (
      previewPrewarmRef.current.generation === generation
      && previewPrewarmRef.current.target === key
    );
    const run = () => {
      state.idle = null;
      // Intent can move again while an earlier parse is still running. Keep
      // speculative work strictly bounded instead of allowing a fast sweep
      // over the tree to queue a project-sized burst of parses.
      if (!isCurrent() || state.inFlight.size >= 2) return;
      state.inFlight.add(key);
      void task(isCurrent).then((warmed) => {
        if (warmed && isCurrent()) {
          state.warmed.add(key);
          while (state.warmed.size > 4) {
            const oldest = state.warmed.values().next().value;
            if (oldest === undefined) break;
            state.warmed.delete(oldest);
          }
        }
      }).catch(() => undefined).finally(() => {
        state.inFlight.delete(key);
      });
    };
    state.timer = globalThis.setTimeout(() => {
      state.timer = null;
      if (!isCurrent()) return;
      if ("requestIdleCallback" in window) {
        state.idle = window.requestIdleCallback(run, { timeout: 800 });
      } else {
        state.timer = globalThis.setTimeout(run, 0);
      }
    }, 120);
  }, [cancelPreviewPrewarm]);
  useEffect(() => {
    const state = previewPrewarmRef.current;
    cancelPreviewPrewarm();
    state.warmed.clear();
    return cancelPreviewPrewarm;
  }, [cancelPreviewPrewarm, project?.root]);
  const [projectGitStatus, setProjectGitStatus] = useState<{
    projectRoot: string;
    files: GitFileStatus[];
  }>({ projectRoot: "", files: [] });
  const [activeFile, setActiveFile] = useState("");
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [secondaryFile, setSecondaryFile] = useState<string | null>(null);
  const [secondarySource, setSecondarySource] = useState("");
  const [secondarySavedSource, setSecondarySavedSource] = useState("");
  const [focusedPane, setFocusedPane] = useState<EditorPaneId>("primary");
  const [dualRatioResetGeneration, setDualRatioResetGeneration] = useState(0);
  const [selection, setSelection] = useState("");
  const [selectionSource, setSelectionSource] = useState<AgentHostSurface | null>(null);
  const [agentActiveSurface, setAgentActiveSurface] =
    useState<AgentHostSurface>("editor");
  // A content surface can re-report its DOM selection after Lattice has cleared
  // the one-shot Agent context. Scope that suppression to the original surface
  // so the same text selected in another surface remains valid.
  const dismissedSelectionRef = useRef<{
    source: AgentHostSurface;
    text: string;
  } | null>(null);
  // In split view the editor and PDF both live behind the one shared selection
  // chip. An empty report from one pane must not wipe a live selection the other
  // pane owns, or the chip flickers as they fight. This tracks the current owner.
  const selectionSourceRef = useRef<AgentHostSurface | null>(null);
  const [texlabDiagnostics, setTexlabDiagnostics] = useState<CompileDiagnostic[]>([]);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("split");
  const [dualPanePreview, setDualPanePreview] = useState<{
    projectRoot: string;
    primaryPath: string | null;
    secondaryPath: string | null;
  } | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const pdfFingerprintRef = useRef<string | null>(null);
  const displayedPdfBytesRef = useRef<ArrayBuffer | null>(null);
  const pdfPreviewTimerRef = useRef<number | null>(null);
  /** Stable preview payload — debounced so automatic rebuilds do not thrash pdf.js. */
  const pendingPreviewPdfRef = useRef<ArrayBuffer | null>(null);
  /** Bumped when leaving a project so a late build cannot revive a stale PDF. */
  const previewGenerationRef = useRef(0);
  const [editorPosition, setEditorPosition] = useState<EditorPosition | null>(null);
  // Read by the presence hook, which must not re-subscribe on every keystroke.
  const editorPositionRef = useRef<EditorPosition | null>(null);
  editorPositionRef.current = editorPosition;
  const forwardSyncGenerationRef = useRef(0);
  const outlineSyncGenerationRef = useRef(0);
  const [pdfSyncTarget, setPdfSyncTarget] = useState<PdfSyncTarget | null>(null);
  const [locatingPdf, setLocatingPdf] = useState(false);
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [diagnosticBuildSource, setDiagnosticBuildSource] = useState("");
  const [diagnosticBuildSecondarySource, setDiagnosticBuildSecondarySource] = useState("");
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [diagnosticsDismissed, setDiagnosticsDismissed] = useState(false);
  /** Fingerprint of the diagnostics the reader last dismissed, so an unchanged
   *  set stays dismissed through the recompiles that autosave keeps firing. */
  const dismissedDiagnosticsRef = useRef<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [citationKeys, setCitationKeys] = useState<string[]>([]);
  const [citations, setCitations] = useState<CitationInfo[]>([]);
  const [references, setReferences] = useState<ReferenceInfo[]>([]);
  const [unusedSymbols, setUnusedSymbols] = useState<UnusedSymbols>({ labels: [], citations: [] });
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const openTabsRef = useRef<string[]>([]);
  useLayoutEffect(() => { openTabsRef.current = openTabs; }, [openTabs]);
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
  const viewStateRef = useRef(new Map<string, FileViewState>());
  const viewStatePersistTimerRef = useRef<number | null>(null);
  const viewStateEpochRef = useRef(0);
  const removedFileViewStatePathsRef = useRef<string[]>([]);
  const [viewStateEpoch, setViewStateEpoch] = useState(0);
  const invalidateFileViewStateCallbacks = useCallback(() => {
    const next = viewStateEpochRef.current + 1;
    viewStateEpochRef.current = next;
    setViewStateEpoch(next);
  }, []);
  const flushFileViewStates = useCallback(() => {
    if (viewStatePersistTimerRef.current !== null) {
      window.clearTimeout(viewStatePersistTimerRef.current);
      viewStatePersistTimerRef.current = null;
    }
    const root = projectRef.current?.root ?? projectBeforeTransitionRef.current?.root;
    if (root) persistFileViewStates(root, Object.fromEntries(viewStateRef.current));
  }, []);
  const scheduleFileViewStatePersistence = useCallback(() => {
    if (viewStatePersistTimerRef.current !== null) window.clearTimeout(viewStatePersistTimerRef.current);
    viewStatePersistTimerRef.current = window.setTimeout(() => {
      viewStatePersistTimerRef.current = null;
      const root = projectRef.current?.root ?? projectBeforeTransitionRef.current?.root;
      if (root) persistFileViewStates(root, Object.fromEntries(viewStateRef.current));
    }, 250);
  }, []);
  const fileViewStateRoot = project?.root ?? null;
  const rememberFileViewState = useCallback((path: string, update: Partial<FileViewState>) => {
    // Editor cleanup runs after project and path transitions commit. Reject an
    // old tree's final callback so deleted, renamed, or foreign paths cannot
    // re-enter the current root's local view-state map.
    if (!path || viewStateEpoch !== viewStateEpochRef.current
      || removedFileViewStatePathsRef.current.some((removed) => (
        path === removed || path.startsWith(`${removed}/`)
      ))
      || !fileViewStateRoot || projectRef.current?.root !== fileViewStateRoot) return;
    const next = { ...viewStateRef.current.get(path), ...update };
    // Map insertion order is the file-state LRU used by app-settings when it
    // caps local history. Reinsert a touched file at the newest end.
    viewStateRef.current.delete(path);
    viewStateRef.current.set(path, next);
    scheduleFileViewStatePersistence();
  }, [fileViewStateRoot, scheduleFileViewStatePersistence, viewStateEpoch]);
  const getFileViewState = useCallback((path: string) => viewStateRef.current.get(path), []);
  useEffect(() => flushFileViewStates, [flushFileViewStates]);
  const [viewRestore, setViewRestore] = useState<{ path: string; cursor: number; scrollTop: number; id: string } | null>(null);
  const [envRenameRequest, setEnvRenameRequest] = useState<{ newName: string; id: string } | null>(null);
  const [tableGeneratorOpen, setTableGeneratorOpen] = useState(false);
  const [projectReplaceOpen, setProjectReplaceOpen] = useState(false);
  const [projectReplaceBusy, setProjectReplaceBusy] = useState(false);
  const [projectReplaceError, setProjectReplaceError] = useState<string | null>(null);
  const [projectReplacePreview, setProjectReplacePreview] = useState<ReplacePreviewResult | null>(null);
  const [projectFindOpen, setProjectFindOpen] = useState(false);
  const [projectFindBusy, setProjectFindBusy] = useState(false);
  const [projectFindError, setProjectFindError] = useState<string | null>(null);
  const [projectFindHits, setProjectFindHits] = useState<ProjectFindHit[]>([]);
  const projectFindSearchGenerationRef = useRef(0);
  const [localSemanticSearchEnabled, setLocalSemanticSearchEnabled] = useState(
    loadLocalSemanticSearchEnabled,
  );
  const [localSemanticSearchStatus, setLocalSemanticSearchStatus] = useState(
    DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS,
  );
  const [semanticIndexRevision, setSemanticIndexRevision] = useState(0);
  const semanticReindexTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const syncPreference = (event: StorageEvent) => {
      if (event.key !== LOCAL_SEMANTIC_SEARCH_KEY) return;
      const enabled = event.newValue === "1";
      setLocalSemanticSearchEnabled(enabled);
      const projectRoot = projectRef.current?.root;
      if (!enabled && projectRoot) {
        void invoke("semantic_search_cancel", { projectRoot }).catch(() => undefined);
      }
    };
    window.addEventListener("storage", syncPreference);
    return () => window.removeEventListener("storage", syncPreference);
  }, []);
  const requestSemanticReindex = useCallback(() => {
    if (!localSemanticSearchEnabled) return;
    if (semanticReindexTimerRef.current !== null) {
      window.clearTimeout(semanticReindexTimerRef.current);
    }
    // Filesystem events are already coalesced, but one save/build can still
    // produce several bursts. A trailing request avoids repeatedly cancelling
    // and restarting the background generation while files are settling.
    semanticReindexTimerRef.current = window.setTimeout(() => {
      semanticReindexTimerRef.current = null;
      setSemanticIndexRevision((revision) => revision + 1);
    }, 750);
  }, [localSemanticSearchEnabled]);
  useEffect(() => () => {
    if (semanticReindexTimerRef.current !== null) {
      window.clearTimeout(semanticReindexTimerRef.current);
      semanticReindexTimerRef.current = null;
    }
  }, [localSemanticSearchEnabled, project?.root]);
  useEffect(() => {
    const projectRoot = project?.root;
    if (!localSemanticSearchEnabled || !projectRoot) return;
    let stopped = false;
    let unlisten: (() => void) | null = null;
    // Semantic freshness must not depend on whether the Project sidebar is
    // visible. Reuse the existing root watcher, but keep this listener separate
    // from tree refreshes so ordinary source edits only schedule background work.
    void invoke("watch_project").catch(() => undefined);
    void listen<{ root: string }>("project-fs-changed", (event) => {
      if (!stopped && event.payload.root === projectRoot) requestSemanticReindex();
    }).then((dispose) => {
      if (stopped) dispose();
      else unlisten = dispose;
    });
    return () => {
      stopped = true;
      unlisten?.();
    };
  }, [localSemanticSearchEnabled, project?.root, requestSemanticReindex]);
  const semanticIndexEffectGenerationRef = useRef(0);
  useEffect(() => {
    const effectGeneration = ++semanticIndexEffectGenerationRef.current;
    const projectRoot = project?.root;
    let stopped = false;
    let pollTimer: number | null = null;
    const isCurrent = () => (
      !stopped && effectGeneration === semanticIndexEffectGenerationRef.current
    );
    const acceptStatus = (status: LocalSemanticSearchStatus | null | undefined) => {
      if (!isCurrent() || !status || typeof status.state !== "string") return;
      setLocalSemanticSearchStatus(status);
      if (status.state === "indexing") {
        pollTimer = window.setTimeout(() => {
          void invoke<LocalSemanticSearchStatus>("semantic_search_status", { projectRoot })
            .then(acceptStatus)
            .catch(() => {
              if (!isCurrent()) return;
              setLocalSemanticSearchStatus((current) => ({
                ...current,
                state: "error",
                detail: "The local semantic index could not be checked.",
              }));
            });
        }, 500);
      }
    };

    if (!projectRoot) {
      setLocalSemanticSearchStatus(DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS);
    } else if (!localSemanticSearchEnabled) {
      setLocalSemanticSearchStatus(DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS);
    } else {
      setLocalSemanticSearchStatus((current) => ({
        ...current,
        state: "indexing",
        detail: "Building an on-device index in the background.",
      }));
      void invoke<LocalSemanticSearchStatus>("semantic_search_start_index", { projectRoot })
        .then(acceptStatus)
        .catch((reason) => {
          if (!isCurrent()) return;
          setLocalSemanticSearchStatus({
            ...DISABLED_LOCAL_SEMANTIC_SEARCH_STATUS,
            state: "error",
            detail: toMessage(reason),
          });
        });
    }

    return () => {
      stopped = true;
      if (pollTimer !== null) window.clearTimeout(pollTimer);
    };
  }, [localSemanticSearchEnabled, project?.root, semanticIndexRevision]);
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [gotoLineOpen, setGotoLineOpen] = useState(false);
  const [wrapEnvRequest, setWrapEnvRequest] = useState<{ name: string; id: string } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const openCompileDiagnosticRef = useRef<(diagnostic: CompileDiagnostic) => Promise<void>>(async () => undefined);
  const referencePreviewCache = useRef(new Map<string, ReferencePreviewCacheEntry>());
  const [activePaper, setActivePaper] = useState<PaperSummary | null>(null);
  const [paperMarkdown, setPaperMarkdown] = useState("");
  const [savedPaperMarkdown, setSavedPaperMarkdown] = useState("");
  // The alphaXiv overview ("blog") is the default reading view; null when the
  // paper has no report. `paperView` picks which of blog/full-text is shown.
  const [paperBlog, setPaperBlog] = useState<string | null>(null);
  const [savedPaperBlog, setSavedPaperBlog] = useState<string | null>(null);
  const paperMarkdownRef = useRef(paperMarkdown);
  const savedPaperMarkdownRef = useRef(savedPaperMarkdown);
  const paperBlogRef = useRef(paperBlog);
  const savedPaperBlogRef = useRef(savedPaperBlog);
  useLayoutEffect(() => {
    paperMarkdownRef.current = paperMarkdown;
    savedPaperMarkdownRef.current = savedPaperMarkdown;
    paperBlogRef.current = paperBlog;
    savedPaperBlogRef.current = savedPaperBlog;
  }, [paperBlog, paperMarkdown, savedPaperBlog, savedPaperMarkdown]);
  const [paperView, setPaperView] = useState<"blog" | "fulltext">("blog");
  const activePaperPath = activePaper
    ? `.research/papers/${activePaper.arxivId}/${paperView === "blog" ? "blog.md" : "paper.md"}`
    : null;
  const activePaperSource = paperView === "blog" ? paperBlog ?? "" : paperMarkdown;
  const activePaperPreviewSource = paperView === "blog"
    ? paperBlog ?? ""
    : stripFrontmatter(paperMarkdown);
  const activePaperDirty = Boolean(activePaper) && (
    paperMarkdown !== savedPaperMarkdown || paperBlog !== savedPaperBlog
  );
  const prewarmMarkdownSource = useCallback(async (
    path: string,
    source: string,
    isCurrent: () => boolean,
  ) => {
    if (!isCurrent()) return false;
    const startedAt = performance.now();
    const [, warm] = await Promise.all([loadDocumentCanvas(), loadCanvasPrewarm()]);
    if (!isCurrent()) return false;
    await warm.prewarmMarkdownPreviewDocument(path, source);
    const endedAt = performance.now();
    try {
      performance.measure("lattice:markdown-prewarm", {
        start: startedAt,
        end: endedAt,
        detail: { path },
      });
    } catch {
      // Older WebKit builds do not support PerformanceMeasureOptions.detail.
    }
    return isCurrent();
  }, []);
  const prewarmLikelyProjectFile = useCallback((path: string) => {
    if (!/\.mdx?$/i.test(path) || path === activeFile) return;
    const root = projectRef.current?.root;
    if (!root) return;
    schedulePreviewPrewarm(`file:${root}:${path}`, async (isCurrent) => {
      const source = await invoke<string>("read_project_file", { path, projectRoot: root });
      if (!isCurrent() || projectRef.current?.root !== root) return false;
      return prewarmMarkdownSource(path, source.slice(markdownFrontmatterEnd(source)), isCurrent);
    });
  }, [activeFile, prewarmMarkdownSource, schedulePreviewPrewarm]);
  const prewarmLikelyPaper = useCallback((paper: PaperSummary) => {
    if (!paper.arxivId || activePaper?.arxivId === paper.arxivId) return;
    const root = projectRef.current?.root;
    if (!root) return;
    const useBlog = Boolean(paper.hasBlog && (paperView === "blog" || !paper.hasFullText));
    const path = `.research/papers/${paper.arxivId}/${useBlog ? "blog.md" : "paper.md"}`;
    schedulePreviewPrewarm(`paper:${root}:${path}`, async (isCurrent) => {
      const source = await invoke<string>("read_project_file", { path, projectRoot: root });
      if (!source || !isCurrent() || projectRef.current?.root !== root) return false;
      return prewarmMarkdownSource(path, useBlog ? source : stripFrontmatter(source), isCurrent);
    });
  }, [activePaper?.arxivId, paperView, prewarmMarkdownSource, schedulePreviewPrewarm]);
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
  const [activeAsset, setActiveAsset] = useState<AssetPreview | null>(null);
  const [secondaryAsset, setSecondaryAsset] = useState<AssetPreview | null>(null);
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
  const [projectWordCount, setProjectWordCount] = useState<WordCount | null>(null);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [mainBodyPages, setMainBodyPages] = useState<number | null>(null);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [importInput, setImportInput] = useState("");
  const [importing, setImporting] = useState(false);
  // Which network step the literature pipeline is in, from the backend's
  // "paper-import-progress" events. Cleared by whichever operation owned the
  // spinner; agent-driven imports run in a separate process and never emit.
  const [paperImportStage, setPaperImportStage] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<string>(PAPER_IMPORT_PROGRESS_EVENT, (event) => {
      setPaperImportStage(event.payload);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  const [paperFetchStates, setPaperFetchStates] = useState<Record<string, "loading" | "success">>({});
  const paperFetchTimers = useRef<Record<string, number>>({});
  const [assetImporting, setAssetImporting] = useState(false);
  const [assetDropTarget, setAssetDropTarget] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [agentHistoryByThread, setAgentHistoryByThread] = useState<
    Record<string, AgentCheckpointHistoryEntry[]>
  >({});
  const [activeAgentHistoryThreadId, setActiveAgentHistoryThreadId] = useState<string | null>(null);
  useEffect(() => {
    resetAgentCompileTracking();
    return () => resetAgentCompileTracking();
  }, [project?.root, resetAgentCompileTracking]);
  useEffect(() => () => {
    projectOperationGenerationRef.current += 1;
    resetAgentCompileTracking(true);
    projectRef.current = null;
  }, [resetAgentCompileTracking]);
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
  const [diskTodos, setDiskTodos] = useState<TodoHit[]>([]);
  const [editorComments, setEditorComments] = useState<EditorComment[]>([]);
  /** Read inside async publishes, where the state captured at call time is already stale. */
  const editorCommentsRef = useRef<EditorComment[]>([]);
  editorCommentsRef.current = editorComments;
  const [editorCommentsOpen, setEditorCommentsOpen] = useState(false);
  const [activeEditorCommentId, setActiveEditorCommentId] = useState<string | null>(null);
  const [commentPanelFocusId, setCommentPanelFocusId] = useState<string | null>(null);
  const [commentFocusRequest, setCommentFocusRequest] = useState<{ id: string; nonce: string } | null>(null);
  const commentOpenGenerationRef = useRef(0);
  const editorCommentAuthorId = useMemo(() => loadEditorCommentAuthorId(), []);
  const [literatureOpen, setLiteratureOpen] = useState(false);
  const [bibResolveSeed, setBibResolveSeed] = useState("");
  const [bibEntryMode, setBibEntryMode] = useState<"add" | "edit">("add");
  const [bibEntryInitial, setBibEntryInitial] = useState<ResolvedCitationDraft | undefined>(undefined);
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
  const focusedAsset = (canvasMode === "dual" || canvasMode === "columns")
    && focusedPane === "secondary"
    ? secondaryAsset
    : activeAsset;
  const focusedDocumentPath = focusedPane === "secondary" && secondaryFile
    ? secondaryFile
    : activeFile;
  const insertTargetPath = focusedDocumentPath;
  const canInsert = canvasMode !== "pdf"
    && !activePaper
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
  const collabSessionRef = useRef<EditorCollabSession | null>(null);
  const collabV2ControllerRef = useRef<CollabProjectControllerV2 | null>(null);
  const collabWorkspaceLeaseRef = useRef<CollabWorkspaceLease | null>(null);
  const collabDiskWriteQueueRef = useRef(new CollabDiskWriteQueue());
  const collabPathMutationGenerationRef = useRef(new Map<string, number>());
  const collabPathMutationGeneration = useCallback((path: string) => collabPathMutationGenerationRef.current.get(path) ?? 0, []);
  const collabDetachRef = useRef<(() => void) | null>(null);
  const projectRootRef = useRef<string | null>(null);
  const enterProjectRef = useRef<((
    snapshot: ProjectSnapshot,
    options?: { skipCollabLifecycle?: boolean; deferInitialBuild?: boolean },
  ) => Promise<void>) | null>(null);
  const compileRef = useRef<(
    force?: boolean,
    sound?: boolean,
    options?: { consumeAgentAssociations?: boolean },
  ) => Promise<void>>(async () => undefined);
  const activeFileRef = useRef(activeFile);
  const secondaryFileRef = useRef(secondaryFile);
  const activeAssetRef = useRef(activeAsset);
  const secondaryAssetRef = useRef(secondaryAsset);
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
  activeFileRef.current = activeFile;
  secondaryFileRef.current = secondaryFile;
  activeAssetRef.current = activeAsset;
  secondaryAssetRef.current = secondaryAsset;
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
      commit: () => invoke<void>("write_project_file", {
        path,
        content: spreadsheetDocContent(doc),
        projectRoot,
      }),
      dispose: () => doc.destroy(),
    };
  }), [activeCollabVersion, collabCanWrite]);
  const [citeInsertRequest, setCiteInsertRequest] = useState<{ key: string; command: InsertSymbolCommand; id: string } | null>(null);
  const [bibEntryOpen, setBibEntryOpen] = useState(false);
  const [bibEntryBusy, setBibEntryBusy] = useState(false);
  const [bibEntryResolving, setBibEntryResolving] = useState(false);
  const [bibEntryError, setBibEntryError] = useState<string | null>(null);
  const [bibEntryKey, setBibEntryKey] = useState(0);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [goToSymbolOpen, setGoToSymbolOpen] = useState(false);
  const [refCitePicker, setRefCitePicker] = useState<"cite" | "ref" | null>(null);
  const diagnosticCursor = useRef(0);
  const [doctorReport, setDoctorReport] = useState<DoctorReport | null>(null);
  const [doctorBusy, setDoctorBusy] = useState(false);
  const [doctorNotice, setDoctorNotice] = useState("");
  const doctorGenerationRef = useRef(0);
  const [texSetupOpen, setTexSetupOpen] = useState(false);
  const closedTabsRef = useRef<string[]>([]);
  const [outlineSources, setOutlineSources] = useState<Record<string, string>>({});
  const [referenceHits, setReferenceHits] = useState<{
    kind: "label" | "citation";
    symbol: string;
    occurrences: SymbolOccurrence[];
  } | null>(null);
  const [synaraMinimumSidebarWidth, setSynaraMinimumSidebarWidth] = useState(
    SYNARA_SIDEBAR_MINIMUM,
  );
  const {
    sidebarOpen,
    setSidebarOpen,
    sidebarWidth,
    sidebarResizing,
    beginSidebarResize,
    nudgeSidebar,
    fitSidebarToContent,
  } = usePanelLayout(synaraMinimumSidebarWidth);
  const [sidebarMode, setSidebarMode] = useState<"project" | "papers" | "agent">(() => {
    try {
      const saved = localStorage.getItem("lattice.sidebar-mode.v1");
      // Mounting the cross-origin Agent iframe during React's first root render
      // can corrupt React's development scheduler in WebKit. Restore Papers,
      // but let Agent mount only after an explicit post-startup interaction.
      return saved === "papers" ? saved : "project";
    } catch {
      return "project";
    }
  });
  // One-way by design. A hidden Synara surface may still own a background turn
  // or PTY, so the first request starts the service for the rest of this app
  // process; process-idle shutdown needs an explicit lease/task protocol.
  const [synaraRuntimeRequested, setSynaraRuntimeRequested] = useState(false);
  const {
    runtime: synaraRuntime,
    retry: retrySynaraRuntime,
  } = useSynaraRuntime(synaraRuntimeRequested);
  const synaraOrigin =
    synaraRuntime.state === "ready" ? synaraRuntime.origin : null;
  const sidebarModeHeaderRef = useRef<HTMLDivElement>(null);
  const sidebarModeActionsRef = useRef<HTMLDivElement>(null);
  const [sidebarModeTier, setSidebarModeTier] = useState<SidebarModeTier>(4);
  useEffect(() => {
    const header = sidebarModeHeaderRef.current;
    const actions = sidebarModeActionsRef.current;
    const tabs = header?.querySelector<HTMLElement>(".sidebar-mode-tabs");
    if (!header || !actions || !tabs) return;

    let frameId: number | null = null;
    const measure = () => {
      frameId = null;
      const styles = getComputedStyle(header);
      const collapsedWidth = Number.parseFloat(
        styles.getPropertyValue("--navigation-control-height"),
      );
      const expandedWidth = Number.parseFloat(
        styles.getPropertyValue("--navigation-tab-expanded-width"),
      );
      const tabGap = Number.parseFloat(styles.getPropertyValue("--navigation-tab-gap"));
      const actionsGap = Number.parseFloat(
        styles.getPropertyValue("--navigation-mode-actions-gap"),
      );
      if (![collapsedWidth, expandedWidth, tabGap, actionsGap].every(Number.isFinite)) return;

      const tabCount = tabs.querySelectorAll<HTMLElement>("[role=tab]").length;
      if (tabCount === 0) return;
      const tabsLeft = tabs.getBoundingClientRect().left;
      const actionsLeft = actions.getBoundingClientRect().left;
      const availableWidth = Math.max(0, actionsLeft - tabsLeft - actionsGap);
      const nextTier = resolveSidebarModeTier({
        availableWidth,
        collapsedWidth,
        expandedWidth,
        tabCount,
        tabGap,
      });
      setSidebarModeTier((current) => current === nextTier ? current : nextTier);
    };
    const scheduleMeasure = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(measure);
    };

    scheduleMeasure();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleMeasure);
    observer?.observe(header);
    observer?.observe(actions);
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      if (frameId !== null) cancelAnimationFrame(frameId);
    };
  }, [project?.root, sidebarMode, sidebarOpen]);
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [boardCreateRequest, setBoardCreateRequest] = useState(0);
  const [spreadsheetCreateRequest, setSpreadsheetCreateRequest] = useState(0);
  const synaraIframeRef = useRef<HTMLIFrameElement>(null);
  const synaraSourceControlFrameRef = useRef<HTMLIFrameElement>(null);
  useSynaraNotificationBridge({
    frameRef: synaraIframeRef,
    origin: synaraOrigin,
    source: "Synara agent",
  });
  useSynaraConfirmationBridge({
    frameRef: synaraIframeRef,
    origin: synaraOrigin,
  });
  useSynaraNotificationBridge({
    frameRef: synaraSourceControlFrameRef,
    origin: synaraOrigin,
    source: "Synara source control",
  });
  useSynaraConfirmationBridge({
    frameRef: synaraSourceControlFrameRef,
    origin: synaraOrigin,
  });
  const [synaraFrameMounted, setSynaraFrameMounted] = useState(false);
  const [readySynaraFrameKey, setReadySynaraFrameKey] = useState<string | null>(null);
  const synaraFrameKey = synaraOrigin && project
    ? `${synaraOrigin}\0${project.root}`
    : null;
  useEffect(() => {
    setAgentHistoryByThread({});
    setActiveAgentHistoryThreadId(null);
  }, [project?.root]);
  const synaraFrameReady =
    synaraFrameKey !== null && readySynaraFrameKey === synaraFrameKey;
  const [synaraPermissionMode, setSynaraPermissionMode] =
    useState<SynaraPermissionMode>("full-access");
  const [synaraAutoModeAvailable, setSynaraAutoModeAvailable] = useState(true);
  useEffect(() => {
    setAgentActiveSurface((current) => {
      if (activePaper) return "paper";
      if (canvasMode === "pdf") return "pdf";
      if (canvasMode === "split" || canvasMode === "columns") {
        return current === "paper" ? "editor" : current;
      }
      return "editor";
    });
  }, [activePaper, canvasMode]);
  const activateAgentHostSurface = useCallback((surface: AgentHostSurface) => {
    setAgentActiveSurface(surface);
    const previousSource = selectionSourceRef.current;
    // Pointer and focus capture both run while a block grip focuses the
    // visual editor. Re-activating the surface that already owns the
    // selection must not clear the context that the grip just published.
    if (previousSource === surface) return;
    if (!previousSource) {
      if (dismissedSelectionRef.current?.source === surface) {
        dismissedSelectionRef.current = null;
      }
      return;
    }
    dismissedSelectionRef.current = selection
      ? { source: previousSource, text: selection }
      : null;
    selectionSourceRef.current = null;
    setSelection("");
    setSelectionSource(null);
  }, [selection]);
  const reportAgentSelection = useCallback((
    source: AgentHostSurface,
    value: string,
  ) => {
    const dismissed = dismissedSelectionRef.current;
    if (
      value &&
      dismissed?.source === source &&
      dismissed.text === value
    ) {
      return;
    }
    if (!value) {
      if (dismissed?.source === source) dismissedSelectionRef.current = null;
      if (selectionSourceRef.current !== source) return;
      selectionSourceRef.current = null;
      setSelection("");
      setSelectionSource(null);
      return;
    }
    dismissedSelectionRef.current = null;
    selectionSourceRef.current = source;
    setAgentActiveSurface(source);
    setSelection(value);
    setSelectionSource(source);
  }, []);
  const selectionImageSourcePath = useMemo(() => {
    const documentPath = selectionSource === "paper"
      ? activePaperPath
      : selectionSource === "editor"
        ? editorPosition?.path || activeFile
        : null;
    return documentPath
      ? selectedMarkdownImageProjectPath(selection, documentPath)
      : null;
  }, [activeFile, activePaperPath, editorPosition?.path, selection, selectionSource]);
  const selectionImageEnabled = Boolean(
    selectionImageSourcePath
    && selectionSource
    && project?.root
    && synaraOrigin
    && synaraFrameMounted
    && sidebarOpen
    && sidebarMode === "agent",
  );
  const directAgentSelectionImage = useMemo<(
    AgentHostSelectionImage & { source: AgentHostSurface }
  ) | null>(() => {
    if (!selectionImageEnabled || !selectionImageSourcePath || !selectionSource) return null;
    const mimeType = /\.png$/i.test(selectionImageSourcePath)
      ? "image/png"
      : /\.jpe?g$/i.test(selectionImageSourcePath)
        ? "image/jpeg"
        : null;
    return mimeType
      ? {
          source: selectionSource,
          sourcePath: selectionImageSourcePath,
          agentReadablePath: selectionImageSourcePath,
          mimeType,
        }
      : null;
  }, [selectionImageEnabled, selectionImageSourcePath, selectionSource]);
  const [preparedAgentSelectionImage, setPreparedAgentSelectionImage] = useState<(
    AgentHostSelectionImage & { source: AgentHostSurface; projectRoot: string }
  ) | null>(null);
  const matchingPreparedAgentSelectionImage = preparedAgentSelectionImage
    && preparedAgentSelectionImage.projectRoot === project?.root
    && preparedAgentSelectionImage.source === selectionSource
    && preparedAgentSelectionImage.sourcePath === selectionImageSourcePath
    ? preparedAgentSelectionImage
    : null;
  const agentSelectionImage = directAgentSelectionImage ?? (
    selectionImageEnabled ? matchingPreparedAgentSelectionImage : null
  );
  useEffect(() => {
    if (
      !selectionImageEnabled
      || !selectionImageSourcePath
      || !selectionSource
      || !project?.root
      || !/\.webp$/i.test(selectionImageSourcePath)
    ) {
      return;
    }

    const source = selectionSource;
    const projectRoot = project.root;
    let disposed = false;
    void invoke<string>("prepare_latex_figure", {
      path: selectionImageSourcePath,
      projectRoot,
    }).then((agentReadablePath) => {
      if (disposed || !agentReadablePath) return;
      setPreparedAgentSelectionImage({
        source,
        projectRoot,
        sourcePath: selectionImageSourcePath,
        agentReadablePath,
        mimeType: "image/png",
      });
    }).catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [
    project?.root,
    selectionImageEnabled,
    selectionImageSourcePath,
    selectionSource,
  ]);
  const agentHostContext = useMemo<AgentHostContextSnapshot | null>(
    () => project
      ? buildAgentHostContext({
          workspaceRoot: project.root,
          activeFile,
          secondaryFile,
          editorPosition,
          activePaper,
          canvasMode,
          paperView,
          pdfPage: pdfPageNumber,
          pdfPageCount,
          selection,
          selectionSource,
          selectionImage: agentSelectionImage,
          activeSurface: agentActiveSurface,
        })
      : null,
    [
      activeFile,
      agentActiveSurface,
      agentSelectionImage,
      activePaper,
      canvasMode,
      editorPosition,
      paperView,
      pdfPageCount,
      pdfPageNumber,
      project,
      secondaryFile,
      selection,
      selectionSource,
    ],
  );
  const latestAgentHostContextRef = useRef(agentHostContext);
  useLayoutEffect(() => {
    latestAgentHostContextRef.current = agentHostContext;
  }, [agentHostContext]);
  const agentPaperLibrary = useMemo<AgentPaperLibrarySnapshot | null>(
    () => project
      ? buildAgentPaperLibrary({
          workspaceRoot: project.root,
          papers,
        })
      : null,
    [papers, project],
  );
  const latestAgentPaperLibraryRef = useRef(agentPaperLibrary);
  useLayoutEffect(() => {
    latestAgentPaperLibraryRef.current = agentPaperLibrary;
  }, [agentPaperLibrary]);
  const postSynaraMessage = useCallback((message: object) => {
    if (!synaraOrigin) return;
    synaraIframeRef.current?.contentWindow?.postMessage(
      message,
      synaraOrigin,
    );
  }, [synaraOrigin]);
  // WebKit drops pointerleave when the cursor crosses out of the agent iframe,
  // so hover states inside it (its overlay scrollbar) stick until the pointer
  // returns. Any pointerover in this document means the pointer is not over
  // the iframe; relay it, throttled, as the missing leave signal.
  useEffect(() => {
    if (!synaraOrigin) return;
    let lastPost = 0;
    const notify = () => {
      const now = performance.now();
      if (now - lastPost < 150) return;
      lastPost = now;
      postSynaraMessage({ type: LATTICE_HOST_POINTER });
    };
    document.addEventListener("pointerover", notify, true);
    return () => document.removeEventListener("pointerover", notify, true);
  }, [postSynaraMessage, synaraOrigin]);
  useEffect(() => {
    if (
      !agentHostContext ||
      !synaraOrigin ||
      !synaraFrameMounted ||
      !synaraFrameReady ||
      !sidebarOpen ||
      sidebarMode !== "agent"
    ) return;
    const frame = window.requestAnimationFrame(() => {
      postSynaraMessage(agentHostContext);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    agentHostContext,
    postSynaraMessage,
    sidebarMode,
    sidebarOpen,
    synaraFrameMounted,
    synaraFrameReady,
    synaraOrigin,
  ]);
  useEffect(() => {
    if (
      !agentPaperLibrary ||
      !synaraOrigin ||
      !synaraFrameMounted ||
      !synaraFrameReady ||
      !sidebarOpen ||
      sidebarMode !== "agent"
    ) return;
    const frame = window.requestAnimationFrame(() => {
      postSynaraMessage(agentPaperLibrary);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    agentPaperLibrary,
    postSynaraMessage,
    sidebarMode,
    sidebarOpen,
    synaraFrameMounted,
    synaraFrameReady,
    synaraOrigin,
  ]);
  const changeSynaraPermissionMode = useCallback((mode: SynaraPermissionMode) => {
    postSynaraMessage({ type: LATTICE_AGENT_PERMISSION_MODE_SET, mode });
  }, [postSynaraMessage]);
  const chooseSidebarMode = (mode: "project" | "papers" | "agent") => {
    if (mode === "agent") {
      setSynaraRuntimeRequested(true);
      setSynaraFrameMounted(true);
      if (synaraFrameReady) {
        postSynaraMessage({ type: LATTICE_AGENT_PANEL_OPENED });
      }
    }
    setSidebarMode(mode);
    setSidebarOpen(true);
    if (tutorialActive && tutorialStep === TUTORIAL_STEPS.openPapers && mode === "papers") {
      setTutorialStep(TUTORIAL_STEPS.papers);
    } else if (tutorialActive && tutorialStep === TUTORIAL_STEPS.openAgent && mode === "agent") {
      setTutorialStep(TUTORIAL_STEPS.agent);
    }
  };
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  useEffect(() => {
    try {
      localStorage.setItem("lattice.sidebar-mode.v1", sidebarMode);
    } catch {
      // Mode still switches for the current session without storage.
    }
  }, [sidebarMode]);
  useEffect(() => {
    if (!synaraOrigin) return;
    const receiveSynaraMessage = (event: MessageEvent) => {
      if (
        event.source !== synaraIframeRef.current?.contentWindow ||
        event.origin !== synaraOrigin
      ) {
        return;
      }
      if (event.data?.type === SYNARA_EMBED_READY) {
        if (synaraFrameKey) setReadySynaraFrameKey(synaraFrameKey);
        postSynaraMessage({ type: LATTICE_AGENT_PERMISSION_MODE_REQUEST });
        const hostContext = latestAgentHostContextRef.current;
        if (hostContext) postSynaraMessage(hostContext);
        const paperLibrary = latestAgentPaperLibraryRef.current;
        if (paperLibrary) postSynaraMessage(paperLibrary);
        if (sidebarMode === "agent") {
          postSynaraMessage({ type: LATTICE_AGENT_PANEL_OPENED });
        }
        return;
      }
      if (
        event.data?.type === SYNARA_OPEN_SETTINGS &&
        event.data.section === "providers"
      ) {
        setSynaraRuntimeRequested(true);
        setSettingsTab("agent");
        setSettingsOpen(true);
        return;
      }
      if (event.data?.type === SYNARA_OPEN_FILE) {
        // A file the agent named in its answer. The panel has no editor of its
        // own to show it in, and the one beside it is ours. Route cached Paper
        // markdown through the reader just like links inside our own preview.
        const path = synaraProjectRelativeFilePath(
          event.data.filePath,
          projectRef.current?.root,
        );
        if (path) openMarkdownProjectPathRef.current(path);
        return;
      }
      if (event.data?.type === SYNARA_OPEN_REVIEW) {
        // The embedded chat has no diff surface of its own. A file row carries
        // its path and opens in the editor; the bare Review button opens the
        // drawer pinned to that turn's checkpoint diff — the working tree may
        // already be clean (undo, saved version) and would review nothing.
        const filePath = synaraProjectRelativeFilePath(
          event.data.filePath,
          projectRef.current?.root,
        );
        if (filePath) {
          void openProjectFileRef.current(filePath);
          return;
        }
        const threadId = typeof event.data.threadId === "string" ? event.data.threadId.trim() : "";
        const turnId = typeof event.data.turnId === "string" ? event.data.turnId.trim() : "";
        if (threadId && turnId) {
          setAgentTurnReview({ threadId, turnId, filePath: null });
        } else {
          setGitWorkspaceView("changes");
        }
        setGitOpen(true);
        return;
      }
      if (event.data?.type === LATTICE_HOST_CONTEXT_REQUEST) {
        const hostContext = latestAgentHostContextRef.current;
        if (hostContext) postSynaraMessage(hostContext);
        return;
      }
      if (event.data?.type === LATTICE_PAPER_LIBRARY_REQUEST) {
        const paperLibrary = latestAgentPaperLibraryRef.current;
        if (paperLibrary) postSynaraMessage(paperLibrary);
        return;
      }
      if (event.data?.type === LATTICE_HOST_CONTEXT_SELECTION_CLEAR) {
        const source = selectionSourceRef.current;
        dismissedSelectionRef.current =
          source && selection ? { source, text: selection } : null;
        selectionSourceRef.current = null;
        setSelection("");
        setSelectionSource(null);
        return;
      }
      const canvasRequest = parseAgentCanvasToolRequest(event.data);
      if (canvasRequest) {
        void executeAgentCanvasToolRequest(canvasRequest).then(postSynaraMessage);
        return;
      }
      const spreadsheetRequest = parseAgentSpreadsheetToolRequest(event.data);
      if (spreadsheetRequest) {
        void executeAgentSpreadsheetToolRequest(spreadsheetRequest).then(postSynaraMessage);
        return;
      }
      const historySnapshot = parseAgentProjectHistorySnapshot(event.data);
      if (historySnapshot) {
        setAgentHistoryByThread((current) => ({
          ...current,
          [historySnapshot.activeThreadId]: historySnapshot.entries,
        }));
        setActiveAgentHistoryThreadId(historySnapshot.activeThreadId);
        // Agent edits land on disk without passing through the editor, so the
        // dirty-buffer autosave path never rebuilds the PDF for them. Detect
        // fresh checkpoint work here and rebuild once the snapshots go quiet
        // (they stream while a turn is still editing).
        const fingerprints = agentCheckpointFingerprintsRef.current;
        const changedEntries: AgentCheckpointHistoryEntry[] = [];
        for (const entry of historySnapshot.entries) {
          const entryKey = `${entry.threadId}\u0000${entry.id}`;
          const fingerprint = entry.files
            .map((file) => `${file.path}\u0000${file.additions}\u0000${file.deletions}`)
            .join("\n");
          if (fingerprints.get(entryKey) === fingerprint) continue;
          fingerprints.set(entryKey, fingerprint);
          changedEntries.push(entry);
        }
        const primedThreads = agentHistoryPrimedThreadsRef.current;
        if (!primedThreads.has(historySnapshot.activeThreadId)) {
          primedThreads.add(historySnapshot.activeThreadId);
          return;
        }
        const buildRelevantEntries = changedEntries.filter((entry) => entry.files.some((file) =>
          !file.path.startsWith(".research/") && !file.path.startsWith(".git/")));
        if (!buildRelevantEntries.length || autoBuildModeRef.current !== "automatic") return;
        for (const entry of buildRelevantEntries) {
          pendingAgentCompileResultsRef.current.set(`${entry.threadId}\u0000${entry.id}`, {
            threadId: entry.threadId,
            turnId: entry.turnId,
            checkpointRef: entry.checkpointRef,
          });
        }
        if (agentEditsBuildTimerRef.current) window.clearTimeout(agentEditsBuildTimerRef.current);
        const scheduledProjectRoot = projectRef.current?.root;
        agentEditsBuildTimerRef.current = window.setTimeout(() => {
          agentEditsBuildTimerRef.current = null;
          if (projectRef.current?.root !== scheduledProjectRoot) return;
          void compileRef.current(false, false, { consumeAgentAssociations: true });
        }, 1_500);
        return;
      }
      if (
        event.data?.type === SYNARA_AGENT_PERMISSION_MODE_STATUS &&
        isSynaraPermissionMode(event.data.mode)
      ) {
        setSynaraPermissionMode(event.data.mode);
        setSynaraAutoModeAvailable(event.data.autoModeAvailable !== false);
        return;
      }
      if (
        event.data?.type === SYNARA_LAYOUT_METRICS &&
        typeof event.data.minimumSidebarWidth === "number" &&
        Number.isFinite(event.data.minimumSidebarWidth)
      ) {
        const reportedMinimum = Math.round(
          Math.min(
            SYNARA_SIDEBAR_MAXIMUM_MINIMUM,
            Math.max(SYNARA_SIDEBAR_MINIMUM, event.data.minimumSidebarWidth),
          ),
        );
        // Synara reports an intrinsic control width, not the footer's currently
        // assigned grid width, so this value may safely decrease after controls
        // or model labels change.
        setSynaraMinimumSidebarWidth(reportedMinimum);
      }
    };
    window.addEventListener("message", receiveSynaraMessage);
    return () => window.removeEventListener("message", receiveSynaraMessage);
  }, [postSynaraMessage, selection, sidebarMode, synaraFrameKey, synaraOrigin]);
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
  }, [gitOpen, synaraOrigin]);

  useEffect(() => {
    const initialProject = projectRef.current;
    if (!initialProject || sidebarMode !== "project") return;
    let stopped = false;
    let checking = false;
    const refreshProjectTreeState = async () => {
      if (checking || projectTreeMutationCountRef.current > 0) return;
      checking = true;
      const refreshGeneration = projectRefreshGenerationRef.current + 1;
      projectRefreshGenerationRef.current = refreshGeneration;
      try {
        const [snapshotResult, gitStatusResult] = await Promise.allSettled([
          invoke<ProjectSnapshot>("refresh_project"),
          invoke<GitStatus>("git_status"),
        ]);
        const currentProject = projectRef.current;
        if (
          !stopped
          && refreshGeneration === projectRefreshGenerationRef.current
          && currentProject
          && projectTreeMutationCountRef.current === 0
          && snapshotResult.status === "fulfilled"
          && snapshotResult.value.root === currentProject.root
          && JSON.stringify(snapshotResult.value.files) !== JSON.stringify(currentProject.files)
        ) {
          setProject(snapshotResult.value);
        }
        if (
          !stopped
          && currentProject?.root === initialProject.root
          && projectTreeMutationCountRef.current === 0
          && gitStatusResult.status === "fulfilled"
        ) {
          const gitStatus = gitStatusResult.value;
          const files = gitStatus?.repository ? gitStatus.files : [];
          setProjectGitStatus((current) => {
            if (
              currentProject
              && current.projectRoot === currentProject.root
              && JSON.stringify(current.files) === JSON.stringify(files)
            ) {
              return current;
            }
            return { projectRoot: currentProject?.root ?? "", files };
          });
        }
      } catch {
        // The next poll retries after transient filesystem races.
      } finally {
        checking = false;
      }
    };
    void refreshProjectTreeState();
    // Event-driven refresh: the Rust watcher coalesces filesystem bursts into
    // one project-fs-changed broadcast (payload carries the root so a window
    // showing another project ignores it). The interval is only a safety net
    // for anything a watcher can genuinely miss (network volumes, overflow).
    void invoke("watch_project").catch(() => {
      // Watcher-less operation degrades to the fallback poll below.
    });
    let unlisten: (() => void) | null = null;
    void listen<{ root: string }>("project-fs-changed", (event) => {
      if (stopped || event.payload.root !== initialProject.root) return;
      void refreshProjectTreeState();
    }).then((dispose) => {
      if (stopped) dispose();
      else unlisten = dispose;
    });
    const timer = window.setInterval(() => { void refreshProjectTreeState(); }, 30_000);
    return () => {
      stopped = true;
      unlisten?.();
      window.clearInterval(timer);
    };
  }, [project?.root, sidebarMode]);
  // Remember the file open per project, so reopening it lands on the last page.
  useEffect(() => {
    if (project?.root && activeFile) persistLastFile(project.root, activeFile);
  }, [project?.root, activeFile]);
  const { theme, themePreference, setThemePreference, appearance, setAppearance } = useAppearance();
  const appLocale = resolveAppLocale(appearance.interfaceLanguage);
  useEffect(() => {
    configureInterfaceSounds(appearance.interfaceSounds);
  }, [appearance.interfaceSounds]);
  useLayoutEffect(() => {
    const appWindow = getCurrentWindowSafely();
    if (!appWindow) return;
    if (typeof appWindow.setMinSize !== "function") return;
    const minimumWorkspaceWidth = Number(
      document.querySelector<HTMLElement>(".split-canvas[data-minimum-workspace-width]")
        ?.dataset.minimumWorkspaceWidth,
    ) || 0;
    const width = minimumWindowWidth({
      interfaceScale: appearance.interfaceScale,
      minimumSidebarWidth: synaraMinimumSidebarWidth,
      minimumWorkspaceWidth,
      sidebarOpen,
    });
    void appWindow.setMinSize(new LogicalSize(width, APP_WINDOW_MIN_HEIGHT)).catch(() => {
      // Browser previews and older desktop capabilities may not expose this.
    });
  }, [
    appearance.interfaceScale,
    canvasMode,
    project?.root,
    sidebarOpen,
    synaraMinimumSidebarWidth,
  ]);
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
    if (hasLateProjectTransitionEditRef.current()) {
      setNotice("The document changed while saving. Save it, then switch projects again.");
      return false;
    }
    if (beginProjectTransition()) return true;
    setNotice("Overleaf sync is finishing. Try switching projects again in a moment.", "Overleaf");
    return false;
  }, [beginProjectTransition]);

  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [projectVenue, setProjectVenue] = useState<ProjectVenue>("neurips");
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>(loadRecentProjects);
  const [projectName, setProjectName] = useState("Untitled research");
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [buildPreferences, setBuildPreferences] = useState<BuildPreferences>(loadBuildPreferences);
  /** Read inside the Synara message handler, which outlives any single render. */
  const autoBuildModeRef = useRef(buildPreferences.autoBuildMode);
  useEffect(() => {
    autoBuildModeRef.current = buildPreferences.autoBuildMode;
  }, [buildPreferences.autoBuildMode]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const automaticBuildPending = useRef(false);
  const buildingRef = useRef(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const rememberProject = useCallback((snapshot: ProjectSnapshot) => {
    setRecentProjects(rememberRecentProject({
      name: snapshot.manifest.name,
      path: snapshot.root,
    }));
  }, []);

  const refreshHistory = useCallback(async () => {
    if (!project) return;
    setHistory(await invoke<HistoryItem[]>("list_history"));
  }, [project]);

  const projectHistory = useMemo<HistoryItem[]>(() => {
    const agentItems = Object.values(agentHistoryByThread).flatMap((entries) =>
      entries.map((entry) => ({
        id: entry.id,
        label: entry.label,
        timestamp: entry.timestamp,
        files: entry.files.map((file) => file.path),
        actor: "agent",
        kind: "agent-checkpoint",
        source: "agent-checkpoint",
        threadId: entry.threadId,
        threadTitle: entry.threadTitle,
        checkpointRef: entry.checkpointRef,
        turnCount: entry.turnCount,
        fileSummaries: entry.files,
        restoreAvailable: entry.threadId === activeAgentHistoryThreadId,
        restoreUnavailableReason:
          entry.threadId === activeAgentHistoryThreadId
            ? null
            : "Open this Agent task before restoring its files",
      })),
    );
    return [...history, ...agentItems].sort((left, right) =>
      right.timestamp.localeCompare(left.timestamp),
    );
  }, [activeAgentHistoryThreadId, agentHistoryByThread, history]);

  const refreshTodos = useCallback(async () => {
    if (!project) {
      setDiskTodos([]);
      return;
    }
    try {
      setDiskTodos(await invoke<TodoHit[]>("list_todos"));
    } catch {
      setDiskTodos([]);
    }
  }, [project]);

  const refreshWordCount = useCallback(async () => {
    if (!project) {
      setProjectWordCount(null);
      return;
    }
    try {
      setProjectWordCount(await invoke<WordCount>("count_project_words"));
    } catch {
      setProjectWordCount(null);
    }
  }, [project]);

  const refreshUnusedSymbols = useCallback(async () => {
    try {
      setUnusedSymbols(await invoke<UnusedSymbols>("list_unused_symbols"));
    } catch {
      setUnusedSymbols({ labels: [], citations: [] });
    }
  }, []);

  const refreshAfterSave = useCallback((
    projectRoot: string,
    wroteTex: boolean,
    wroteBib: boolean,
  ) => {
    const generation = postSaveRefreshGenerationRef.current + 1;
    postSaveRefreshGenerationRef.current = generation;
    const refresh = async () => {
      const [
        citationResult,
        referenceResult,
        unusedResult,
        historyResult,
        todoResult,
        wordCountResult,
      ] = await Promise.allSettled([
        wroteBib
          ? Promise.all([
              invoke<string[]>("list_citation_keys"),
              invoke<CitationInfo[]>("list_citations"),
            ])
          : Promise.resolve(null),
        wroteTex
          ? invoke<ReferenceInfo[]>("list_references")
          : Promise.resolve(null),
        invoke<UnusedSymbols>("list_unused_symbols"),
        invoke<HistoryItem[]>("list_history"),
        invoke<TodoHit[]>("list_todos"),
        invoke<WordCount>("count_project_words"),
      ] as const);
      if (
        generation !== postSaveRefreshGenerationRef.current
        || projectRef.current?.root !== projectRoot
      ) {
        return;
      }
      if (citationResult.status === "fulfilled" && citationResult.value) {
        const [nextCitationKeys, nextCitations] = citationResult.value;
        setCitationKeys(nextCitationKeys);
        setCitations(nextCitations);
      }
      if (referenceResult.status === "fulfilled" && referenceResult.value) {
        setReferences(referenceResult.value ?? []);
      }
      if (unusedResult.status === "fulfilled") setUnusedSymbols(unusedResult.value);
      if (historyResult.status === "fulfilled") setHistory(historyResult.value);
      if (todoResult.status === "fulfilled") setDiskTodos(todoResult.value);
      if (wordCountResult.status === "fulfilled") setProjectWordCount(wordCountResult.value);
    };
    void refresh();
  }, []);

  const refreshProject = useCallback(async (scope?: {
    expectedRoot: string;
    generation: number;
  }) => {
    const refreshGeneration = projectRefreshGenerationRef.current + 1;
    projectRefreshGenerationRef.current = refreshGeneration;
    const mayApply = (snapshotRoot?: string) => mayApplyProjectRefreshV2({
      refreshGeneration,
      currentRefreshGeneration: projectRefreshGenerationRef.current,
      scope,
      currentProjectGeneration: projectOperationGenerationRef.current,
      currentRoot: projectRef.current?.root,
      snapshotRoot,
    });
    const snapshot = await invoke<ProjectSnapshot>("refresh_project");
    if (!mayApply(snapshot.root)) return snapshot;
    setProject(snapshot);
    const [nextPapers, nextCitationKeys, nextCitations, nextReferences] = await Promise.all([
      invoke<PaperSummary[]>("list_papers"),
      invoke<string[]>("list_citation_keys"),
      invoke<CitationInfo[]>("list_citations"),
      invoke<ReferenceInfo[]>("list_references"),
    ]);
    if (!mayApply(snapshot.root)) return snapshot;
    setPapers(nextPapers);
    setCitationKeys(nextCitationKeys);
    setCitations(nextCitations);
    setReferences(nextReferences ?? []);
    await refreshUnusedSymbols();
    return snapshot;
  }, [refreshUnusedSymbols]);

  const reconcileProjectTree = useCallback(async () => {
    const refreshGeneration = projectRefreshGenerationRef.current + 1;
    projectRefreshGenerationRef.current = refreshGeneration;
    const snapshot = await invoke<ProjectSnapshot>("refresh_project");
    if (refreshGeneration === projectRefreshGenerationRef.current) setProject(snapshot);
    return snapshot;
  }, []);

  const diskMtimeRef = useRef<number | null>(null);
  const sourceRef = useRef(source);
  const savedSourceRef = useRef(savedSource);
  const secondarySourceRef = useRef(secondarySource);
  const secondarySavedRef = useRef(secondarySavedSource);
  sourceRef.current = source;
  savedSourceRef.current = savedSource;
  secondarySourceRef.current = secondarySource;
  secondarySavedRef.current = secondarySavedSource;
  const setPrimarySource = useCallback((value: string) => {
    sourceRef.current = value;
    setSource(value);
  }, []);
  const setSecondarySourceLive = useCallback((value: string) => {
    secondarySourceRef.current = value;
    setSecondarySource(value);
  }, []);
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
      return paperMarkdownRef.current !== savedPaperMarkdownRef.current
        || paperBlogRef.current !== savedPaperBlogRef.current;
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
    const showLoadedDocument = () => {
      setCanvasMode((mode) => {
        if (isHtmlFilePath(path)) return htmlViewModesRef.current.get(path) ?? "pdf";
        if (isPreviewableSourceFilePath(path)) return documentModeRef.current;
        if (options?.revealSource) return "source";
        if (isHtmlFilePath(previousPath)) return documentModeRef.current;
        if (mode === "asset") return "split";
        return mode;
      });
    };
    const requestLineNavigation = () => {
      if (options?.navigateToLine === undefined) return;
      setEditorNavigation({ path, line: options.navigateToLine, id: crypto.randomUUID() });
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
        sourceRef.current = content;
        savedSourceRef.current = content;
        activeFileRef.current = path;
        setActiveFile(path);
        setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
        setSource(content);
        setSavedSource(content);
        setActivePaper(null);
        setActiveAsset(null);
        setCollabSession(v2);
        setCollabReady(true);
        showLoadedDocument();
        requestLineNavigation();
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
      sourceRef.current = content;
      savedSourceRef.current = content;
      activeFileRef.current = path;
      setActiveFile(path);
      setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
      setSource(content);
      setSavedSource(content);
      setActivePaper(null);
      setActiveAsset(null);
      setPaperMarkdown("");
      setSavedPaperMarkdown("");
      setPaperBlog(null);
      setSavedPaperBlog(null);
      showLoadedDocument();
      requestLineNavigation();
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

  useEffect(() => {
    const appWindow = getCurrentWindowSafely();
    if (!appWindow || typeof appWindow.onCloseRequested !== "function" || typeof appWindow.destroy !== "function") return;
    let active = true;
    let closing = false;
    let unlisten: (() => void) | undefined;
    void appWindow.onCloseRequested((event) => {
      if (closing) return;
      closing = true;
      event.preventDefault();
      const controller = collabV2ControllerRef.current;
      const leave = controller?.leavePresence() ?? Promise.resolve();
      const deadline = new Promise<void>((resolve) => window.setTimeout(resolve, 500));
      void Promise.race([leave.catch(() => undefined), deadline]).finally(() => {
        if (!active) return;
        // Preventing the close above means this call is the only thing that
        // still closes the window: swallowing its rejection (a missing
        // core:window:allow-destroy grant did exactly that) leaves the traffic
        // light dead with nothing on screen to explain it.
        void appWindow.destroy().catch((reason) => {
          closing = false;
          setError(`Lattice could not close its window: ${toMessage(reason)}`);
        });
      });
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

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

    invalidateFileViewStateCallbacks();
    setOpenTabs(initialPlan.openTabs);
    tabRecency.current = initialPlan.tabRecency;
    viewStateRef.current.delete(path);
    scheduleFileViewStatePersistence();
    setNavStack((entries) => entries.filter((entry) => entry.path !== path));
    setViewRestore((request) => request?.path === path ? null : request);
    setEditorNavigation((request) => request?.path === path ? null : request);

    if (initialPlan.deletedSecondary) {
      secondaryFileRef.current = null;
      setSecondaryFile(null);
      setSecondarySource("");
      setSecondarySavedSource("");
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
    collabPathMutationGeneration,
    invalidateFileViewStateCallbacks,
    loadFile,
    refreshProject,
    scheduleFileViewStatePersistence,
  ]);

  /**
   * Disk callbacks for a v2 workspace: initial materialization plus peer tree
   * reconciliation (create/rename/delete pulled from the catalog event stream).
   * Rename covers arbitrary path changes by composing move + rename.
   */
  const v2WorkspaceCallbacks = useCallback((lease: CollabWorkspaceLease): CollabMaterializeCallbacksV2 => ({
    writeText: (path, content, projectRoot) => {
      const generation = collabPathMutationGeneration(path);
      return collabDiskWriteQueueRef.current.run(lease, path, () => generation === collabPathMutationGeneration(path) ? invoke("write_project_file", { path, content, projectRoot }) : Promise.resolve());
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
  }), [collabPathMutationGeneration, handleRemoteCollabDeleteV2]);

  // ---- Lattice Share (Yjs v2) ----------------------------------------------
  // Room state and the whole start / join / leave / close lifecycle live in
  // `src/app/use-collab-v2-session.ts`. The call sits here, below `loadFile`
  // and `v2WorkspaceCallbacks`, because both of those bind the editor and its
  // buffers to shared documents and therefore have to stay in App.
  const {
    collabOpen,
    setCollabOpen,
    collabMode,
    setCollabMode,
    collabHost,
    collabRoom,
    setCollabRoom,
    collabInvite,
    setCollabInvite,
    collabName,
    setCollabName,
    collabProjectName,
    setCollabProjectName,
    recentProjectsV2,
    refreshRecentRooms,
    collabStatus,
    setCollabStatus,
    collabStatusDetail,
    collabPeerList,
    setCollabPeerList,
    collabPeers,
    collabFileCount,
    setCollabFileCount,
    collabRole,
    setCollabRole,
    collabRoleRef,
    collabWorkspaceGenerationRef,
    preCollabProjectRootRef,
    clearCollabLocalState,
    leaveHostShareSession,
    bindJoinedDocument,
    handleV2PermanentError,
    disconnectCollab,
    settleCollabBeforeProjectSwitch,
    mapV2Status,
    handleV2Catalog,
    publishTextToCollabV2,
    shareCreatedFileWithCollabV2,
    startCollabShare,
    copyCollabInvite,
    removeCollabPeer,
    openCollabDialog,
    forgetRecentProjectV2,
    renameRecentProjectV2,
    closeRecentProjectV2,
  } = useCollabV2Session({
    project,
    projectRef,
    projectRootRef,
    projectOperationGenerationRef,
    activeFile,
    recentProjects,
    editorCommentAuthorId,
    activeCollabVersion,
    setActiveCollabVersion,
    collabSession,
    setCollabSession,
    collabSessionRef,
    setCollabReady,
    collabV2ControllerRef,
    collabWorkspaceLeaseRef,
    collabDiskWriteQueueRef,
    collabPathMutationGeneration,
    collabDetachRef,
    enterProjectRef,
    setBusyLabel,
    startProjectTransition,
    cancelProjectTransition,
    refreshProject,
    loadFile,
    v2WorkspaceCallbacks,
  });

  const save = useCallback(async (): Promise<boolean> => {
    if (!project) return true;
    try {
      const workspaceLease = collabSession ? collabWorkspaceLeaseRef.current : null;
      const primaryPath = activeFileRef.current;
      const primarySource = sourceRef.current;
      const primarySavedSource = savedSourceRef.current;
      const secondaryPath = secondaryFileRef.current;
      const currentSecondarySource = secondarySourceRef.current;
      const currentSecondarySavedSource = secondarySavedRef.current;
      const currentPaperMarkdown = paperMarkdownRef.current;
      const currentSavedPaperMarkdown = savedPaperMarkdownRef.current;
      const currentPaperBlog = paperBlogRef.current;
      const currentSavedPaperBlog = savedPaperBlogRef.current;
      let wroteTex = false;
      let wroteBib = false;
      let wrotePaper = false;
      let wroteSemanticSource = false;
      if (!activePaper && !activeAsset && primaryPath && primarySource !== primarySavedSource) {
        const mutationGeneration = collabPathMutationGeneration(primaryPath);
        if (workspaceLease) {
          await collabDiskWriteQueueRef.current.run(workspaceLease, primaryPath, () => (
            mutationGeneration === collabPathMutationGeneration(primaryPath)
              ? invoke("write_project_file", { path: primaryPath, content: primarySource, projectRoot: workspaceLease.projectRoot })
              : Promise.resolve()
          ));
        } else {
          await invoke("write_project_file", {
            path: primaryPath,
            content: primarySource,
            projectRoot: project.root,
          });
        }
        if (mutationGeneration !== collabPathMutationGeneration(primaryPath)) return true;
        // Do NOT push the active buffer into Yjs here. It is already synced
        // character-by-character by yCollab. Re-publishing it as a full
        // delete+insert of the whole Y.Text on every autosave collapses remote
        // carets and bounces recompiles between peers (the "cursors freeze /
        // PDF re-renders forever" bug). The disk write + savedSource are all the
        // active file needs; non-active buffers below still push explicitly.
        savedSourceRef.current = primarySource;
        setSavedSource(primarySource);
        if (activeCollabVersion === 2) await collabV2ControllerRef.current?.settled();
        await markDiskMtime(primaryPath);
        wroteTex = wroteTex || primaryPath.endsWith(".tex");
        wroteBib = wroteBib || primaryPath === project.manifest.primaryBibliography;
        wroteSemanticSource = /\.(?:md|mdx|tex)$/i.test(primaryPath);
      }
      if (secondaryPath && currentSecondarySource !== currentSecondarySavedSource) {
        const mutationGeneration = collabPathMutationGeneration(secondaryPath);
        // Sideload: saving must not steal the session's active file (and its
        // editor binding / awareness path) from the primary buffer.
        const published = await publishTextToCollabV2(
          secondaryPath,
          currentSecondarySource,
          mutationGeneration,
        );
        if (!published && mutationGeneration === collabPathMutationGeneration(secondaryPath)) {
          await invoke("write_project_file", {
            path: secondaryPath,
            content: currentSecondarySource,
            projectRoot: project.root,
          });
        }
        if (mutationGeneration !== collabPathMutationGeneration(secondaryPath)) return true;
        // The project-transition late-edit check runs in the same async turn
        // as this save, before React is guaranteed to commit the state setter.
        secondarySavedRef.current = currentSecondarySource;
        setSecondarySavedSource(currentSecondarySource);
        wroteTex = wroteTex || secondaryPath.endsWith(".tex");
        wroteBib = wroteBib || secondaryPath === project.manifest.primaryBibliography;
        wroteSemanticSource = wroteSemanticSource || /\.(?:md|mdx|tex)$/i.test(secondaryPath);
      }
      if (activePaper && currentPaperMarkdown !== currentSavedPaperMarkdown) {
        const path = `.research/papers/${activePaper.arxivId}/paper.md`;
        const published = await publishTextToCollabV2(path, currentPaperMarkdown);
        if (!published) {
          await invoke("write_project_file", {
            path,
            content: currentPaperMarkdown,
            projectRoot: project.root,
          });
        }
        savedPaperMarkdownRef.current = currentPaperMarkdown;
        setSavedPaperMarkdown(currentPaperMarkdown);
        wrotePaper = true;
        wroteSemanticSource = true;
      }
      if (activePaper && currentPaperBlog !== null && currentPaperBlog !== currentSavedPaperBlog) {
        const path = `.research/papers/${activePaper.arxivId}/blog.md`;
        const published = await publishTextToCollabV2(path, currentPaperBlog);
        if (!published) {
          await invoke("write_project_file", {
            path,
            content: currentPaperBlog,
            projectRoot: project.root,
          });
        }
        savedPaperBlogRef.current = currentPaperBlog;
        setSavedPaperBlog(currentPaperBlog);
        wrotePaper = true;
        wroteSemanticSource = true;
      }
      if (
        !wroteTex
        && !wroteBib
        && !wrotePaper
        && primarySource === primarySavedSource
        && currentSecondarySource === currentSecondarySavedSource
      ) {
        return true;
      }
      setSaveGeneration((generation) => generation + 1);
      // Saving must only wait for durable writes. The derived sidebars are
      // useful, but making file switches and builds wait on six independent
      // project scans turned every save into a visible pause.
      refreshAfterSave(project.root, wroteTex, wroteBib);
      if (wroteSemanticSource) requestSemanticReindex();
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
    activeFile,
    activeAsset,
    activePaper,
    activeCollabVersion,
    collabPathMutationGeneration,
    collabSession,
    markDiskMtime,
    project,
    publishTextToCollabV2,
    refreshAfterSave,
    requestSemanticReindex,
  ]);
  useLayoutEffect(() => {
    saveBeforeProjectTransitionRef.current = save;
  }, [save]);

  useLayoutEffect(() => {
    hasLateProjectTransitionEditRef.current = () => {
      if (visualMarkdownFlushRef.current?.() === false) return true;
      const primaryDirty = activePaper
        ? paperMarkdownRef.current !== savedPaperMarkdownRef.current
          || paperBlogRef.current !== savedPaperBlogRef.current
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
  const secondaryMtimeRef = useRef<number | null>(null);

  useEffect(() => {
    if (!project || !activeFile || activeAsset || activePaper) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void (async () => {
        try {
          const stat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", {
            path: activeFile,
          });
          if (cancelled || !stat.exists) return;
          if (diskMtimeRef.current == null) {
            diskMtimeRef.current = stat.mtimeMs;
          } else if (stat.mtimeMs > diskMtimeRef.current) {
            diskMtimeRef.current = stat.mtimeMs;
            if (sourceRef.current === savedSourceRef.current) {
              const content = await invoke<string>("read_project_file", { path: activeFile });
              if (!cancelled && content !== sourceRef.current) {
                sourceRef.current = content;
                savedSourceRef.current = content;
                setSource(content);
                setSavedSource(content);
                if (buildPreferences.autoBuildMode === "automatic") {
                  void compileRef.current();
                }
              }
            }
          }
          if (secondaryFile) {
            const secondaryStat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", {
              path: secondaryFile,
            });
            if (!secondaryStat.exists) return;
            if (secondaryMtimeRef.current == null) {
              secondaryMtimeRef.current = secondaryStat.mtimeMs;
              return;
            }
            if (secondaryStat.mtimeMs <= secondaryMtimeRef.current) return;
            secondaryMtimeRef.current = secondaryStat.mtimeMs;
            if (secondarySourceRef.current !== secondarySavedRef.current) return;
            const content = await invoke<string>("read_project_file", { path: secondaryFile });
            if (cancelled || content === secondarySourceRef.current) return;
            secondarySourceRef.current = content;
            secondarySavedRef.current = content;
            setSecondarySource(content);
            setSecondarySavedSource(content);
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
  }, [activeAsset, activeFile, activePaper, buildPreferences.autoBuildMode, project, secondaryFile]);

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
    const keepDocumentMode = (mode: CanvasMode): CanvasMode => (
      mode === "pdf" || mode === "asset" ? "split" : mode
    );
    const requestedPane = targetPane ?? focusedPane;
    const secondaryFocused = (canvasMode === "dual" || canvasMode === "columns")
      && requestedPane === "secondary"
      && !activePaper
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
      if (activeCollabVersion === 2) {
        try {
          if (secondaryFile && secondarySource !== secondarySavedSource && !(await save())) return;
          if (!isLatestSecondaryLoad()) return;
          const controller = collabV2ControllerRef.current;
          if (!controller?.hasTextPath(path)) throw new Error(`${path} is not a v2 text file`);
          // sideload: the yCollab binding belongs to the primary pane. Letting
          // this open activate would repoint activePath at the secondary file,
          // unbind the primary editor, and silently stop syncing its keystrokes
          // (the debounced publishTextToCollabV2 pass covers this pane instead).
          const ytext = await controller.openPath(path, "secondary", { sideload: true });
          if (!isLatestSecondaryLoad()) return;
          const content = ytext.toString();
          setSecondaryFile(path);
          setSecondarySource(content);
          setSecondarySavedSource(content);
          setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
          setFocusedPane("secondary");
          setError(null);
          // Same commit as the content, like the plain read below: a jump asked
          // for afterwards paints the file at its top for a frame first.
          if (line) {
            setEditorNavigation({ path, line, id: crypto.randomUUID() });
            pushNavigation(path, line);
          } else {
            pushNavigation(path, 1);
          }
        } catch (reason) {
          if (isLatestSecondaryLoad()) setError(toMessage(reason));
        }
        return;
      }
      if (path === secondaryFile) {
        setFocusedPane("secondary");
        if (line) {
          setEditorNavigation({ path, line, id: crypto.randomUUID() });
          pushNavigation(path, line);
        }
        return;
      }
      if (secondaryFile && secondarySource !== secondarySavedSource) {
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
        const content = await invoke<string>("read_project_file", { path, projectRoot });
        if (!isLatestSecondaryLoad()) return;
        setSecondaryFile(path);
        setSecondarySource(content);
        setSecondarySavedSource(content);
        setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
        setFocusedPane("secondary");
        setError(null);
        if (line) {
          setEditorNavigation({ path, line, id: crypto.randomUUID() });
          pushNavigation(path, line);
        } else {
          pushNavigation(path, 1);
        }
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
      if (line) {
        setEditorNavigation({ path, line, id: crypto.randomUUID() });
        setCanvasMode(keepDocumentMode);
        pushNavigation(path, line);
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
        paperMarkdownRef.current !== savedPaperMarkdownRef.current
        || paperBlogRef.current !== savedPaperBlogRef.current
      ));
    const targetAliasesDirtyPaper = Boolean(activePaper) && (
      paperMarkdownRef.current !== savedPaperMarkdownRef.current
      || paperBlogRef.current !== savedPaperBlogRef.current
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
      navigateToLine: line,
    });
    clearOpening();
    if (!applied) return;
    recordNavigationTiming("file", path, switchStartedAt, {
      openingPaintMs,
      flushMs,
      saveAndReadMs: performance.now() - contentLoadStartedAt,
    });
    setFocusedPane("primary");
    if (line) {
      // The jump itself rode the load's commit; this only widens a
      // preview-only surface so the editor it lands in is on screen.
      setCanvasMode(keepDocumentMode);
      pushNavigation(path, line);
    } else {
      pushNavigation(path, 1);
    }
  }, [
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
        setEditorNavigation({ path, line: location.line, id: crypto.randomUUID() });
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
      setEditorNavigation({ path, line: openedLocation.line, id: crypto.randomUUID() });
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
  }, [
    dualPreviewPanes.primary,
    dualPreviewPanes.secondary,
    openProjectFile,
    secondaryAsset,
    secondaryFile,
  ]);

  const installTexDependency = useCallback((missingFile: string) => {
    const trace = logAction("LaTeX setup", "Install missing package", missingFile);
    void invoke("start_tex_dependency_install", { missingFile })
      .then(() => trace.ok("Package installer opened", {
        detail: "Follow the Terminal steps, then Build again.",
      }))
      .catch((reason) => trace.fail(reason));
  }, []);

  const relayAgentCompileResults = useCallback((
    associations: Array<{ threadId: string; turnId: string; checkpointRef: string }>,
    result: BuildResult | null,
  ) => {
    const diagnostics = result?.diagnostics ?? [];
    for (const association of associations) {
      const rootDocument = result?.rootDocument
        ? synaraProjectRelativeFilePath(result.rootDocument, projectRef.current?.root)
        : null;
      const message = parseAgentCompileResultMessage({
        type: LATTICE_AGENT_COMPILE_RESULT,
        version: 1,
        ...association,
        compiledAt: new Date().toISOString(),
        success: result?.success ?? false,
        durationMs: result?.durationMs ?? null,
        rootDocument,
        diagnostics: {
          errors: diagnostics.filter((item) => item.level === "error").length,
          warnings: diagnostics.filter((item) => item.level === "warning").length,
        },
      } satisfies AgentCompileResultMessage);
      if (message) postSynaraMessage(message);
    }
  }, [postSynaraMessage]);

  const runBuild = useCallback(async function runBuild(
    force = false,
    options?: {
      immediatePreview?: boolean;
      requested?: boolean;
      sound?: boolean;
      consumeAgentAssociations?: boolean;
    },
  ) {
    // A project with no LaTeX document has nothing to compile. Autosave, a
    // synctex jump and opening the project all reach here, and each of them
    // turned a folder of Markdown notes into a red "Build failed" the reader
    // never asked for. Someone pressing Build still gets told what to add.
    // A compilable .tex open in the editor overrides the empty manifest: the
    // backend adopts it as the root document (Overleaf's rule), so a folder
    // of notes that just gained its first real document builds on the spot.
    const activeLooksCompilable = activeFileRef.current.toLowerCase().endsWith(".tex")
      && sourceRef.current.includes("\\documentclass");
    if (!projectRef.current?.manifest.rootDocuments.length && !activeLooksCompilable) {
      if (options?.consumeAgentAssociations) {
        const associations = [...pendingAgentCompileResultsRef.current.values()];
        pendingAgentCompileResultsRef.current.clear();
        relayAgentCompileResults(associations, null);
      }
      if (options?.requested) {
        setError(
          "This project has no LaTeX document to build yet. Add a .tex file, or set one as the root document in project settings.",
          "Build",
        );
      }
      return;
    }
    if (buildingRef.current) {
      queuedBuildForceRef.current = (queuedBuildForceRef.current ?? false) || force;
      queuedBuildSoundRef.current = queuedBuildSoundRef.current || options?.sound === true;
      queuedAgentCompileBuildRef.current = queuedAgentCompileBuildRef.current
        || options?.consumeAgentAssociations === true;
      return;
    }
    buildingRef.current = true;
    setBuilding(true);
    // One action name for both variants, so a clean rebuild that succeeds still
    // retracts the ordinary build's failure toast; "clean" lives in the detail.
    const trace = logAction("Build", "Build", force ? "clean rebuild" : undefined);
    let buildScope: {
      operationGeneration: number;
      previewGeneration: number;
      projectRoot: string;
    } | null = null;
    const scopeIsCurrent = () => Boolean(buildScope
      && projectOperationGenerationRef.current === buildScope.operationGeneration
      && previewGenerationRef.current === buildScope.previewGeneration
      && projectRef.current?.root === buildScope.projectRoot);
    let shouldPlayCompletionSound = options?.sound === true;
    let shouldConsumeAgentAssociations = options?.consumeAgentAssociations === true;
    let completionSound: "build-succeeded" | "build-failed" | null = null;
    queuedBuildSoundRef.current = false;
    queuedAgentCompileBuildRef.current = false;
    try {
      let currentForce = force;
      const takeQueuedBuild = () => {
        const queuedForce = queuedBuildForceRef.current;
        if (queuedForce === null) return false;
        currentForce = queuedForce;
        shouldPlayCompletionSound = shouldPlayCompletionSound || queuedBuildSoundRef.current;
        shouldConsumeAgentAssociations = queuedAgentCompileBuildRef.current;
        queuedBuildSoundRef.current = false;
        queuedAgentCompileBuildRef.current = false;
        return true;
      };
      do {
        queuedBuildForceRef.current = null;
        // Associate only work present at the start of this pass. A checkpoint
        // arriving during an in-flight build remains pending for the queued
        // pass, rather than being credited to stale output.
        const agentCompileAssociations = shouldConsumeAgentAssociations
          ? [...pendingAgentCompileResultsRef.current.values()]
          : [];
        if (shouldConsumeAgentAssociations) pendingAgentCompileResultsRef.current.clear();
        const immediatePreview = options?.immediatePreview ?? currentForce;
        const previewGeneration = previewGenerationRef.current;
        const operationGeneration = projectOperationGenerationRef.current;
        const projectRoot = projectRef.current?.root;
        if (!projectRoot) continue;
        buildScope = { operationGeneration, previewGeneration, projectRoot };
        const compiledSource = sourceRef.current;
        const compiledSecondarySource = secondarySourceRef.current;
        // The open file rides along so the backend can re-target the build on
        // it when it is a compilable root — recomputed each pass because a
        // queued rebuild may run after the editor moved to another document.
        const documentPath = activeFileRef.current.toLowerCase().endsWith(".tex")
          ? activeFileRef.current
          : null;
        let result: BuildResult;
        try {
          result = await invoke<BuildResult>("build_project", { force: currentForce, projectRoot, documentPath });
        } catch (reason) {
          if (!scopeIsCurrent()) continue;
          relayAgentCompileResults(agentCompileAssociations, null);
          throw reason;
        }
        if (!scopeIsCurrent()) continue;
        relayAgentCompileResults(agentCompileAssociations, result);
        let pdfBytes: ArrayBuffer | null = null;
        if (result.hasPdf) {
          try {
            pdfBytes = await invoke<ArrayBuffer>("read_compiled_pdf", { projectRoot });
          } catch (reason) {
            if (!scopeIsCurrent()) continue;
            throw reason;
          }
          if (!scopeIsCurrent()) continue;
        }
        setBuild(result);
        // The backend may have adopted the open file as the manifest default
        // root (Overleaf's rule). Mirror that into local state so the outline
        // and the next build's guard agree without re-reading the project.
        if (result.rootDocument) {
          setProject((current) => {
            if (!current || current.root !== projectRoot) return current;
            const documents = current.manifest.rootDocuments;
            if (documents.some((document) => document.isDefault && document.path === result.rootDocument)) {
              return current;
            }
            const nextDocuments = documents.map((document) => (
              { ...document, isDefault: document.path === result.rootDocument }
            ));
            if (!documents.some((document) => document.path === result.rootDocument)) {
              const stem = result.rootDocument.split("/").pop()?.replace(/\.tex$/i, "");
              nextDocuments.push({
                path: result.rootDocument,
                name: stem || result.rootDocument,
                isDefault: true,
              });
            }
            return { ...current, manifest: { ...current.manifest, rootDocuments: nextDocuments } };
          });
        }
        setDiagnosticBuildSource(compiledSource);
        setDiagnosticBuildSecondarySource(compiledSecondarySource);
        // Reopening the panel is for news. Autosave rebuilds after every pause
        // in typing, and reopening unconditionally meant a warning the writer
        // had chosen to live with returned seconds after they dismissed it, for
        // as long as they kept writing.
        const nextDiagnostics = diagnosticsFingerprint(result.diagnostics);
        setDiagnosticsDismissed(nextDiagnostics === dismissedDiagnosticsRef.current);
        setDiagnosticsExpanded(!result.success || result.diagnostics.some((item) => item.level === "error"));
        if (pdfBytes) {
          // LaTeX rewrites PDF metadata on every compile, so bytes almost always
          // change. Debounce preview updates for autosave compiles so pdf.js is
          // not destroyed mid-load on every keystroke pause.
          pendingPreviewPdfRef.current = pdfBytes;
          if (pdfPreviewTimerRef.current) window.clearTimeout(pdfPreviewTimerRef.current);
          const applyPreview = () => {
            pdfPreviewTimerRef.current = null;
            if (previewGeneration !== previewGenerationRef.current) return;
            const bytes = pendingPreviewPdfRef.current;
            if (!bytes) return;
            const fingerprint = pdfBytesFingerprint(bytes);
            pendingPreviewPdfRef.current = null;
            if (fingerprint === pdfFingerprintRef.current) return;
            pdfFingerprintRef.current = fingerprint;
            const nextUrl = pdfBytesToObjectUrl(bytes);
            displayedPdfBytesRef.current = bytes;
            setPdfUrl((previous) => {
              if (previous) URL.revokeObjectURL(previous);
              return nextUrl;
            });
          };
          // The wait exists so a slow pdf.js load is not torn down by the next
          // rebuild while someone is still typing. Once they have stopped —
          // the buffer matches what is on disk — there is nothing left to wait
          // for, and waiting anyway is just the PDF lagging behind the editor.
          const stillTyping = sourceRef.current !== savedSourceRef.current;
          if (immediatePreview || !stillTyping) applyPreview();
          else pdfPreviewTimerRef.current = window.setTimeout(applyPreview, 1_200);
        }
        if (!result.success) {
          const missingDependencyDiagnostic = result.diagnostics
            .find((item) => missingTexDependencyFile(item.message));
          const firstError = missingDependencyDiagnostic
            ?? result.diagnostics.find((item) => item.level === "error")
            ?? result.diagnostics[0]
            ?? null;
          const missingDependency = missingDependencyDiagnostic
            ? missingTexDependencyFile(missingDependencyDiagnostic.message)
            : null;
          const navigationError = result.diagnostics.find((item) => (
            item.level === "error" && Boolean(item.file || item.line)
          )) ?? firstError;
          if (navigationError) void openCompileDiagnosticRef.current(navigationError);
          const failureText = [
            result.log,
            ...result.diagnostics.map((item) => item.message),
          ].join("\n");
          trace.fail("LaTeX compilation failed.", {
            detail: firstError?.message ?? "",
            // The full log is what a bug report needs; the toast only shows the
            // first diagnostic.
            copyText: failureText,
            primaryAction: missingDependency ? {
              label: "Install missing package",
              onClick: () => installTexDependency(missingDependency),
            } : undefined,
          });
          completionSound = "build-failed";
          if (isMissingTexBuildError(failureText)) {
            doctorGenerationRef.current += 1;
            setDoctorReport(null);
            setDoctorBusy(false);
            setTexSetupOpen(true);
          }
        } else {
          // A rebuild that succeeds retracts the previous failure instead of
          // leaving it on screen to time out on its own.
          trace.clear();
          trace.note(`Build succeeded in ${(result.durationMs / 1000).toFixed(1)}s`);
          completionSound = "build-succeeded";
        }
      } while (takeQueuedBuild());
    } catch (reason) {
      if (scopeIsCurrent()) {
        const message = toMessage(reason);
        trace.fail(reason);
        completionSound = "build-failed";
        if (isMissingTexBuildError(message)) {
          doctorGenerationRef.current += 1;
          setDoctorReport(null);
          setDoctorBusy(false);
          setTexSetupOpen(true);
        }
      }
    } finally {
      const queuedForce = queuedBuildForceRef.current;
      const queuedBuild = queuedForce === null ? null : {
        force: queuedForce,
        sound: queuedBuildSoundRef.current,
        consumeAgentAssociations: queuedAgentCompileBuildRef.current,
      };
      queuedBuildForceRef.current = null;
      queuedBuildSoundRef.current = false;
      queuedAgentCompileBuildRef.current = false;
      buildingRef.current = false;
      setBuilding(false);
      if (shouldPlayCompletionSound && completionSound && scopeIsCurrent()) {
        playInterfaceSound(completionSound);
      }
      // A backend rejection skips the loop's takeQueuedBuild() condition. Start
      // the captured pass only after releasing the in-flight lock, and only if
      // its immutable project scope still owns the active root.
      if (queuedBuild && scopeIsCurrent()) {
        void runBuild(queuedBuild.force, {
          immediatePreview: options?.immediatePreview ?? queuedBuild.force,
          sound: queuedBuild.sound,
          consumeAgentAssociations: queuedBuild.consumeAgentAssociations,
        });
      }
    }
  }, [installTexDependency, relayAgentCompileResults]);

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

  // ---- Overleaf bridge -----------------------------------------------------
  // Link discovery, syncing, the realtime channel and everything that rides it
  // (presence, chat, comment threads, tracked changes) live in
  // `src/app/use-overleaf-workspace.ts`. It has to be called here rather than
  // beside the rest of App's state: every sync path goes through save, compile,
  // loadFile and refreshProject, all of which are declared above.
  const {
    overleafLink,
    overleafSyncing,
    overleafSyncMode,
    setOverleafSyncMode,
    overleafRemoteDelete,
    setOverleafRemoteDelete,
    overleafRemoteChanges,
    setOverleafRemoteChanges,
    overleafPickerOpen,
    setOverleafPickerOpen,
    overleafReviewOpen,
    setOverleafReviewOpen,
    overleafCollabOpen,
    setOverleafCollabOpen,
    overleafCollabTab,
    setOverleafCollabTab,
    conflictPath,
    setConflictPath,
    overleafSyncRef,
    refreshOverleafLink,
    runOverleafSync,
    settleRemoteDeletes,
    openCurrentOverleafProject,
    jumpToOverleafPeer,
    overleafRealtime,
    overleafPresence,
    overleafChat,
    overleafComments,
    overleafCommentsRef,
    overleafTrackChanges,
    overleafDocPaths,
    overleafEditorComments,
    overleafActiveCursors,
  } = useOverleafWorkspace({
    project,
    projectRef,
    projectOperationGenerationRef,
    activeFile,
    activeFileRef,
    activePaper,
    activeAsset,
    source,
    sourceRef,
    savedSourceRef,
    setSource,
    setSavedSource,
    setViewRestore,
    viewStateRef,
    editorPosition,
    editorPositionRef,
    build,
    saveGeneration,
    collabSession,
    collabName,
    publishTextToCollabV2,
    save,
    compile,
    loadFile,
    refreshProject,
    openProjectFile,
    overleafSyncingRef,
    overleafSyncSettledRef,
    resolveOverleafSyncRef,
  });

  /** Both kinds of comment, as the editor and the panel want them. */
  const allEditorComments = useMemo(
    () => [...editorComments, ...overleafEditorComments],
    [editorComments, overleafEditorComments],
  );


  const abortBuild = useCallback(async () => {
    if (!buildingRef.current) return;
    try {
      await invoke<boolean>("abort_build");
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, []);

  const cleanProject = useCallback(async () => {
    if (!project || cleaning || building) return;
    if (!await confirmAction("Delete LaTeX auxiliary files (`.aux`, `.log`, `.bbl`, …) from this project?")) return;
    setCleaning(true);
    try {
      await invoke("clean_project");
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setCleaning(false);
    }
  }, [building, cleaning, project]);

  const cleanAndRebuild = useCallback(async () => {
    if (!project || cleaning) return;
    // The active build owns the backend until it settles. Preserve the clean
    // rebuild intent in its queue rather than cleaning files out from under it.
    if (buildingRef.current) {
      await runBuild(true, { requested: true, sound: true });
      return;
    }
    if (!await confirmAction("Delete auxiliary files and rebuild the PDF?")) return;
    setCleaning(true);
    try {
      await invoke("clean_project");
      setCleaning(false);
      await runBuild(true, { requested: true, sound: true });
    } catch (reason) {
      setError(toMessage(reason));
      setCleaning(false);
    }
  }, [cleaning, project, runBuild]);

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
    forwardSyncPosition,
    locatingPdf,
    pdfUrl,
    runBuild,
    save,
    savedSource,
    secondaryFile,
    secondarySavedSource,
    secondarySource,
    source,
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
      setDiagnosticsExpanded(true);
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeFile, openProjectFile, project]);
  useEffect(() => {
    openCompileDiagnosticRef.current = openCompileDiagnostic;
  }, [openCompileDiagnostic]);

  const cycleCompileDiagnostic = useCallback((direction: 1 | -1) => {
    const diagnostics = build?.diagnostics ?? [];
    if (!diagnostics.length) return;
    const next = (diagnosticCursor.current + direction + diagnostics.length * 10) % diagnostics.length;
    diagnosticCursor.current = next;
    void openCompileDiagnostic(diagnostics[next]);
  }, [build?.diagnostics, openCompileDiagnostic]);

  useEffect(() => {
    diagnosticCursor.current = 0;
  }, [build]);

  const saveAndCompileAutomatically = useCallback(async () => {
    if (automaticBuildPending.current) return;
    automaticBuildPending.current = true;
    try {
      if (await save()) await runBuild(false, { immediatePreview: false });
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
      flushFileViewStates();
      invalidateFileViewStateCallbacks();
      viewStateRef.current = new Map(Object.entries(loadFileViewStates(snapshot.root)));
      removedFileViewStatePathsRef.current = [];
      projectRef.current = snapshot;
      projectBeforeTransitionRef.current = null;
      setProject(snapshot);
      rememberProject(snapshot);
      setProjectMenuOpen(false);
      setBuild(null);
      setSelection("");
      setSelectionSource(null);
      selectionSourceRef.current = null;
      dismissedSelectionRef.current = null;
      setTexlabDiagnostics([]);
      setEditorComments([]);
      setEditorCommentsOpen(false);
      setActiveEditorCommentId(null);
      // A pinned turn review belongs to the outgoing project's thread; keeping
      // it would bind the drawer to a foreign thread after the switch.
      setAgentTurnReview(null);
      setDiskTodos([]);
      setTodosOpen(false);
      setActivePaper(null);
      setActiveAsset(null);
      setSecondaryAsset(null);
      setPaperMarkdown("");
      setSavedPaperMarkdown("");
      setPaperBlog(null);
      setSavedPaperBlog(null);
      setSecondaryFile(null);
      setSecondarySource("");
      setSecondarySavedSource("");
      setFocusedPane("primary");
      setOpenTabs([]);
      setCanvasMode("split");
      htmlViewModesRef.current.clear();
      documentModeRef.current = "split";
      // Invalidate any in-flight preview from the previous project, then clear
      // UI state *before* starting the first build (starting first used to race
      // applyPreview and wipe a just-loaded PDF → endless “Rendering PDF…”).
      previewGenerationRef.current += 1;
      pdfFingerprintRef.current = null;
      displayedPdfBytesRef.current = null;
      pendingPreviewPdfRef.current = null;
      if (pdfPreviewTimerRef.current) {
        window.clearTimeout(pdfPreviewTimerRef.current);
        pdfPreviewTimerRef.current = null;
      }
      setPdfUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return null;
      });
      // A project usually already has a compiled PDF on disk. Show it while
      // latexmk checks for changes instead of leaving the preview blank until
      // the initial build finishes. Shared workspaces are empty scaffolds until
      // synchronization, so they must wait for their post-sync build.
      if (!options?.skipCollabLifecycle) {
        const initialPreviewGeneration = previewGenerationRef.current;
        void invoke<ArrayBuffer>("read_compiled_pdf", { projectRoot: snapshot.root })
          .then((pdfBytes) => {
            if (
              initialPreviewGeneration !== previewGenerationRef.current
              || projectRef.current?.root !== snapshot.root
              || pdfFingerprintRef.current !== null
            ) return;
            const fingerprint = pdfBytesFingerprint(pdfBytes);
            const nextUrl = pdfBytesToObjectUrl(pdfBytes);
            pdfFingerprintRef.current = fingerprint;
            displayedPdfBytesRef.current = pdfBytes;
            setPdfUrl((previous) => {
              if (
                initialPreviewGeneration !== previewGenerationRef.current
                || projectRef.current?.root !== snapshot.root
                || pdfFingerprintRef.current !== fingerprint
              ) {
                URL.revokeObjectURL(nextUrl);
                return previous;
              }
              if (previous) URL.revokeObjectURL(previous);
              return nextUrl;
            });
          })
          .catch(() => {
            // A new or cleaned project has no cached PDF; the initial build
            // remains the source of its first preview.
          });
      }
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
      const [nextPapers, nextCitationKeys, nextCitations, nextReferences] = await Promise.all([
        invoke<PaperSummary[]>("list_papers"),
        invoke<string[]>("list_citation_keys"),
        invoke<CitationInfo[]>("list_citations"),
        invoke<ReferenceInfo[]>("list_references"),
      ]);
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
          setSecondaryFile(secondaryFile);
          setSecondarySource(content);
          setSecondarySavedSource(content);
        } catch {
          if (
            ownsProjectRestore()
            && secondaryFileLoadGenerationRef.current === secondaryRestoreGeneration
          ) {
            setSecondaryFile(null);
            setSecondarySource("");
            setSecondarySavedSource("");
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
      setPapers(nextPapers);
      setCitationKeys(nextCitationKeys);
      setCitations(nextCitations);
      setReferences(nextReferences ?? []);
      setOpenTabs(restoredTabs);
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
      setHistory(await invoke<HistoryItem[]>("list_history"));
      try {
        setEditorComments(await invoke<EditorComment[]>("list_editor_comments"));
      } catch {
        setEditorComments([]);
      }
      try {
        setDiskTodos(await invoke<TodoHit[]>("list_todos"));
      } catch {
        setDiskTodos([]);
      }
      try {
        setProjectWordCount(await invoke<WordCount>("count_project_words"));
      } catch {
        setProjectWordCount(null);
      }
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
      beginProjectTransition,
      flushFileViewStates,
      invalidateFileViewStateCallbacks,
      loadFile,
      refreshUnusedSymbols,
      rememberProject,
      runBuild,
      settleCollabBeforeProjectSwitch,
    ],
  );
  enterProjectRef.current = enterProject;

  // On launch, reopen the project you had open last. Falls back to the welcome
  // screen if that folder was moved or deleted.
  //
  // Resolved by the boot effect below with whether the backend designated an
  // initial project. The auto-reopen must wait for that answer: both flows
  // funnel through enterProject, and whichever claims a project generation
  // last wins — since startProjectTransition became async, the recent-project
  // reopen could land after the backend's choice and silently clobber it.
  const [initialProjectProbe] = useState(() => {
    let resolve!: (has: boolean) => void;
    const promise = new Promise<boolean>((r) => { resolve = r; });
    return { promise, resolve };
  });
  const didAutoReopenRef = useRef(false);
  useEffect(() => {
    if (didAutoReopenRef.current) return;
    didAutoReopenRef.current = true;
    const mostRecent = loadRecentProjects()[0]?.path;
    if (!mostRecent) return;
    void (async () => {
      try {
        if (await initialProjectProbe.promise) return;
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
  }, [cancelProjectTransition, enterProject, initialProjectProbe, runBuild, startProjectTransition]);

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
  }, [
    cancelProjectTransition,
    enterProject,
    openProjectWindow,
    project?.root,
    save,
    startProjectTransition,
  ]);

  const createProject = useCallback(async () => {
    if (!projectName.trim()) {
      setCreateError("Enter a project name.");
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
        name: projectName,
        venue: projectVenue,
      });
      setCreateError(null);
      setCreateOpen(false);
      await revealNewProject(snapshot.root);
    } catch (reason) {
      if (openHere) cancelProjectTransition();
      setCreateError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [
    cancelProjectTransition,
    project?.root,
    projectName,
    projectVenue,
    revealNewProject,
    save,
    startProjectTransition,
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
    if (!project || tutorialActive || autoTutorialAttemptedRef.current || hasSeenTutorial()) return;
    void openTutorialProject();
  }, [openTutorialProject, project, tutorialActive]);

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
  }, [
    cancelProjectTransition,
    enterProject,
    openProjectWindow,
    project?.root,
    save,
    startProjectTransition,
  ]);

  useEffect(() => {
    let active = true;
    // Boot once. Depending on `enterProject` re-ran this whenever that callback
    // identity churned (after every build/load), which cleared the PDF and
    // restarted compile → endless “Rendering PDF…”.
    void invoke<ProjectSnapshot | null>("initial_project")
      .then(async (snapshot) => {
        initialProjectProbe.resolve(Boolean(snapshot));
        if (!active || !snapshot) return;
        await enterProjectRef.current?.(snapshot);
        if (!active) return;
        // Taken after the project is in, because acting on it needs the
        // window to already be showing the project it refers to. The backend
        // hands it over once, so a reload of this window will not rejoin.
        const raw = await invoke<string | null>("take_pending_window_action");
        if (!active || !raw) return;
        const action = JSON.parse(raw) as PendingWindowAction;
        if (action.kind === "join-collab-v2") {
          const record = loadCollabProjectsV2().find(
            (item) => item.host === action.host
              && item.projectInstanceId === action.projectInstanceId,
          );
          if (record) pendingJoinRef.current?.(record);
        }
      })
      .catch((reason) => {
        initialProjectProbe.resolve(false);
        if (active) setError(toMessage(reason));
      });
    return () => {
      active = false;
    };
    // initialProjectProbe is a stable useState value — listed to satisfy the
    // lint without changing the boot-once behavior.
  }, [initialProjectProbe]);

  useEffect(() => {
    let active = true;
    // Idle-deferred: run_doctor shells out to probe the TeX toolchain, and
    // nothing needs its report during first paint. The timeout keeps the
    // setup wizard appearing within a few seconds on a missing toolchain.
    const runDoctor = () => {
      const generation = ++doctorGenerationRef.current;
      void invoke<DoctorReport>("run_doctor")
        .then((report) => {
          if (!active || generation !== doctorGenerationRef.current) return;
          setDoctorReport(report);
          if (isRequiredSetupMissing(report)) {
            setTexSetupOpen(true);
          }
        })
        .catch(() => {
          // Tests and incomplete environments may not expose doctor.
        });
    };
    let idle: number | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if ("requestIdleCallback" in window) {
      idle = window.requestIdleCallback(runDoctor, { timeout: 4_000 });
    } else {
      timer = globalThis.setTimeout(runDoctor, 1_000);
    }
    return () => {
      active = false;
      if (idle != null && "cancelIdleCallback" in window) window.cancelIdleCallback(idle);
      if (timer != null) globalThis.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(BUILD_PREFERENCES_KEY, JSON.stringify(buildPreferences));
    } catch {
      // Build preferences still apply for the current session without storage.
    }
  }, [buildPreferences]);

  useEffect(() => {
    const appWindow = getCurrentWindowSafely();
    if (!appWindow) return;
    if (typeof appWindow.isFullscreen !== "function" || typeof appWindow.onResized !== "function") return;
    let active = true;
    let stopListening: (() => void) | undefined;
    let refreshTimer: number | undefined;
    const refreshNow = () => {
      void appWindow.isFullscreen().then((value) => active && setIsFullscreen(value));
    };
    const scheduleRefresh = () => {
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      // Native resize events can arrive much faster than WebKit presents
      // frames. A trailing check avoids queueing an IPC round trip per pixel.
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        refreshNow();
      }, 80);
    };
    refreshNow();
    void appWindow.onResized(scheduleRefresh).then((unlisten) => {
      if (active) stopListening = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    if (browserHosted || isFullscreen) return;
    let active = true;
    let stopListening: (() => void) | undefined;
    let resizeTimer: number | undefined;
    const align = () => {
      if (!active) return;
      const shell = shellRef.current;
      const titlebar = shell?.querySelector<HTMLElement>(".titlebar");
      if (!shell || !titlebar) return;
      const rect = titlebar.getBoundingClientRect();
      // WebKit reports unzoomed CSS pixels while AppKit consumes logical
      // points. Measuring the rendered titlebar and applying the live webview
      // zoom keeps the native center aligned for every interface scale.
      // Horizontally, Hide Sidebar sits at the midpoint between the green
      // traffic-light's right edge and the project *label* (not the padded
      // button box — padding made the control look biased left).
      const placeToggle = (greenRight: number) => {
        if (!active) return;
        shell.style.setProperty("--titlebar-traffic-space-width", `${greenRight}px`);
        const projectTitle = shell.querySelector<HTMLElement>(".project-title");
        if (!projectTitle) return;
        const label = projectTitle.querySelector<HTMLElement>(":scope > span") ?? projectTitle;
        const titlebarLeft = titlebar.getBoundingClientRect().left;
        const projectLeft = label.getBoundingClientRect().left - titlebarLeft;
        if (!(projectLeft > greenRight)) return;
        shell.style.setProperty("--titlebar-toggle-center", `${(greenRight + projectLeft) / 2}px`);
      };
      void invoke<number | null>("align_traffic_lights", {
        centerFromTop:
          (rect.top + rect.height / 2 - TRAFFIC_LIGHT_OPTICAL_Y_OFFSET_CSS_PX)
          * appearance.interfaceScale,
      }).then((clusterRightPoints) => {
        if (!active) return;
        const greenRight = clusterRightPoints != null && Number.isFinite(clusterRightPoints)
          ? clusterRightPoints / appearance.interfaceScale
          : 70;
        placeToggle(greenRight);
        requestAnimationFrame(() => placeToggle(greenRight));
      }).catch(() => {
        // Browser tests and non-macOS builds have no native traffic lights.
        placeToggle(70);
        requestAnimationFrame(() => placeToggle(70));
      });
    };
    const frame = window.requestAnimationFrame(align);
    const initialTimer = window.setTimeout(align, 120);
    const appWindow = getCurrentWindowSafely();
    if (appWindow && typeof appWindow.onResized === "function") {
      void appWindow.onResized(() => {
        if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
        // Wait until AppKit's live-resize layout pass has settled, then measure
        // once. Updating on every resize event makes the native buttons jitter.
        resizeTimer = window.setTimeout(align, 120);
      }).then((unlisten) => {
        if (active) stopListening = unlisten;
        else unlisten();
      });
    }
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(initialTimer);
      if (resizeTimer !== undefined) window.clearTimeout(resizeTimer);
      stopListening?.();
    };
  }, [appearance.interfaceScale, browserHosted, isFullscreen, project?.manifest.name]);

  useEffect(() => {
    const documentDirty = Boolean(!activePaper && !activeAsset && activeFile && source !== savedSource);
    if (!project || (!documentDirty && !activePaperDirty)) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const automatic = !activePaper && buildPreferences.autoBuildMode === "automatic";
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
    activeFile,
    activeAsset,
    activePaper,
    activePaperDirty,
    buildPreferences.autoBuildMode,
    paperBlog,
    paperMarkdown,
    project,
    savedPaperBlog,
    savedPaperMarkdown,
    savedSource,
    source,
  ]);

  // Dual-pane secondary buffer is not yCollab-bound; push + save while sharing.
  useEffect(() => {
    if (!project || activeCollabVersion !== 2 || !secondaryFile) return;
    if (secondarySource === secondarySavedSource) return;
    const timer = window.setTimeout(() => {
      void publishTextToCollabV2(secondaryFile, secondarySource)
        .then((published) => {
          if (published) setSecondarySavedSource(secondarySource);
        })
        .catch((reason) => setError(toMessage(reason)));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [activeCollabVersion, project, publishTextToCollabV2, secondaryFile, secondarySavedSource, secondarySource]);

  const buildWhenLeavingEditor = useCallback(() => {
    if (activePaper) {
      if (activePaperDirty || source !== savedSource) void save();
      return;
    }
    if (buildPreferences.autoBuildMode !== "automatic" || source === savedSource) return;
    void saveAndCompileAutomatically();
  }, [
    activePaper,
    activePaperDirty,
    buildPreferences.autoBuildMode,
    save,
    saveAndCompileAutomatically,
    savedSource,
    source,
  ]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save().then((saved) => {
          if (saved && !activePaper) void compile();
        });
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void chooseExisting();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activePaper, chooseExisting, compile, save]);

  const importReferenceInput = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setImporting(true);
    try {
      const result = await invoke<{
        arxivId: string;
        title: string;
        citationKey?: string;
        alreadyImported: boolean;
        fetchError?: string;
      }>("import_reference", {
        input: trimmed,
      });
      const snapshot = await refreshProject();
      await refreshHistory();
      if (collabSession && !result.alreadyImported) {
        // Bibliography is the shared paper catalog. Full-text bundles stay
        // local — collaborators fetch them when they open a paper.
        try {
          const content = await invoke<string>("read_project_file", {
            path: snapshot.manifest.primaryBibliography,
          });
          await publishTextToCollabV2(snapshot.manifest.primaryBibliography, content);
        } catch {
          // Optional sidecar / bib may be missing.
        }
      }
      // The citation lands even when the download does not (papers.rs commits
      // the bibliography before fetching), so a fetch failure is a notice on a
      // success, not an error. The converter's stderr ends with its one
      // meaningful "Error: …" line; the Papers row keeps a Download button for
      // retrying, which surfaces the full message.
      const fetchNote = result.fetchError
        ?.trim().split("\n").filter((line) => line.trim()).pop()?.replace(/^Error:\s*/, "");
      // "cite it with \cite{…}" over the old "as \cite{…}": the key's whole
      // point is being pasted into the manuscript, so the notice hands over
      // the exact command instead of assuming the reader parses BibTeX-ese.
      const citeHint = result.citationKey ? ` — cite it with \\cite{${result.citationKey}}` : "";
      setNotice(result.alreadyImported
        ? `“${result.title}” is already in Papers${citeHint}.`
        : result.arxivId
          ? result.fetchError
            ? `Added “${result.title}” to the bibliography${citeHint}. The full text could not be downloaded: ${fetchNote}`
            : `Imported “${result.title}”${citeHint}.`
          : `Added “${result.title}” to the bibliography${citeHint}. No full text to open.`);
    } catch (reason) {
      setError(toMessage(reason));
      throw reason instanceof Error ? reason : new Error(toMessage(reason));
    } finally {
      setImporting(false);
      setPaperImportStage(null);
    }
    // `collabSession` alone is not enough to keep the publish above alive: it can
    // reach state a commit before `activeCollabVersion` does, and this memo would
    // then pin the closure that answers `false` for the rest of the share (see
    // `publishTextToCollabV2`). An imported reference would reach disk here and
    // never reach the people sharing the project.
  }, [collabSession, publishTextToCollabV2, refreshHistory, refreshProject]);

  const importPaper = useCallback(async () => {
    if (!importInput.trim()) return;
    try {
      await importReferenceInput(importInput);
      setImportInput("");
    } catch {
      // Error already surfaced by importReferenceInput.
    }
  }, [importReferenceInput, importInput]);

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
      const activePaperBufferDirty = paperMarkdownRef.current !== savedPaperMarkdownRef.current
        || paperBlogRef.current !== savedPaperBlogRef.current;
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
        throw fullTextResult.status === "rejected" ? fullTextResult.reason : new Error("No readable paper content is available.");
      }
      // The old editor stayed live while save/read ran. If it changed in that
      // interval, keep it on screen for autosave instead of replacing it with
      // the Paper and dropping the late edit.
      if (flushAndCheckPrimaryDirty(activePaper ? "paper" : activeAsset ? "asset" : "file")) return null;
      setPaperMarkdown(fullText);
      setSavedPaperMarkdown(fullText);
      setPaperBlog(blog);
      setSavedPaperBlog(blog);
      setPaperView((current) => (
        current === "fulltext" && fullText
          ? "fulltext"
          : blog
            ? "blog"
            : "fulltext"
      ));
      if (!fullText && blog) setNotice("Full paper text is unavailable; showing the overview instead.");
      setActivePaper(paper);
      setActiveAsset(null);
      setFocusedPane("primary");
      setCanvasMode("pdf");
      const key = paperTabKey(paper.arxivId);
      setOpenTabs((tabs) => (tabs.includes(key) ? tabs : [...tabs, key]));
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
    activeAsset,
    activeFile,
    activePaper,
    activePaperDirty,
    cancelPreviewPrewarm,
    flushAndCheckPrimaryDirty,
    save,
    secondaryFile,
    secondarySavedSource,
    secondarySource,
  ]);

  const fetchAndOpenPaper = useCallback(async (paper: PaperSummary) => {
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
      const result = paper.arxivId
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
      setPaperImportStage(null);
    }
  }, [changePaperView, openPaper, refreshProject, tutorialActive, tutorialStep]);

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
      setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
      setActiveAsset(asset);
      setActivePaper(null);
      setPaperMarkdown("");
      setSavedPaperMarkdown("");
      setPaperBlog(null);
      setSavedPaperBlog(null);
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
    | { kind: "asset"; path: string; asset: AssetPreview };

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
    const clearSecondaryPane = () => {
      secondaryFileLoadGenerationRef.current += 1;
      secondaryFileRef.current = null;
      secondarySourceRef.current = "";
      secondarySavedRef.current = "";
      secondaryAssetRef.current = null;
      setSecondaryFile(null);
      setSecondarySource("");
      setSecondarySavedSource("");
      setSecondaryAsset(null);
    };
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
    const primarySourceContent = (): DropPaneContent | null => (
      activeFileRef.current
        ? sourceContent(activeFileRef.current, sourceRef.current, savedSourceRef.current)
        : null
    );
    const currentPanes = (): { left: DropPaneContent | null; right: DropPaneContent | null } => {
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
        if (isProjectAssetFilePath(path) || projectAssetPaths.has(path)) {
          const opening = openProjectAsset(path);
          primaryLoadGeneration = fileLoadGenerationRef.current;
          if (!(await opening) || !isCurrentDrop()) return;
        } else {
          const opening = openProjectFile(path, undefined, "primary");
          primaryLoadGeneration = fileLoadGenerationRef.current;
          await opening;
          if (!isCurrentDrop() || activeFileRef.current !== path) return;
          activeAssetRef.current = null;
          setActiveAsset(null);
          const standaloneMode = options?.preservePreview ? "pdf" : "source";
          if (isHtmlFilePath(path)) htmlViewModesRef.current.set(path, standaloneMode);
          else documentModeRef.current = standaloneMode;
          setCanvasMode(standaloneMode);
        }
        temporarilyPromotedSplitRef.current = null;
        setDualPanePreview(null);
        clearSecondaryPane();
        setFocusedPane("primary");
        return true;
      }

      if (visualMarkdownFlushRef.current?.() === false || !(await save()) || !isCurrentDrop()) return;
      if (
        zone === "right"
        && path === activeFileRef.current
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
        secondaryFileRef.current = path;
        secondarySourceRef.current = outgoingSource;
        secondarySavedRef.current = outgoingSavedSource;
        secondaryAssetRef.current = null;
        setSecondaryFile(path);
        setSecondarySource(outgoingSource);
        setSecondarySavedSource(outgoingSavedSource);
        setSecondaryAsset(null);
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
          setFocusedPane("primary");
          return;
        }
        const displaced = left;
        left = target;
        if (!right) right = displaced;
        else if (sameContent(target, right)) right = displaced;
      } else {
        if (sameContent(target, right)) {
          setFocusedPane("secondary");
          return;
        }
        const displaced = right;
        right = target;
        if (!left) left = displaced;
        else if (sameContent(target, left)) left = displaced;
      }
      if (!left || !right || sameContent(left, right)) return;

      if (left.kind === "source") {
        const opening = openProjectFile(left.path, undefined, "primary");
        primaryLoadGeneration = fileLoadGenerationRef.current;
        await opening;
        if (!isCurrentDrop() || activeFileRef.current !== left.path) return;
        activeAssetRef.current = null;
        setActiveAsset(null);
      } else {
        fileLoadGenerationRef.current += 1;
        primaryLoadGeneration = fileLoadGenerationRef.current;
        setPrimaryOpening(null);
        activeAssetRef.current = left.asset;
        setActiveAsset(left.asset);
        setActivePaper(null);
        setPaperMarkdown("");
        setSavedPaperMarkdown("");
        setPaperBlog(null);
        setSavedPaperBlog(null);
        setOpenTabs((tabs) => (tabs.includes(left.path) ? tabs : [...tabs, left.path]));
      }

      secondaryFileLoadGenerationRef.current += 1;
      if (right.kind === "source") {
        secondaryFileRef.current = right.path;
        secondarySourceRef.current = right.source;
        secondarySavedRef.current = right.savedSource;
        secondaryAssetRef.current = null;
        setSecondaryFile(right.path);
        setSecondarySource(right.source);
        setSecondarySavedSource(right.savedSource);
        setSecondaryAsset(null);
        setOpenTabs((tabs) => (tabs.includes(right.path) ? tabs : [...tabs, right.path]));
      } else {
        secondaryFileRef.current = null;
        secondarySourceRef.current = "";
        secondarySavedRef.current = "";
        secondaryAssetRef.current = right.asset;
        setSecondaryFile(null);
        setSecondarySource("");
        setSecondarySavedSource("");
        setSecondaryAsset(right.asset);
        setOpenTabs((tabs) => (tabs.includes(right.path) ? tabs : [...tabs, right.path]));
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
    activeCollabVersion,
    canvasMode,
    dualPanePreview,
    loadFile,
    openProjectAsset,
    openProjectFile,
    openTabs,
    projectAssetPaths,
    save,
  ]);
  const closeSplitView = useCallback(() => {
    if (canvasMode !== "dual" && canvasMode !== "columns") return;
    const focusedPath = focusedPane === "secondary"
      ? secondaryAsset?.path ?? secondaryFile
      : activeAsset?.path ?? activeFile;
    if (focusedPath) {
      void dropProjectPath(focusedPath, "center", {
        preservePreview: focusedPanePreview,
      });
    }
  }, [
    activeAsset?.path,
    activeFile,
    canvasMode,
    dropProjectPath,
    focusedPane,
    focusedPanePreview,
    secondaryAsset?.path,
    secondaryFile,
  ]);

  const closeEditorTab = useCallback(async (path: string) => {
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
      const primaryPath = activeAsset?.path ?? activeFile;
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
        (paperMarkdownRef.current !== savedPaperMarkdownRef.current
          || paperBlogRef.current !== savedPaperBlogRef.current)
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
        setActivePaper(null);
        setPaperMarkdown("");
        setSavedPaperMarkdown("");
        setPaperBlog(null);
        setSavedPaperBlog(null);
        setCanvasMode((mode) => mode === "pdf" ? "split" : mode);
      }
    }
    finishClose();
    // The most recent still-open text file to fall back to (papers can't load
    // into the editor).
    if (isPaperTabKey(path)) return;
    if (projectAssetPaths.has(path)) {
      if (secondaryAsset?.path === path) {
        secondaryAssetRef.current = null;
        setSecondaryAsset(null);
        setFocusedPane("primary");
        setCanvasMode(activeAsset ? "asset" : "source");
        return;
      }
      if (activeAsset?.path === path) {
        activeAssetRef.current = null;
        setActiveAsset(null);
        if (canvasMode === "dual" || canvasMode === "columns") {
          if (secondaryFile === activeFile) {
            secondaryFileRef.current = null;
            secondarySourceRef.current = "";
            secondarySavedRef.current = "";
            setSecondaryFile(null);
            setSecondarySource("");
            setSecondarySavedSource("");
            setCanvasMode("source");
          }
          setFocusedPane("primary");
        } else if (fileFallback) await openProjectFile(fileFallback);
        else setCanvasMode((mode) => (mode === "asset" ? "split" : mode));
      }
      return;
    }
    if (path === secondaryFile) {
      secondaryFileRef.current = null;
      secondarySourceRef.current = "";
      secondarySavedRef.current = "";
      setSecondaryFile(null);
      setSecondarySource("");
      setSecondarySavedSource("");
      setFocusedPane("primary");
      if (path !== activeFile) return;
    }
    if (path !== activeFile) return;
    if (fileFallback) await openProjectFile(fileFallback);
  }, [
    activeAsset,
    activeFile,
    activePaper,
    canvasMode,
    dropProjectPath,
    dualPanePreview,
    flushAndCheckPrimaryDirty,
    loadFile,
    openProjectFile,
    projectAssetPaths,
    save,
    secondaryAsset,
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

  const loadReferenceImage = useCallback((path: string) => {
    const projectRoot = project?.root ?? "";
    const key = `${projectRoot}\0${path}`;
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
    // A link into a paper's cached markdown opens the Papers reading view,
    // not a plain editor tab: the plain tab loses the blog/full-text switch
    // and the paper selection context the agent reads. Falls through for a
    // paper that is no longer in the library.
    const paperLink = parsePaperLinkPath(path);
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
    if (isProjectAssetFilePath(path)) openProjectAssetFromClick(path);
    else openProjectFileFromClick(path);
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
    setSecondaryFile(candidate);
    setSecondarySource(content);
    setSecondarySavedSource(content);
    setOpenTabs((tabs) => (tabs.includes(candidate) ? tabs : [...tabs, candidate]));
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
      setActiveAsset(null);
      setActivePaper(null);
      setPaperMarkdown("");
      setSavedPaperMarkdown("");
      setPaperBlog(null);
      setSavedPaperBlog(null);
      // PDF can stand alone without a source tab. Returning to any source-backed
      // view restores the active document to the strip before rendering it.
      if (nextMode !== "pdf" && activeFile) {
        setOpenTabs((tabs) => (tabs.includes(activeFile) ? tabs : [...tabs, activeFile]));
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
    activeAsset,
    activeFile,
    activePaper,
    activePaperDirty,
    canvasMode,
    dropProjectPath,
    ensureSecondaryFile,
    focusedPane,
    save,
    secondaryAsset,
    secondaryFile,
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
      setSecondaryFile(nextSecondary);
      setSecondarySource(secondaryContent);
      setSecondarySavedSource(secondaryContent);
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
    activeFile,
    flushAndCheckPrimaryDirty,
    loadFile,
    save,
    secondaryFile,
    secondarySavedSource,
    secondarySource,
  ]);

  const createProjectEntry = useCallback(async (path: string, kind: "file" | "folder") => {
    try {
      const createdPath = await invoke<string>("create_project_entry", {
        path,
        kind,
        projectRoot: project?.root,
      });
      removedFileViewStatePathsRef.current = allowRememberedFileViewPath(
        removedFileViewStatePathsRef.current,
        createdPath,
      );
      await refreshProject();
      await refreshHistory();
      if (kind === "file") {
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
    openProjectFile,
    overleafLink,
    overleafSyncMode,
    overleafSyncRef,
    project?.root,
    refreshHistory,
    refreshProject,
    shareCreatedFileWithCollabV2,
  ]);

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
        removedFileViewStatePathsRef.current = allowRememberedFileViewPath(
          removedFileViewStatePathsRef.current,
          importedPath,
        );
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
  }, [assetImporting, project?.root, refreshProject, shareCreatedFileWithCollabV2]);

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
        removedFileViewStatePathsRef.current = allowRememberedFileViewPath(
          removedFileViewStatePathsRef.current,
          importedPath,
        );
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
  }, [assetImporting, project?.root, reconcileProjectTree, refreshHistory, shareCreatedFileWithCollabV2]);

  /**
   * Finder-style tree drops: any mix of files and folders, routed by the
   * backend on content (UTF-8 text through the transaction log, the rest
   * copied). Returned file kinds drive collab share registration per file.
   */
  const importProjectFiles = useCallback(async (
    paths: string[],
    targetDirectory = "",
  ): Promise<string[]> => {
    if (!paths.length || assetImporting) return [];
    setAssetImporting(true);
    try {
      const imported = await invoke<{ path: string; kind: "text" | "board" | "spreadsheet" | "binary" }[]>(
        "import_project_files",
        { paths, targetDirectory, projectRoot: project?.root },
      );
      for (const file of imported) {
        removedFileViewStatePathsRef.current = allowRememberedFileViewPath(
          removedFileViewStatePathsRef.current,
          file.path,
        );
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
  }, [assetImporting, project?.root, reconcileProjectTree, refreshHistory, shareCreatedFileWithCollabV2]);

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
              .then((files) => postSynaraMessage(buildAgentComposerFilesMessage(files)))
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
  }, [importProjectAssets, importProjectFiles, importProjectSources, openProjectAsset, postSynaraMessage, project]);

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

  const deleteProjectEntry = useCallback(async (path: string) => {
    if (!await confirmAction(`Delete “${path}” from this project?`)) return;
    try {
      const v2 = collabV2ControllerRef.current;
      if (activeCollabVersion === 2 && v2) {
        await v2.delete(path, {
          rename: async () => { throw new Error("Unexpected rename during delete"); },
          delete: (localPath, projectRoot) => collabDiskWriteQueueRef.current.run(collabWorkspaceLeaseRef.current!, localPath, () => invoke("delete_project_entry", { path: localPath, projectRoot })),
        });
      } else await invoke("delete_project_entry", { path, projectRoot: project?.root });
      invalidateFileViewStateCallbacks();
      removedFileViewStatePathsRef.current.push(path);
      for (const storedPath of viewStateRef.current.keys()) {
        if (storedPath === path || storedPath.startsWith(`${path}/`)) {
          viewStateRef.current.delete(storedPath);
        }
      }
      scheduleFileViewStatePersistence();
      const snapshot = await refreshProject();
      if (overleafLink && project) {
        // Structural deletes do not pass through `save()`, so handle the
        // remote side now instead of waiting for an unrelated later sync.
        await settleRemoteDeletes(
          [path],
          project.root,
          projectOperationGenerationRef.current,
        );
      }
      await refreshHistory();
      if (activeFile === path || activeFile.startsWith(`${path}/`)) {
        const rootDocument = snapshot.manifest.rootDocuments.find((document) => document.isDefault)
          ?? snapshot.manifest.rootDocuments[0];
        if (rootDocument) await loadFile(rootDocument.path);
      } else if (activeAsset?.path === path || activeAsset?.path.startsWith(`${path}/`)) {
        setActiveAsset(null);
        setCanvasMode("split");
      }
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [
    activeAsset,
    activeCollabVersion,
    activeFile,
    collabSession,
    invalidateFileViewStateCallbacks,
    loadFile,
    overleafLink,
    project,
    refreshHistory,
    refreshProject,
    scheduleFileViewStatePersistence,
    settleRemoteDeletes,
  ]);

  const applyProjectEntryPathChanges = useCallback((changes: readonly ProjectPathChange[]) => {
    if (changes.length === 0) return;
    const remapPath = (path: string) => remapProjectPath(path, changes);

    invalidateFileViewStateCallbacks();
    for (const change of changes) {
      removedFileViewStatePathsRef.current.push(change.previousPath);
      removedFileViewStatePathsRef.current = allowRememberedFileViewPath(
        removedFileViewStatePathsRef.current,
        change.nextPath,
      );
    }
    setProject((current) => current ? applyProjectPathChanges(current, changes) : current);
    setProjectGitStatus((current) => ({
      ...current,
      files: current.files.map((file) => ({ ...file, path: remapPath(file.path) })),
    }));
    setOpenTabs((tabs) => tabs.map(remapPath));
    setSecondaryFile((path) => path ? remapPath(path) : path);
    setActiveFile((path) => remapPath(path));
    setActiveAsset((asset) => asset ? { ...asset, path: remapPath(asset.path) } : asset);
    setNavStack((entries) => entries.map((entry) => ({ ...entry, path: remapPath(entry.path) })));
    setViewRestore((request) => request ? { ...request, path: remapPath(request.path) } : request);
    setOutlineSources((current) => Object.fromEntries(
      Object.entries(current).map(([path, content]) => [remapPath(path), content]),
    ));
    setTexlabDiagnostics((diagnostics) => diagnostics.map((diagnostic) => diagnostic.file
      ? { ...diagnostic, file: remapPath(diagnostic.file) }
      : diagnostic));
    setBuild((current) => current ? {
      ...current,
      diagnostics: current.diagnostics.map((diagnostic) => diagnostic.file
        ? { ...diagnostic, file: remapPath(diagnostic.file) }
        : diagnostic),
    } : current);

    tabRecency.current = tabRecency.current.map(remapPath);
    viewStateRef.current = new Map(
      [...viewStateRef.current].map(([path, state]) => [remapPath(path), state]),
    );
    scheduleFileViewStatePersistence();
    activeFileRef.current = remapPath(activeFileRef.current);
    secondaryFileRef.current = secondaryFileRef.current
      ? remapPath(secondaryFileRef.current)
      : null;
  }, [invalidateFileViewStateCallbacks, scheduleFileViewStatePersistence]);

  const renameProjectEntry = useCallback(async (path: string, name: string) => {
    projectTreeMutationCountRef.current += 1;
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
    } finally {
      projectTreeMutationCountRef.current = Math.max(
        0,
        projectTreeMutationCountRef.current - 1,
      );
    }
  }, [activeCollabVersion, applyProjectEntryPathChanges, markDiskMtime, project?.root, reconcileProjectTree]);

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

    projectTreeMutationCountRef.current += 1;
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
    } finally {
      projectTreeMutationCountRef.current = Math.max(
        0,
        projectTreeMutationCountRef.current - 1,
      );
    }
  }, [
    activeCollabVersion,
    applyProjectEntryPathChanges,
    markDiskMtime,
    project?.root,
    projectAssetPaths,
    publishTextToCollabV2,
    reconcileProjectTree,
    save,
    setPrimarySource,
    setSecondarySourceLive,
    t,
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

  const openBibEntryDialog = useCallback((resolveSeed = "") => {
    setBibEntryError(null);
    setBibEntryMode("add");
    setBibEntryInitial(undefined);
    setBibResolveSeed(resolveSeed);
    setBibEntryKey((value) => value + 1);
    setBibEntryOpen(true);
  }, []);

  const openEditBibEntry = useCallback(async (paper: PaperSummary) => {
    if (!paper.citationKey) return;
    try {
      const entry = await invoke<ResolvedCitationDraft | null>("read_bib_entry", { key: paper.citationKey });
      if (!entry) {
        setError(`Couldn't find a bibliography entry for \\cite{${paper.citationKey}}.`);
        return;
      }
      setBibEntryError(null);
      setBibEntryMode("edit");
      setBibEntryInitial(entry);
      setBibResolveSeed("");
      setBibEntryKey((value) => value + 1);
      setBibEntryOpen(true);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, []);

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

  const pasteClipboardImage = useCallback(async () => {
    if (!project || !activeFile?.endsWith(".tex")) {
      setError("Open a .tex file before pasting a figure.");
      return;
    }
    try {
      const { readImage } = await import("@tauri-apps/plugin-clipboard-manager");
      const image = await readImage();
      const size = await image.size();
      const rgba = await image.rgba();
      const base64 = await rgbaImageToPngBase64(rgba, size.width, size.height);
      const path = await invoke<string>("import_clipboard_image", {
        targetDirectory: "figures",
        fileName: clipboardImageFileName("image/png"),
        base64Data: base64,
        projectRoot: project.root,
      });
      await refreshProject();
      // After setError(null): a share failure must remain visible.
      await shareCreatedFileWithCollabV2(path, "binary");
      setCanvasMode((mode) => (mode === "pdf" || mode === "asset" ? "split" : mode));
      setFigureDropRequest({
        id: crypto.randomUUID(),
        paths: [path],
        clientX: -1,
        clientY: -1,
      });
      setError(null);
    } catch (reason) {
      setError(toMessage(reason) || "No image found on the clipboard.");
    }
  }, [activeFile, project, refreshProject, shareCreatedFileWithCollabV2]);

  const resolveBibQuery = useCallback(async (query: string): Promise<ResolvedCitationDraft | null> => {
    setBibEntryResolving(true);
    setBibEntryError(null);
    try {
      const resolved = await invoke<{
        key: string;
        title: string;
        author: string;
        year: string;
        journal: string;
        booktitle: string;
        publisher: string;
        url: string;
        doi: string;
        entryType: string;
      }>("resolve_citation_query", { query });
      return resolved;
    } catch (reason) {
      setBibEntryError(toMessage(reason));
      return null;
    } finally {
      setBibEntryResolving(false);
    }
  }, []);

  const saveBibEntry = useCallback(async (draft: BibEntryDraft, insertCite: boolean) => {
    if (!project) return;
    const bibliography = project.manifest.primaryBibliography;
    if (!bibliography) {
      setBibEntryError("This project has no primary bibliography.");
      return;
    }
    if (!draft.title.trim() || !draft.author.trim() || !draft.year.trim()) {
      setBibEntryError("Title, author, and year are required.");
      return;
    }
    setBibEntryBusy(true);
    setBibEntryError(null);
    try {
      if (source !== savedSource) {
        const saved = await save();
        if (!saved) return;
      }
      if (bibEntryMode === "edit") {
        // The key is read-only when editing, so this replaces the entry in place.
        await invoke("save_bib_entry", { key: draft.key, bibtex: formatBibEntry(draft) });
      } else {
        const existing = bibliography === activeFile
          ? source
          : await invoke<string>("read_project_file", { path: bibliography });
        await invoke("write_project_file", {
          path: bibliography,
          content: appendBibEntry(existing, formatBibEntry(draft)),
          projectRoot: project.root,
        });
      }
      // Re-sync the editor buffer and collab peers with what's now on disk.
      const next = await invoke<string>("read_project_file", { path: bibliography });
      await publishTextToCollabV2(bibliography, next);
      if (bibliography === activeFile) {
        setSource(next);
        setSavedSource(next);
      }
      await refreshProject();
      setBibEntryOpen(false);
      if (insertCite) {
        setCiteInsertRequest({ key: draft.key, command: "cite", id: crypto.randomUUID() });
        setCanvasMode((mode) => (mode === "pdf" || mode === "asset" ? "split" : mode));
      }
      setError(null);
    } catch (reason) {
      setBibEntryError(toMessage(reason));
    } finally {
      setBibEntryBusy(false);
    }
  }, [activeFile, bibEntryMode, collabSession, project, publishTextToCollabV2, refreshProject, save, savedSource, source]);

  const runDoctor = useCallback(async (options?: {
    openWizardIfMissing?: boolean;
  }) => {
    const generation = ++doctorGenerationRef.current;
    setDoctorBusy(true);
    setDoctorNotice("");
    try {
      const report = await invoke<DoctorReport>("run_doctor");
      if (generation !== doctorGenerationRef.current) return null;
      setDoctorReport(report);
      const missing = isRequiredSetupMissing(report);
      if (options?.openWizardIfMissing && missing) setTexSetupOpen(true);
      return report;
    } catch (reason) {
      if (generation !== doctorGenerationRef.current) return null;
      const message = toMessage(reason);
      setDoctorNotice(message);
      return null;
    } finally {
      if (generation === doctorGenerationRef.current) setDoctorBusy(false);
    }
  }, []);

  const openTexSetupWizard = useCallback(() => {
    if (doctorReport) {
      if (isRequiredSetupMissing(doctorReport)) setTexSetupOpen(true);
      return;
    }
    void runDoctor({ openWizardIfMissing: true });
  }, [doctorReport, runDoctor]);


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
      if (preview.blockers.length) {
        const count = preview.blockers.length;
        const first = preview.blockers[0];
        const location = first ? ` The first is at ${first.path}:${first.line}.` : "";
        const choice = await chooseAction({
          title: `Remove “${paper.title}” from the bibliography?`,
          message: `This entry is cited in ${count} ${count === 1 ? "place" : "places"}.${location} Keeping the citation commands will leave them unresolved. Downloaded paper files will be kept.`,
          confirmLabel: "Remove citations too",
          alternativeLabel: "Keep citations",
          alternativeDestructive: true,
          destructive: true,
        });
        if (choice === "cancel") return;
        citationMode = choice === "confirm" ? "remove" : "keep";
      } else {
        const confirmed = await confirmAction({
          title: `Remove “${paper.title}” from the bibliography?`,
          message: "Downloaded paper files will be kept.",
          confirmLabel: "Remove entry",
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
          sourceRef.current = content;
          savedSourceRef.current = content;
          setSource(content);
          setSavedSource(content);
          await markDiskMtime(path);
        } else if (!published && path === secondaryFile) {
          secondarySourceRef.current = content;
          secondarySavedRef.current = content;
          setSecondarySource(content);
          setSecondarySavedSource(content);
        }
      }
      if (activePaper && paperKey(activePaper) === paperKey(paper)) {
        setActivePaper(null);
        setPaperMarkdown("");
        setSavedPaperMarkdown("");
        setPaperBlog(null);
        setSavedPaperBlog(null);
        setCanvasMode("split");
      }
      setError(null);
      await refreshProject();
      await refreshHistory();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [
    activeFile,
    activePaper,
    activeCollabVersion,
    collabSession,
    markDiskMtime,
    project,
    publishTextToCollabV2,
    refreshHistory,
    refreshProject,
    save,
    secondaryFile,
  ]);

  const openSettings = useCallback((tab: SettingsTab = "appearance") => {
    if (isSynaraSettingsTab(tab)) setSynaraRuntimeRequested(true);
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

  const openEditorCommentReply = useCallback((commentId: string) => {
    setCommentPanelFocusId(commentId);
    setEditorCommentsOpen(true);
  }, []);

  const settingsDialog = settingsOpen ? (
    <Suspense fallback={null}>
      <SettingsDialog
        synaraRuntime={synaraRuntime}
        synaraWorkspaceRoot={project?.root}
        onRetrySynaraRuntime={retrySynaraRuntime}
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
          if (isSynaraSettingsTab(tab)) setSynaraRuntimeRequested(true);
          setSettingsTab(tab);
          if (tab === "doctor") void runDoctor();
        }}
        doctorReport={doctorReport}
        doctorBusy={doctorBusy}
        doctorNotice={doctorNotice}
        onRunDoctor={() => { void runDoctor(); }}
        onOpenTexSetup={() => openTexSetupWizard()}
        onCleanProject={() => { void cleanProject(); }}
        cleaning={cleaning}
        building={building}
        onOpenInBrowser={async () => {
          if (!await startProjectTransition()) {
            throw new Error(t`Save the current workspace before opening it in a browser.`);
          }
          try {
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
        appearance={appearance}
        setAppearance={setAppearance}
        localSemanticSearchEnabled={localSemanticSearchEnabled}
        localSemanticSearchStatus={localSemanticSearchStatus}
        onLocalSemanticSearchEnabledChange={(enabled) => {
          setLocalSemanticSearchEnabled(enabled);
          persistLocalSemanticSearchEnabled(enabled);
          const projectRoot = projectRef.current?.root;
          if (!enabled && projectRoot) {
            // The preference is app-global. Other windows mirror this choice
            // through the storage event and clear indexes for their own open
            // projects; this window clears the project where the choice began.
            void invoke("semantic_search_cancel", { projectRoot }).catch(() => undefined);
          }
        }}
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
      const paper = papers.find((item) => item.arxivId === arxivIdFromTabKey(path));
      if (paper) void openPaper(paper);
      else void closeEditorTab(path);
    } else if (projectAssetPaths.has(path)) {
      void openProjectAsset(path);
    } else {
      void openProjectFile(path);
    }
  }, [closeEditorTab, openPaper, openProjectAsset, openProjectFile, papers, projectAssetPaths]);
  const requestCloseEditorTab = useCallback((path: string) => {
    void closeEditorTab(path);
  }, [closeEditorTab]);
  const editorTabItems = useMemo(
    () => openTabs.map((path) => {
      if (isPaperTabKey(path)) {
        const id = arxivIdFromTabKey(path);
        return {
          path,
          kind: "paper" as const,
          label: papers.find((paper) => paper.arxivId === id)?.title ?? "Paper",
          dirty: activePaper?.arxivId === id && activePaperDirty,
        };
      }
      if (projectAssetPaths.has(path)) {
        return {
          path,
          kind: "asset" as const,
          beside: path === secondaryAsset?.path
            && (canvasMode === "dual" || canvasMode === "columns"),
        };
      }
      return {
        path,
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
    ? paperTabKey(activePaper.arxivId)
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
      secondaryFile,
      activeAsset?.path,
      secondaryAsset?.path,
    ].filter(Boolean) as string[]);
    const candidates = openTabs.filter((key) => !keep.has(key));
    if (!candidates.length) return;
    const staleness = (key: string) => {
      const index = tabRecency.current.indexOf(key);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    const victim = candidates.reduce((worst, key) => (staleness(key) > staleness(worst) ? key : worst));
    setOpenTabs((tabs) => tabs.filter((key) => key !== victim));
    tabRecency.current = tabRecency.current.filter((key) => key !== victim);
  }, [
    openTabs,
    appearance.maxOpenTabs,
    activeTabKey,
    activeFile,
    activeAsset?.path,
    secondaryAsset?.path,
    secondaryFile,
  ]);
  useEffect(() => {
    if (!project?.root || workspacePersistenceReadyRoot !== project.root) return;
    persistWorkspaceLayout(project.root, {
      openTabs,
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
    activeFile,
    activeTabKey,
    canvasMode,
    focusedPane,
    openTabs,
    paperView,
    project?.root,
    secondaryFile,
    workspacePersistenceReadyRoot,
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

  useEffect(() => {
    if (!project || !activeFile.endsWith(".tex")) {
      setTexlabDiagnostics(EMPTY_DIAGNOSTICS);
      return;
    }
    // This effect re-runs on every keystroke. A fresh `[]` is never equal to
    // the previous one, so clearing with a literal committed a second render
    // of the whole app for each character typed; the shared empty list lets
    // React bail out when there was nothing to clear.
    setTexlabDiagnostics(EMPTY_DIAGNOSTICS);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void invoke<CompileDiagnostic[]>("texlab_diagnostics", {
        path: activeFile,
        text: source,
      })
        .then((diagnostics) => {
          if (!cancelled) setTexlabDiagnostics(diagnostics);
        })
        .catch(() => {
          if (!cancelled) setTexlabDiagnostics(EMPTY_DIAGNOSTICS);
        });
    }, 700);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeFile, project, source]);

  // texlab, when installed, reports unused labels/citations itself, so the local
  // check would duplicate its warnings. Suppress the local one when texlab is
  // available (assume it is until the doctor report loads) and fall back to it
  // otherwise. The unused-symbol counts elsewhere still use the full list.
  const texlabActive = doctorReport?.checks.some((check) => check.name === "texlab" && check.ok) ?? true;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "F8") {
        event.preventDefault();
        cycleCompileDiagnostic(event.shiftKey ? -1 : 1);
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
        setProjectReplaceError(null);
        setProjectReplacePreview(null);
        setProjectReplaceOpen(true);
      }
      if (event.key.toLocaleLowerCase() === "f" && event.shiftKey) {
        event.preventDefault();
        setProjectFindError(null);
        setProjectFindHits([]);
        setProjectFindOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canInsert, cycleCompileDiagnostic, navigateHistory, reopenClosedTab, revealSourceInPdf]);

  if (!project) {
    return (
      <>
        <Welcome
          busyLabel={busyLabel}
          createOpen={createOpen}
          createError={createError}
          projectName={projectName}
          projectVenue={projectVenue}
          onOpenCreate={() => {
            setCreateError(null);
            setCreateOpen(true);
          }}
          onCloseCreate={() => {
            setCreateError(null);
            setCreateOpen(false);
          }}
          setProjectName={(value) => {
            setProjectName(value);
            setCreateError(null);
          }}
          setProjectVenue={(value) => {
            setProjectVenue(value);
            setCreateError(null);
          }}
          onCreate={createProject}
          onOpen={chooseExisting}
          onImportZip={() => void importOverleafZip()}
          onJoinCollab={() => openCollabDialog("join")}
          onOpenTutorial={() => void openTutorialProject()}
          onSettings={() => openSettings("appearance")}
          onInstallTex={openTexSetupWizard}
          onOpenOverleaf={() => setOverleafPickerOpen(true)}
        />
        {collabOpen && (
          <Suspense fallback={null}>
            <CollabDialog
              open
              mode="join"
              role={collabRole}
              joinOnly
              host={collabHost}
              room={collabRoom}
              displayName={collabName}
              projectName={collabProjectName}
              inviteText={collabInvite}
              status={collabStatus}
              statusDetail={collabStatusDetail}
              peerCount={collabPeers}
              peers={collabPeerList}
              fileCount={collabFileCount}
              connectedRoom={collabSession?.room ?? null}
              onClose={() => setCollabOpen(false)}
              onModeChange={setCollabMode}
              onRoomChange={setCollabRoom}
              onDisplayNameChange={setCollabName}
              onProjectNameChange={setCollabProjectName}
              onInviteChange={setCollabInvite}
              onStartShare={startCollabShare}
              onJoinShare={joinCollabShare}
              recentProjectsV2={recentProjectsV2}
              onRejoinProjectV2={rejoinCollabProjectV2}
              onForgetProjectV2={forgetRecentProjectV2}
              onRenameProjectV2={renameRecentProjectV2}
              onCloseProjectV2={closeRecentProjectV2}
              onDisconnect={disconnectCollab}
              onLeaveShare={() => void leaveHostShareSession()}
              onCopyInvite={copyCollabInvite}
              onRemovePeer={removeCollabPeer}
              onInstallTex={openTexSetupWizard}
            />
          </Suspense>
        )}
        {settingsDialog}
        {overleafPicker}
        {overleafReview}
        <TexSetupWizard
          open={texSetupOpen}
          report={doctorReport}
          checking={doctorBusy}
          onClose={() => setTexSetupOpen(false)}
          onRecheck={() => runDoctor({ openWizardIfMissing: true })}
        />
      </>
    );
  }

  return (
    <div
      className={`app-shell ${isFullscreen ? "fullscreen" : ""} ${browserHosted ? "browser-hosted" : ""}`}
      ref={shellRef}
    >
      <AppTitlebar
        abortBuild={abortBuild}
        activePaper={activePaper}
        activeTabKey={activeTabKey}
        build={build}
        building={building}
        buildPreferences={buildPreferences}
        busyLabel={busyLabel}
        canvasMode={canvasMode}
        canvasToolbar={(
        <CanvasToolbar
          mode={canvasMode}
          selectedDocumentViewMode={focusedPanePreview ? "pdf" : undefined}
          setMode={openDocumentMode}
          supportsDocumentViewModes={Boolean(activePaper)
            || (!focusedAsset && isPreviewableSourceFilePath(focusedDocumentPath))}
          onSplit={
            !activePaper
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
          markdown={Boolean(activePaper)
            || (!focusedAsset && focusedDocumentPath.toLocaleLowerCase().endsWith(".md"))}
          html={!activePaper && !focusedAsset && isHtmlFilePath(focusedDocumentPath)}
          paperView={activePaper ? paperView : undefined}
          paperHasBlog={paperBlog !== null}
          paperHasFullText={Boolean(paperMarkdown)}
          onPaperView={activePaper ? (view) => {
            changePaperView(view);
            if (tutorialActive && tutorialStep === TUTORIAL_STEPS.paperBlog && view === "fulltext") {
              setTutorialStep(TUTORIAL_STEPS.paperFullText);
            }
          } : undefined}
          activePath={activePaper?.title ?? activeTabKey}
          activeKind={focusedAsset ? "asset" : activePaper ? "paper" : "document"}
          canInsert={canInsert}
          dirty={activePaper
            ? activePaperDirty
            : source !== savedSource
              || (Boolean(secondaryFile) && secondarySource !== secondarySavedSource)}
          canNavigateBack={navIndex > 0}
          canNavigateForward={navIndex >= 0 && navIndex < navStack.length - 1}
          onNavigateBack={() => void navigateHistory(-1)}
          onNavigateForward={() => void navigateHistory(1)}
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
            setSynaraRuntimeRequested(true);
            setGitOpen(true);
          }}
          commentCount={allEditorComments.filter((comment) => !comment.resolved).length}
          onComments={() => setEditorCommentsOpen(true)}
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
            overleafChat.unread + overleafComments.openCount + overleafRealtime.changes.length
          }
          onOverleafChat={() => {
            setOverleafCollabOpen(true);
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
        importing={importing}
        openSettings={openSettings}
        openTutorialProject={openTutorialProject}
        project={project}
        projectMenuOpen={projectMenuOpen}
        recentProjects={recentProjects}
        requestCloseEditorTab={requestCloseEditorTab}
        selectEditorTab={selectEditorTab}
        setCreateError={setCreateError}
        setCreateOpen={setCreateOpen}
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
        className={`workspace ${sidebarOpen ? "" : "sidebar-hidden"}`}
        style={{
          gridTemplateColumns: sidebarOpen ? `${sidebarWidth}px 1px minmax(0, 1fr)` : "minmax(0, 1fr)",
          gridTemplateAreas: sidebarOpen ? '"sidebar sidebar-resizer canvas"' : '"canvas"',
        }}
      >
        {sidebarOpen && (
          <AppWorkspaceSidebar
            agentPanelDropActive={agentPanelDropActive}
            appLocale={appLocale}
            beginSidebarResize={beginSidebarResize}
            changeSynaraPermissionMode={changeSynaraPermissionMode}
            chooseSidebarMode={chooseSidebarMode}
            navigator={(
            <Suspense fallback={null}>
            <Navigator
              mode={sidebarMode === "papers" ? "papers" : "project"}
              projectKey={project.root}
              searchOpen={projectSearchOpen}
              boardCreateRequest={boardCreateRequest}
              spreadsheetCreateRequest={spreadsheetCreateRequest}
              onSearchOpenChange={setProjectSearchOpen}
              files={project.files}
              gitStatus={projectGitStatus.projectRoot === project.root ? projectGitStatus.files : []}
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
              onDeleteEntry={deleteProjectEntry}
              onRenameEntry={renameProjectEntry}
              onMoveEntries={moveProjectEntries}
              onError={setError}
              onReveal={revealProjectItem}
              onImportAssets={chooseProjectAssets}
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
              onEditBibEntry={(paper) => void openEditBibEntry(paper)}
              importInput={importInput}
              importStage={paperImportStage ? paperImportStageLabel(paperImportStage) : null}
              setImportInput={setImportInput}
              onImport={importPaper}
              importing={importing}
            />
            </Suspense>
            )}
            nudgeSidebar={nudgeSidebar}
            openBibEntryDialog={openBibEntryDialog}
            project={project}
            retrySynaraRuntime={retrySynaraRuntime}
            setBoardCreateRequest={setBoardCreateRequest}
            setLiteratureOpen={setLiteratureOpen}
            setProjectFindError={setProjectFindError}
            setProjectFindHits={setProjectFindHits}
            setProjectFindOpen={setProjectFindOpen}
            setProjectSearchOpen={setProjectSearchOpen}
            setSpreadsheetCreateRequest={setSpreadsheetCreateRequest}
            sidebarMode={sidebarMode}
            sidebarModeActionsRef={sidebarModeActionsRef}
            sidebarModeHeaderRef={sidebarModeHeaderRef}
            sidebarModeTier={sidebarModeTier}
            sidebarWidth={sidebarWidth}
            synaraAutoModeAvailable={synaraAutoModeAvailable}
            synaraFrameMounted={synaraFrameMounted}
            synaraFrameReady={synaraFrameReady}
            synaraIframeRef={synaraIframeRef}
            synaraOrigin={synaraOrigin}
            synaraPermissionMode={synaraPermissionMode}
            synaraRuntime={synaraRuntime}
            theme={theme}
          />
        )}

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
          <DocumentCanvas
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
            setSelection={(value) => reportAgentSelection(activePaper ? "paper" : "editor", value)}
            onPdfTextSelect={(value) => reportAgentSelection("pdf", value)}
            onPaperTextSelect={(value) => reportAgentSelection("paper", value)}
            onImportAsset={importClipboardImageFile}
            onContextSurfaceActivate={activateAgentHostSurface}
            onViewMarkdownSource={() => {
              markdownModeViewportCaptureRef.current?.();
              if (canvasMode === "dual" || canvasMode === "columns") {
                openDocumentMode("source");
              } else {
                setCanvasMode("split");
              }
            }}
            pdfUrl={pdfUrl}
            pdfBase64={null}
            pdfBytes={displayedPdfBytesRef.current}
            pdfTop={!diagnosticsDismissed && build?.success && build.diagnostics.length > 0 ? (
              <Suspense fallback={null}>
                <CompileDiagnosticsPanel
                  diagnostics={build.diagnostics}
                  log={build.log}
                  success={build.success}
                  expanded={diagnosticsExpanded}
                  onExpandedChange={setDiagnosticsExpanded}
                  onSelect={(diagnostic) => void openCompileDiagnostic(diagnostic)}
                  onInstallDependency={installTexDependency}
                  onDismiss={() => {
                    dismissedDiagnosticsRef.current = diagnosticsFingerprint(build.diagnostics);
                    setDiagnosticsDismissed(true);
                  }}
                />
              </Suspense>
            ) : null}
            activePaper={activePaper}
            activeAsset={activeAsset}
            secondaryAsset={secondaryAsset}
            canOpenCitation={(key) => papers.some((item) => item.citationKey?.toLocaleLowerCase() === key.toLocaleLowerCase()
              && (item.hasFullText || item.hasBlog))}
            onOpenCitation={(key) => {
              const paper = papers.find((item) => item.citationKey?.toLocaleLowerCase() === key.toLocaleLowerCase()
                && (item.hasFullText || item.hasBlog));
              if (paper) void openPaper(paper);
            }}
            citationKeys={citationKeys}
            citations={citations}
            references={liveReferences}
            unusedLabels={texlabActive ? [] : unusedSymbols.labels}
            unusedCitations={texlabActive ? [] : unusedSymbols.citations}
            onLoadReferenceImage={loadReferenceImage}
            onEditorLeave={buildWhenLeavingEditor}
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
              source === diagnosticBuildSource && secondarySource === diagnosticBuildSecondarySource
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
            onOpenEditorComments={() => setEditorCommentsOpen(true)}
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
            collabSession={activePaper ? null : collabSession}
            collabReady={collabReady}
            editorEditable={
              (collabSession?.canWrite !== false && collabCanWrite)
              && (
                // Papers live under .research/, which Overleaf deliberately
                // excludes from sync. Keep collaboration read grants above,
                // but do not let an unrelated Overleaf document's permission
                // turn the local Paper editor read-only.
                activePaper !== null
                || overleafLink === null
                || overleafRealtime.canWrite
                || (
                  overleafRealtime.permission !== "unknown"
                  && overleafRealtime.entities.get(activeFile)?.kind !== "doc"
                  && !Array.from(overleafDocPaths.values()).includes(activeFile)
                )
              )
            }
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
        closeRecentProjectV2={closeRecentProjectV2}
        collabCanWrite={collabCanWrite}
        collabChat={collabChat}
        collabFileCount={collabFileCount}
        collabHost={collabHost}
        collabInvite={collabInvite}
        collabMode={collabMode}
        collabName={collabName}
        collabOpen={collabOpen}
        collabPeerList={collabPeerList}
        collabPeers={collabPeers}
        collabProjectName={collabProjectName}
        collabRole={collabRole}
        collabRoom={collabRoom}
        collabSession={collabSession}
        collabStatus={collabStatus}
        collabStatusDetail={collabStatusDetail}
        copyCollabInvite={copyCollabInvite}
        disconnectCollab={disconnectCollab}
        editorCommentAuthorId={editorCommentAuthorId}
        forgetRecentProjectV2={forgetRecentProjectV2}
        joinCollabShare={joinCollabShare}
        leaveHostShareSession={leaveHostShareSession}
        openTexSetupWizard={openTexSetupWizard}
        recentProjectsV2={recentProjectsV2}
        rejoinCollabProjectV2={rejoinCollabProjectV2}
        removeCollabPeer={removeCollabPeer}
        renameRecentProjectV2={renameRecentProjectV2}
        setCollabInvite={setCollabInvite}
        setCollabMode={setCollabMode}
        setCollabName={setCollabName}
        setCollabOpen={setCollabOpen}
        setCollabProjectName={setCollabProjectName}
        setCollabRoom={setCollabRoom}
        startCollabShare={startCollabShare}
      />

      <TexSetupWizard
        open={texSetupOpen}
        report={doctorReport}
        checking={doctorBusy}
        onClose={() => setTexSetupOpen(false)}
        onRecheck={() => runDoctor({ openWizardIfMissing: true })}
      />

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
        gitWorkspaceView={gitWorkspaceView}
        historyOpen={historyOpen}
        loadFile={loadFile}
        openProjectFile={openProjectFile}
        overleafLink={overleafLink}
        project={project}
        projectHistory={projectHistory}
        refreshHistory={refreshHistory}
        refreshProject={refreshProject}
        retrySynaraRuntime={retrySynaraRuntime}
        revert={revert}
        runOverleafSync={runOverleafSync}
        setAgentTurnReview={setAgentTurnReview}
        setGitOpen={setGitOpen}
        setGitWorkspaceView={setGitWorkspaceView}
        setHistoryOpen={setHistoryOpen}
        synaraIframeRef={synaraIframeRef}
        synaraOrigin={synaraOrigin}
        synaraRuntime={synaraRuntime}
        synaraSourceControlFrameRef={synaraSourceControlFrameRef}
        theme={theme}
      />

      <AppOverleafCollabDrawer
        activeFileRef={activeFileRef}
        openProjectFile={openProjectFile}
        overleafChat={overleafChat}
        overleafCollabOpen={overleafCollabOpen}
        overleafCollabTab={overleafCollabTab}
        overleafComments={overleafComments}
        overleafDocPaths={overleafDocPaths}
        overleafLink={overleafLink}
        overleafRealtime={overleafRealtime}
        overleafTrackChanges={overleafTrackChanges}
        setOverleafCollabOpen={setOverleafCollabOpen}
        setOverleafCollabTab={setOverleafCollabTab}
        setViewRestore={setViewRestore}
        source={source}
      />

      <AppEditorPanels
        activeFile={activeFile}
        activeFileRef={activeFileRef}
        allEditorComments={allEditorComments}
        build={build}
        checklistOpen={checklistOpen}
        commentOpenGenerationRef={commentOpenGenerationRef}
        commentPanelFocusId={commentPanelFocusId}
        editorCommentAuthorId={editorCommentAuthorId}
        editorComments={editorComments}
        editorCommentsOpen={editorCommentsOpen}
        mainBodyPages={mainBodyPages}
        openProjectFile={openProjectFile}
        overleafComments={overleafComments}
        overleafThreadOf={overleafThreadOf}
        pdfPageCount={pdfPageCount}
        persistEditorComments={persistEditorComments}
        project={project}
        projectWordCount={projectWordCount}
        refreshTodos={refreshTodos}
        replyToEditorComment={replyToEditorComment}
        setActiveEditorCommentId={setActiveEditorCommentId}
        setChecklistOpen={setChecklistOpen}
        setCommentFocusRequest={setCommentFocusRequest}
        setCommentPanelFocusId={setCommentPanelFocusId}
        setEditorCommentsOpen={setEditorCommentsOpen}
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

      <AppProjectSearchDialogs
        activeFile={activeFile}
        loadFile={loadFile}
        localSemanticSearchEnabled={localSemanticSearchEnabled}
        localSemanticSearchStatus={localSemanticSearchStatus}
        openMarkdownProjectPath={openMarkdownProjectPath}
        openProjectFile={openProjectFile}
        projectFindBusy={projectFindBusy}
        projectFindError={projectFindError}
        projectFindHits={projectFindHits}
        projectFindOpen={projectFindOpen}
        projectFindSearchGenerationRef={projectFindSearchGenerationRef}
        projectOperationGenerationRef={projectOperationGenerationRef}
        projectRef={projectRef}
        projectReplaceBusy={projectReplaceBusy}
        projectReplaceError={projectReplaceError}
        projectReplaceOpen={projectReplaceOpen}
        projectReplacePreview={projectReplacePreview}
        refreshHistory={refreshHistory}
        refreshProject={refreshProject}
        save={save}
        savedSource={savedSource}
        setLocalSemanticSearchStatus={setLocalSemanticSearchStatus}
        setProjectFindBusy={setProjectFindBusy}
        setProjectFindError={setProjectFindError}
        setProjectFindHits={setProjectFindHits}
        setProjectFindOpen={setProjectFindOpen}
        setProjectReplaceBusy={setProjectReplaceBusy}
        setProjectReplaceError={setProjectReplaceError}
        setProjectReplaceOpen={setProjectReplaceOpen}
        setProjectReplacePreview={setProjectReplacePreview}
        source={source}
      />

      <AppProjectDialogs
        bibEntryBusy={bibEntryBusy}
        bibEntryError={bibEntryError}
        bibEntryInitial={bibEntryInitial}
        bibEntryKey={bibEntryKey}
        bibEntryMode={bibEntryMode}
        bibEntryOpen={bibEntryOpen}
        bibEntryResolving={bibEntryResolving}
        bibResolveSeed={bibResolveSeed}
        createError={createError}
        createOpen={createOpen}
        createProject={createProject}
        importedArxivIds={importedArxivIds}
        importReferenceInput={importReferenceInput}
        literatureOpen={literatureOpen}
        openBibEntryDialog={openBibEntryDialog}
        projectName={projectName}
        projectVenue={projectVenue}
        renameError={renameError}
        renameTarget={renameTarget}
        resolveBibQuery={resolveBibQuery}
        saveBibEntry={saveBibEntry}
        setBibEntryOpen={setBibEntryOpen}
        setCreateError={setCreateError}
        setCreateOpen={setCreateOpen}
        setLiteratureOpen={setLiteratureOpen}
        setProjectName={setProjectName}
        setProjectVenue={setProjectVenue}
        setRenameError={setRenameError}
        setRenameTarget={setRenameTarget}
        submitRename={submitRename}
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
          {
            id: "collab",
            label: collabSession ? t`Live sharing…` : t`Start / join live sharing`,
            detail: collabSession
              ? t({ message: `${collabPeers} connected · ${collabSession.room}` })
              : t`Share invite with a collaborator`,
            group: t`Edit`,
          },
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
            case "bib": openBibEntryDialog(); break;
            case "discover": setLiteratureOpen(true); break;
            case "find":
              setProjectFindError(null);
              setProjectFindHits([]);
              setProjectFindOpen(true);
              break;
            case "replace":
              setProjectReplaceError(null);
              setProjectReplacePreview(null);
              setProjectReplaceOpen(true);
              break;
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
