import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  BookMarked,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  FolderTree,
  Image,
  Library,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Radio,
  Search,
  Shapes,
  Shield,
  ShieldCheck,
  Hand,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
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
} from "./latex-text";
import { appendBibEntry, formatBibEntry, type BibEntryDraft } from "./bib-entry";
import { BibEntryDialog, type ResolvedCitationDraft } from "./bib-entry-dialog";
import { clipboardImageFileName, fileToBase64, rgbaImageToPngBase64 } from "./clipboard-image";
import { GotoLineDialog } from "./goto-line-dialog";
import { QuickOpenDialog } from "./quick-open-dialog";
import { SearchPickerDialog, type SearchPickerItem } from "./search-picker-dialog";
import { MarkdownWorkspaceIndex } from "./markdown-workspace-index";
import type { CollabDialogMode } from "./collab-dialog";
import { TexSetupWizard } from "./tex-setup-wizard";
import {
  dismissTexSetup,
  isConferenceFontsMissing,
  isMissingTexBuildError,
  isTexToolchainMissing,
  wasTexSetupDismissed,
} from "./tex-setup";
import {
  assertCollabWorkspaceLease,
  CollabDiskWriteQueue,
  type CollabWorkspaceLease,
} from "./collab-workspace-lease";
import {
  createEditorCommentReply,
  EDITOR_COMMENTS_PATH,
  loadEditorCommentAuthorId,
  mergeEditorComments,
  serializeEditorComments,
  tryParseEditorComments,
} from "./editor-comment-data";
import { useAppearance } from "./use-appearance";
import { usePanelLayout } from "./use-panel-layout";
import { resolveSidebarModeTier, type SidebarModeTier } from "./sidebar-mode-layout";
import { useOverleafRealtime } from "./use-overleaf-realtime";
import { useOverleafChat } from "./use-overleaf-chat";
import { useCollabChat } from "./use-collab-chat";
import { useOverleafPresence, type PresenceUser } from "./use-overleaf-presence";
import { useOverleafTrackChanges } from "./use-overleaf-track-changes";
import { CopyButton } from "./components/copy-button";
import { type PresenceCursor } from "./overleaf-cursors";
import { OverleafPresenceAvatars } from "./overleaf-presence";
import { AvatarGroup } from "./avatar-group";
import { useOverleafComments, type OverleafComments } from "./use-overleaf-comments";
import type { OverleafCollabTab } from "./overleaf-collab";
import {
  type RecentProject,
  type BuildPreferences,
  BUILD_PREFERENCES_KEY,
  loadRecentProjects,
  persistRecentProjects,
  loadBuildPreferences,
  loadLastFile,
  persistLastFile,
  loadWorkspaceLayout,
  persistWorkspaceLayout,
  type OverleafRemoteDelete,
  type OverleafSyncMode,
  loadOverleafRemoteDelete,
  persistOverleafRemoteDelete,
  loadOverleafSyncMode,
  persistOverleafSyncMode,
  hasSeenTutorial,
  markTutorialSeen,
} from "./app-settings";
import {
  type EditorComment,
} from "./editor-comment-data";
import {
  executeAgentCanvasToolRequest,
  parseAgentCanvasToolRequest,
} from "./agent-canvas-tools";
const EditorCommentsPanel = lazy(() =>
  import("./editor-comments-panel").then((module) => ({ default: module.EditorCommentsPanel })),
);
import { SlidingTabs } from "./motion";
import {
  clearPreCollabProjectRoot,
  rememberPreCollabProjectRoot,
  resolvePreCollabProjectRoot,
} from "./collab-return";
import { pdfBytesFingerprint, pdfBytesToObjectUrl } from "./pdf-bytes";
import {
  loadCollabDisplayName,
  loadCollabHost,
  mergeTextIntoYText,
  resolveCollabHost,
  saveCollabDisplayName,
  saveCollabHost,
  peerCursorLocationV2,
  peerInitials,
  type CollabPeer,
  type EditorCollabSession,
  type CollabStatus,
} from "./collab-session";
import { collabCredentialStore } from "./collab-credentials";
import { loadCollabFeaturePolicy } from "./collab-feature-policy";
import { createProjectV2 } from "./collab-import-v2";
import { acceptCollabInvitationV2 } from "./collab-join-v2";
import { CollabProjectControllerV2, type CollabMaterializeCallbacksV2, type CollabProjectStatusV2 } from "./collab-project-v2";
import type { CatalogV2 } from "../protocol/collab-v2";
import { parsePreferredCollabInvitation, requireRememberedV2Credential } from "./collab-app-v2";
import {
  forgetCollabProjectV2,
  loadCollabProjectsV2,
  rememberCollabProjectV2,
  type CollabProjectRecordV2,
} from "./collab-rooms";
const CompileDiagnosticsPanel = lazy(() =>
  import("./compile-diagnostics-panel").then((module) => ({ default: module.CompileDiagnosticsPanel })),
);
import {
  flattenProjectPaths,
  resolveDiagnosticPath,
  type CompileDiagnostic,
} from "./compile-diagnostics";
import { CanvasToolbar } from "./canvas-toolbar";
import { Welcome, CreateProjectDialog, RenameDialog, ProjectMenu } from "./project-dialogs";
import { TUTORIAL_STEPS } from "./onboarding-steps";
import {
  activeOutlineNode,
  flattenOutline,
  includedPathsIn,
  parseProjectOutline,
} from "./latex-outline";
import { ReferencesPanel, type SymbolOccurrence } from "./references-panel";
const HistoryDrawer = lazy(() =>
  import("./history-drawer").then((module) => ({ default: module.HistoryDrawer })),
);
import { type HistoryItem } from "./history-drawer";
import { katexMacrosFromSources } from "./katex-macros";
import { Navigator } from "./navigator";
import { EditorTabs } from "./editor-tabs";
import { Tip } from "./components/icon-tip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { ProjectFindDialog, type ProjectFindHit } from "./project-find-dialog";
import { ResizableDrawer } from "./resizable-drawer";
import { ProjectReplaceDialog, type ReplacePreviewResult } from "./project-replace-dialog";
const LiteratureDiscoveryPanel = lazy(() =>
  import("./literature-discovery-panel").then((module) => ({ default: module.LiteratureDiscoveryPanel })),
);
import { baseArxivId } from "./arxiv-id";
import { type PdfSyncTarget } from "./pdf-viewer";
import { findAppendixMarker } from "./appendix-pages";
import { ManuscriptChecklistPanel } from "./manuscript-checklist";
import { mergeTodosWithBuffer, type TodoHit } from "./todo-scavenger";
import { TodoScavengerPanel } from "./todo-scavenger-panel";
import { referenceAssetPreviewDataUrl } from "./reference-preview";
import type {
  ProjectVenue,
  ProjectManifest,
  WordCount,
  UnusedSymbols,
  ReplaceResult,
  EditorViewState,
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
  OverleafLink,
  OverleafProbe,
  OverleafSyncResult,
} from "./app-types";
import {
  applyProjectPathChanges,
  arxivIdFromTabKey,
  autoBuildDescription,
  beginWindowDrag,
  canvasContentAt,
  confirmAction,
  classifyExternalProjectDrop,
  dropCanvasAt,
  dropDirectoryAt,
  dropEditorAt,
  editorPaneAt,
  isHtmlFilePath,
  isPreviewableSourceFilePath,
  isProjectAssetFilePath,
  isProjectSourceFilePath,
  isPaperTabKey,
  paperKey,
  paperTabKey,
  projectItemPath,
  remapProjectPath,
  stripFrontmatter,
  toMessage,
  toggleWindowFullscreen,
  type ProjectPathChange,
} from "./app-utils";
import {
  agentGitWorkspacePath,
  LATTICE_RESTORE_AGENT_CHECKPOINT,
  parseAgentProjectHistorySnapshot,
  synaraFrameUrl,
  type AgentGitWorkspaceView,
  type AgentCheckpointHistoryEntry,
} from "./synara-runtime";
import {
  buildAgentHostContext,
  LATTICE_HOST_CONTEXT_REQUEST,
  LATTICE_HOST_CONTEXT_SELECTION_CLEAR,
  type AgentHostContextSnapshot,
  type AgentHostSurface,
} from "./agent-host-context";
import {
  buildAgentPaperLibrary,
  LATTICE_PAPER_LIBRARY_REQUEST,
  type AgentPaperLibrarySnapshot,
} from "./agent-paper-library";
import { useSynaraRuntime } from "./use-synara-runtime";
import { SynaraLoadingSurface } from "./synara-loading-surface";
import { useSynaraNotificationBridge } from "./synara-notifications";
import { useSynaraConfirmationBridge } from "./synara-confirmations";
import {
  APP_WINDOW_MIN_HEIGHT,
  minimumWindowWidth,
} from "./window-layout";
import "./App.css";

const SettingsDialog = lazy(() =>
  import("./settings-dialog").then((module) => ({ default: module.SettingsDialog })),
);
const CollabDialog = lazy(() =>
  import("./collab-dialog").then((module) => ({ default: module.CollabDialog })),
);
const OverleafPickerDialog = lazy(() =>
  import("./overleaf-connect").then((module) => ({ default: module.OverleafPickerDialog })),
);
const OverleafReviewDialog = lazy(() =>
  import("./overleaf-review").then((module) => ({ default: module.OverleafReviewDialog })),
);
const ConflictResolverDialog = lazy(() =>
  import("./conflict-resolver").then((module) => ({ default: module.ConflictResolverDialog })),
);
const OverleafCollabDrawer = lazy(() =>
  import("./overleaf-collab").then((module) => ({ default: module.OverleafCollabDrawer })),
);
const loadDocumentCanvas = () => import("./document-canvas");
const DocumentCanvas = lazy(() =>
  loadDocumentCanvas().then((module) => ({ default: module.DocumentCanvas })),
);
const OnboardingTour = lazy(() =>
  import("./onboarding-tour").then((module) => ({ default: module.OnboardingTour })),
);

const EMPTY_DIAGNOSTICS: CompileDiagnostic[] = [];
const LATTICE_AGENT_PERMISSION_MODE_REQUEST = "lattice:request-agent-permission-mode";
const LATTICE_AGENT_PERMISSION_MODE_SET = "lattice:set-agent-permission-mode";
const LATTICE_AGENT_PANEL_OPENED = "lattice:agent-panel-opened";
const SYNARA_AGENT_PERMISSION_MODE_STATUS = "synara:agent-permission-mode";
const SYNARA_LAYOUT_METRICS = "synara:layout-metrics";
const SYNARA_EMBED_READY = "synara:embed-ready";
const SYNARA_OPEN_SETTINGS = "synara:open-settings";
const SYNARA_SIDEBAR_MINIMUM = 320;
const SYNARA_SIDEBAR_MAXIMUM_MINIMUM = 720;

type SynaraPermissionMode = "approval-required" | "auto" | "full-access";

const SYNARA_PERMISSION_PRESENTATION: Record<
  SynaraPermissionMode,
  { label: string; description: string }
> = {
  "full-access": {
    label: "Full access",
    description: "Run without asking for approval",
  },
  auto: {
    label: "Approve for me",
    description: "Ask only for potentially unsafe actions",
  },
  "approval-required": {
    label: "Ask for approval",
    description: "Ask before external edits and network access",
  },
};

function isSynaraPermissionMode(value: unknown): value is SynaraPermissionMode {
  return value === "approval-required" || value === "auto" || value === "full-access";
}

function SynaraPermissionIcon({ mode }: { mode: SynaraPermissionMode }) {
  if (mode === "full-access") return <ShieldCheck size={14} />;
  if (mode === "auto") return <Shield size={14} />;
  return <Hand size={14} />;
}

function SynaraPermissionPicker(props: {
  value: SynaraPermissionMode;
  autoModeAvailable: boolean;
  onChange: (value: SynaraPermissionMode) => void;
}) {
  const presentation = SYNARA_PERMISSION_PRESENTATION[props.value];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="agent-permission-trigger"
          aria-label={`Agent permissions: ${presentation.label}`}
          title={`Agent permissions: ${presentation.label}`}
        >
          <SynaraPermissionIcon mode={props.value} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={6} className="agent-permission-menu">
        <DropdownMenuRadioGroup value={props.value} onValueChange={(value) => {
          if (isSynaraPermissionMode(value)) props.onChange(value);
        }}>
          {(["full-access", "auto", "approval-required"] as const).map((mode) => {
            const option = SYNARA_PERMISSION_PRESENTATION[mode];
            return (
              <DropdownMenuRadioItem
                key={mode}
                value={mode}
                disabled={mode === "auto" && !props.autoModeAvailable}
                className="ui-radio-choice"
              >
                <span className="ui-radio-dot" aria-hidden="true" />
                <span className="agent-permission-copy">
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function synaraEmbedUrl(
  origin: string,
  authToken: string | null,
  projectRoot: string,
  theme: "light" | "dark",
): string {
  return synaraFrameUrl({
    origin,
    workspaceRoot: projectRoot,
    theme,
    surface: "chrome",
    hostOrigin: window.location.origin,
    authToken,
  });
}

function synaraSourceControlUrl(
  origin: string,
  authToken: string | null,
  projectRoot: string,
  theme: "light" | "dark",
  view: AgentGitWorkspaceView,
): string {
  return synaraFrameUrl({
    origin,
    path: agentGitWorkspacePath(view),
    workspaceRoot: projectRoot,
    theme,
    surface: "drawer",
    hostOrigin: window.location.origin,
    authToken,
  });
}

function collectAssetPaths(nodes: FileNode[], paths = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.kind === "figure" || node.contentKind === "binary" || node.contentKind === "symlink") paths.add(node.path);
    if (node.children.length) collectAssetPaths(node.children, paths);
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

function App() {
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const workspaceIndex = useMemo(
    () => new MarkdownWorkspaceIndex((path) => invoke<string>("read_project_file", { path })),
    [],
  );
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    let idleCallback: number | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const paths = flattenProjectPaths(project.files);
    const canvasModule = loadDocumentCanvas();

    // Chunk downloads can overlap the normal project setup without mounting
    // hidden previews or changing user-visible state.
    void canvasModule.then((module) => module.prewarmProjectPreviewModules(paths));
    void Promise.all([canvasModule, workspaceIndex.update(project.files)]).then(([module]) => {
      if (cancelled) return;
      const documents = workspaceIndex.previewDocuments();
      let nextDocument = 0;
      const warmNext = () => {
        if (cancelled) return;
        const document = documents[nextDocument++];
        if (!document) return;
        void module.prewarmMarkdownPreviewDocument(document.path, document.content)
          .finally(scheduleNext);
      };
      const scheduleNext = () => {
        if (cancelled || nextDocument >= documents.length) return;
        if ("requestIdleCallback" in window) {
          idleCallback = window.requestIdleCallback(warmNext, { timeout: 1_500 });
        } else {
          fallbackTimer = globalThis.setTimeout(warmNext, 120);
        }
      };
      scheduleNext();
    });
    return () => {
      cancelled = true;
      if (idleCallback != null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleCallback);
      }
      if (fallbackTimer != null) globalThis.clearTimeout(fallbackTimer);
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
  const projectBeforeTransitionRef = useRef<ProjectSnapshot | null>(null);
  const overleafSyncingRef = useRef(false);
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
    // A root-changing backend command may finish before React commits the new
    // snapshot. Nulling only the imperative identity closes that gap without
    // flashing the welcome screen or discarding the rendered old project.
    projectRef.current = null;
    return true;
  }, []);
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
  const [pdfSyncTarget, setPdfSyncTarget] = useState<PdfSyncTarget | null>(null);
  const [locatingPdf, setLocatingPdf] = useState(false);
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [diagnosticBuildSource, setDiagnosticBuildSource] = useState("");
  const [diagnosticBuildSecondarySource, setDiagnosticBuildSecondarySource] = useState("");
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [diagnosticsDismissed, setDiagnosticsDismissed] = useState(false);
  const [building, setBuilding] = useState(false);
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [citationKeys, setCitationKeys] = useState<string[]>([]);
  const [citations, setCitations] = useState<CitationInfo[]>([]);
  const [references, setReferences] = useState<ReferenceInfo[]>([]);
  const [unusedSymbols, setUnusedSymbols] = useState<UnusedSymbols>({ labels: [], citations: [] });
  const [openTabs, setOpenTabs] = useState<string[]>([]);
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
  const viewStateRef = useRef(new Map<string, EditorViewState>());
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
  const [quickOpenOpen, setQuickOpenOpen] = useState(false);
  const [gotoLineOpen, setGotoLineOpen] = useState(false);
  const [wrapEnvRequest, setWrapEnvRequest] = useState<{ name: string; id: string } | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const openCompileDiagnosticRef = useRef<(diagnostic: CompileDiagnostic) => Promise<void>>(async () => undefined);
  const referencePreviewCache = useRef(new Map<string, Promise<string | null>>());
  const [activePaper, setActivePaper] = useState<PaperSummary | null>(null);
  const [paperMarkdown, setPaperMarkdown] = useState("");
  const [savedPaperMarkdown, setSavedPaperMarkdown] = useState("");
  // The alphaXiv overview ("blog") is the default reading view; null when the
  // paper has no report. `paperView` picks which of blog/full-text is shown.
  const [paperBlog, setPaperBlog] = useState<string | null>(null);
  const [savedPaperBlog, setSavedPaperBlog] = useState<string | null>(null);
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
  const setActivePaperSource = useCallback((value: string) => {
    if (paperView === "blog") setPaperBlog(value);
    else setPaperMarkdown(value);
  }, [paperView]);
  const [activeAsset, setActiveAsset] = useState<AssetPreview | null>(null);
  const [nativeEditorDropActive, setNativeEditorDropActive] = useState(false);
  const [fileDropTargetPane, setFileDropTargetPane] = useState<EditorPaneId | null>(null);
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
  const [editorNavigation, setEditorNavigation] = useState<EditorNavigation | null>(null);
  const [projectWordCount, setProjectWordCount] = useState<WordCount | null>(null);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [pdfPageNumber, setPdfPageNumber] = useState(1);
  const [mainBodyPages, setMainBodyPages] = useState<number | null>(null);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [importInput, setImportInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [paperFetchStates, setPaperFetchStates] = useState<Record<string, "loading" | "success">>({});
  const paperFetchTimers = useRef<Record<string, number>>({});
  const [assetImporting, setAssetImporting] = useState(false);
  const [assetDropTarget, setAssetDropTarget] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [agentHistoryByThread, setAgentHistoryByThread] = useState<
    Record<string, AgentCheckpointHistoryEntry[]>
  >({});
  const [activeAgentHistoryThreadId, setActiveAgentHistoryThreadId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitWorkspaceView, setGitWorkspaceView] =
    useState<AgentGitWorkspaceView>("changes");
  const [todosOpen, setTodosOpen] = useState(false);
  const [diskTodos, setDiskTodos] = useState<TodoHit[]>([]);
  const [editorComments, setEditorComments] = useState<EditorComment[]>([]);
  const [editorCommentsOpen, setEditorCommentsOpen] = useState(false);
  const [activeEditorCommentId, setActiveEditorCommentId] = useState<string | null>(null);
  const [commentPanelFocusId, setCommentPanelFocusId] = useState<string | null>(null);
  const [commentFocusRequest, setCommentFocusRequest] = useState<{ id: string; nonce: string } | null>(null);
  const editorCommentAuthorId = useMemo(() => loadEditorCommentAuthorId(), []);
  const [literatureOpen, setLiteratureOpen] = useState(false);
  const [bibResolveSeed, setBibResolveSeed] = useState("");
  const [bibEntryMode, setBibEntryMode] = useState<"add" | "edit">("add");
  const [bibEntryInitial, setBibEntryInitial] = useState<ResolvedCitationDraft | undefined>(undefined);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [insertOpen, setInsertOpen] = useState(false);
  const insertTargetPath = focusedPane === "secondary" && secondaryFile ? secondaryFile : activeFile;
  const canInsert = !activePaper
    && !activeAsset
    && /\.(?:tex|sty|cls|txt)$/i.test(insertTargetPath);
  const [collabOpen, setCollabOpen] = useState(false);
  const [collabMode, setCollabMode] = useState<CollabDialogMode>("start");
  const [collabHost, setCollabHost] = useState(loadCollabHost);
  const [collabRoom, setCollabRoom] = useState("");
  const [collabInvite, setCollabInvite] = useState("");
  const [collabName, setCollabName] = useState(loadCollabDisplayName);
  const [recentProjectsV2, setRecentProjectsV2] = useState<CollabProjectRecordV2[]>(loadCollabProjectsV2);
  const refreshRecentRooms = useCallback(() => { setRecentProjectsV2(loadCollabProjectsV2()); }, []);
  const [collabStatus, setCollabStatus] = useState<CollabStatus>("disconnected");
  const [collabStatusDetail, setCollabStatusDetail] = useState<string | null>(null);
  const [collabSession, setCollabSession] = useState<EditorCollabSession | null>(null);
  const [collabCanWrite, setCollabCanWrite] = useState(true);
  const [activeCollabVersion, setActiveCollabVersion] = useState<2 | null>(null);
  // True only after the shared doc has been seeded (host) / materialized (guest).
  // The editor must not bind yCollab before this: binding early makes the guest
  // create a competing main.tex Y.Text that loses the map key to the host's copy,
  // orphaning the editor on the "Waiting for shared project files" placeholder.
  const [collabReady, setCollabReady] = useState(false);
  const [collabPeerList, setCollabPeerList] = useState<CollabPeer[]>([]);
  const collabPeers = collabPeerList.length;
  const [collabFileCount, setCollabFileCount] = useState(0);
  const [overleafPickerOpen, setOverleafPickerOpen] = useState(false);
  const [overleafLink, setOverleafLink] = useState<OverleafLink | null>(null);
  const [overleafSyncing, setOverleafSyncing] = useState(false);
  const [overleafSyncMode, setOverleafSyncMode] = useState<OverleafSyncMode>(loadOverleafSyncMode);
  const [overleafRemoteDelete, setOverleafRemoteDelete] = useState<OverleafRemoteDelete>(
    loadOverleafRemoteDelete,
  );
  const [overleafRemoteChanges, setOverleafRemoteChanges] = useState(false);
  const [overleafReviewOpen, setOverleafReviewOpen] = useState(false);
  const [overleafCollabOpen, setOverleafCollabOpen] = useState(false);
  const [overleafCollabTab, setOverleafCollabTab] = useState<OverleafCollabTab>("comments");
  /** Bumped whenever a save actually writes, so pushes follow real edits. */
  const [saveGeneration, setSaveGeneration] = useState(0);
  const [conflictPath, setConflictPath] = useState<string | null>(null);
  const overleafAutoSyncedRoot = useRef<string | null>(null);
  const overleafSyncRef = useRef<(options?: { auto?: boolean }) => Promise<void>>(async () => {});
  /** Marks a comment that lives on Overleaf rather than in this project. */
  const OVERLEAF_COMMENT_PREFIX = "overleaf:";
  const overleafCommentsRef = useRef<OverleafComments>(null as unknown as OverleafComments);
  /** Files the realtime channel owns; syncing must not touch them. */
  const overleafLivePathsRef = useRef<string[]>([]);
  /** Whether the realtime channel is up, for the poll loop to read. */
  const overleafChannelLiveRef = useRef(false);
  /** Path → Overleaf's id and kind, which is what its endpoints take. */
  const overleafEntitiesRef = useRef<Map<string, { id: string; kind: string }>>(new Map());
  const overleafRemoteDeleteRef = useRef<OverleafRemoteDelete>("ask");
  /** How often live mode asks Overleaf whether anything changed. */
  const OVERLEAF_LIVE_POLL_MS = 3_000;
  /** Quiet time after a save before local work is pushed up. */
  const OVERLEAF_PUSH_DEBOUNCE_MS = 2_500;
  /** Cadence when Overleaf gives us no cheap way to detect a change. */
  const OVERLEAF_BLIND_POLL_MS = 120_000;
  /**
   * Cadence once the realtime channel is up. Documents arrive as operations
   * then, so polling only has figures and newly added files left to catch —
   * and every "yes" costs a full project download, which is what earned a 429.
   */
  const OVERLEAF_CHANNEL_POLL_MS = 45_000;
  /**
   * Floor between full syncs. Overleaf allows ten project downloads a minute
   * and answers 429 past that; a collaborator typing steadily moves the
   * project version on every poll, so without a floor live mode would ask for
   * the whole project every three seconds and get itself locked out.
   */
  const OVERLEAF_MIN_SYNC_GAP_MS = 12_000;
  /**
   * The same floor once the channel is up. Documents already travel as
   * operations then, so this sweep is only carrying figures and files added
   * outside the editor, and it can afford to be leisurely.
   */
  const OVERLEAF_CHANNEL_SYNC_GAP_MS = 30_000;
  const lastAutoSyncRef = useRef(0);
  const lastAutoVersionRef = useRef(0);
  const [collabRole, setCollabRole] = useState<"host" | "guest">("host");
  const collabRoleRef = useRef<"host" | "guest">("host");
  const collabSessionRef = useRef<EditorCollabSession | null>(null);
  const collabV2ControllerRef = useRef<CollabProjectControllerV2 | null>(null);
  const collabV2InvitationRef = useRef("");
  const collabV2TreeSignatureRef = useRef<string | null>(null);
  const collabWorkspaceGenerationRef = useRef(0);
  const collabWorkspaceLeaseRef = useRef<CollabWorkspaceLease | null>(null);
  const collabDiskWriteQueueRef = useRef(new CollabDiskWriteQueue());
  const collabDetachRef = useRef<(() => void) | null>(null);
  // The provider re-fires "sync" on every reconnect. Guard the one-time
  // seed/materialize so a network blip does not re-materialize the whole doc
  // over local disk and yank the open tab back to the root document.
  const collabInitializedRef = useRef(false);
  const collabLeavingRef = useRef(false);
  const preCollabProjectRootRef = useRef<string | null>(null);
  const projectRootRef = useRef<string | null>(null);
  const enterProjectRef = useRef<((
    snapshot: ProjectSnapshot,
    options?: { skipCollabLifecycle?: boolean; deferInitialBuild?: boolean },
  ) => Promise<void>) | null>(null);
  const compileRef = useRef<(force?: boolean) => Promise<void>>(async () => undefined);
  const activeFileRef = useRef(activeFile);
  const secondaryFileRef = useRef(secondaryFile);
  const htmlViewModesRef = useRef(new Map<string, DocumentViewMode>());
  const documentModeRef = useRef<DocumentViewMode>("split");
  activeFileRef.current = activeFile;
  secondaryFileRef.current = secondaryFile;
  useEffect(() => {
    if (
      !activePaper
      && !activeAsset
      && activeFile
      && isPreviewableSourceFilePath(activeFile)
      && !isHtmlFilePath(activeFile)
      && canvasMode !== "asset"
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
  const [texSetupOpen, setTexSetupOpen] = useState(false);
  const [texSetupStatus, setTexSetupStatus] = useState<string | null>(null);
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
  const {
    runtime: synaraRuntime,
    retry: retrySynaraRuntime,
  } = useSynaraRuntime();
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
    if (!previousSource) {
      if (dismissedSelectionRef.current?.source === surface) {
        dismissedSelectionRef.current = null;
      }
      return;
    }
    dismissedSelectionRef.current =
      previousSource !== surface && selection
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
          activeSurface: agentActiveSurface,
        })
      : null,
    [
      activeFile,
      agentActiveSurface,
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
        setSettingsTab("agent");
        setSettingsOpen(true);
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
      const historySnapshot = parseAgentProjectHistorySnapshot(event.data);
      if (historySnapshot) {
        setAgentHistoryByThread((current) => ({
          ...current,
          [historySnapshot.activeThreadId]: historySnapshot.entries,
        }));
        setActiveAgentHistoryThreadId(historySnapshot.activeThreadId);
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
      try {
        const [snapshotResult, gitStatusResult] = await Promise.allSettled([
          invoke<ProjectSnapshot>("refresh_project"),
          invoke<GitStatus>("git_status"),
        ]);
        const currentProject = projectRef.current;
        if (
          !stopped
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
    const timer = window.setInterval(() => { void refreshProjectTreeState(); }, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [project?.root, sidebarMode]);
  // Remember the file open per project, so reopening it lands on the last page.
  useEffect(() => {
    if (project?.root && activeFile) persistLastFile(project.root, activeFile);
  }, [project?.root, activeFile]);
  const { theme, setTheme, appearance, setAppearance } = useAppearance();
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
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const startProjectTransition = useCallback(() => {
    if (beginProjectTransition()) return true;
    setNotice("Overleaf sync is finishing. Try switching projects again in a moment.");
    return false;
  }, [beginProjectTransition]);
  useEffect(() => {
    if (!warning) return;
    const timer = window.setTimeout(() => setWarning(null), 4500);
    return () => window.clearTimeout(timer);
  }, [warning]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [notice]);

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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const saveTimer = useRef<number | null>(null);
  const automaticBuildPending = useRef(false);
  const buildingRef = useRef(false);
  const buildQueued = useRef(false);
  const shellRef = useRef<HTMLDivElement | null>(null);

  const rememberProject = useCallback((snapshot: ProjectSnapshot) => {
    setRecentProjects((items) => {
      const next = [
        { name: snapshot.manifest.name, path: snapshot.root },
        ...items.filter((item) => item.path !== snapshot.root),
      ].slice(0, 8);
      persistRecentProjects(next);
      return next;
    });
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
    const mayApply = (snapshotRoot?: string) => !scope || (
      projectOperationGenerationRef.current === scope.generation
      && projectRef.current?.root === scope.expectedRoot
      && (snapshotRoot === undefined || snapshotRoot === scope.expectedRoot)
    );
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
    const snapshot = await invoke<ProjectSnapshot>("refresh_project");
    setProject(snapshot);
    return snapshot;
  }, []);

  const diskMtimeRef = useRef<number | null>(null);
  const sourceRef = useRef(source);
  const savedSourceRef = useRef(savedSource);
  sourceRef.current = source;
  savedSourceRef.current = savedSource;

  const markDiskMtime = useCallback(async (path: string) => {
    try {
      const stat = await invoke<{ exists: boolean; mtimeMs: number }>("stat_project_file", { path });
      diskMtimeRef.current = stat.exists ? stat.mtimeMs : null;
    } catch {
      diskMtimeRef.current = null;
    }
  }, []);

  const loadFile = useCallback(async (
    path: string,
    options?: {
      restoreView?: boolean;
      revealSource?: boolean;
      expectedProjectRoot?: string;
      projectGeneration?: number;
    },
  ) => {
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
    try {
      const v2 = collabV2ControllerRef.current;
      if (v2?.hasTextPath(path) && (activeCollabVersion === 2 || collabSessionRef.current === v2)) {
        const ytext = await v2.openPath(path);
        const content = ytext.toString();
        setActiveFile(path);
        setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
        setSource(content);
        setSavedSource(content);
        setActivePaper(null);
        setActiveAsset(null);
        setCollabSession(v2);
        setCollabReady(true);
        showLoadedDocument();
        collabDetachRef.current?.();
        const writeRemote = (remote: string) => {
          const lease = collabWorkspaceLeaseRef.current;
          if (!lease?.isCurrent()) return;
          void collabDiskWriteQueueRef.current.run(lease, path, () => invoke("write_project_file", { path, content: remote, projectRoot: lease.projectRoot }))
            .then(() => { if (lease.isCurrent()) setSavedSource(remote); })
            .catch((reason) => { if (lease.isCurrent()) setError(toMessage(reason)); });
        };
        if (path.toLocaleLowerCase().endsWith(".tldr")) {
          // The v2 controller owns board materialization for both local and
          // remote record edits; a second active-file observer duplicates writes.
          collabDetachRef.current = null;
        } else {
          const onText = (_event: unknown, transaction: { local: boolean }) => {
            if (transaction.local) return;
            writeRemote(ytext.toString());
          };
          ytext.observe(onText);
          collabDetachRef.current = () => ytext.unobserve(onText);
        }
        await markDiskMtime(path);
        return;
      }
      const content = await invoke<string>("read_project_file", { path });
      if (
        options?.expectedProjectRoot
        && (
          projectRef.current?.root !== options.expectedProjectRoot
          || projectOperationGenerationRef.current !== options.projectGeneration
        )
      ) {
        return;
      }
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
      setError(null);
      await markDiskMtime(path);
      // Where you last were in this file, unless the caller is about to send
      // you somewhere specific in it. Both land as requests the editor answers
      // on the next frame, and the restore is applied second, so asking for
      // both means the remembered position quietly wins and the jump is lost.
      const saved = options?.restoreView === false ? undefined : viewStateRef.current.get(path);
      if (saved) {
        setViewRestore({ path, cursor: saved.cursor, scrollTop: saved.scrollTop, id: crypto.randomUUID() });
      }
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeCollabVersion, markDiskMtime]);

  const clearCollabLocalState = useCallback(async () => {
    const session = collabSessionRef.current;
    try {
      await session?.flush?.();
    } finally {
      collabWorkspaceGenerationRef.current += 1;
      collabWorkspaceLeaseRef.current = null;
      collabInitializedRef.current = false;
      setCollabReady(false);
      collabDetachRef.current?.();
      collabDetachRef.current = null;
      if (session) session.destroy();
      collabV2ControllerRef.current = null;
      collabSessionRef.current = null;
      collabV2TreeSignatureRef.current = null;
      setCollabSession(null);
      setActiveCollabVersion(null);
      setCollabStatus("disconnected");
      setCollabStatusDetail(null);
      setCollabPeerList([]);
      setCollabFileCount(0);
    }
  }, []);

  const restorePreCollabProject = useCallback(async () => {
    const prior = resolvePreCollabProjectRoot(
      preCollabProjectRootRef.current,
      recentProjects.map((item) => item.path),
    );
    preCollabProjectRootRef.current = null;
    clearPreCollabProjectRoot();
    if (!prior) {
      setNotice("Share ended. Open one of your projects from the menu.");
      return;
    }
    setBusyLabel("Returning to your project…");
    try {
      // Skip lifecycle so we do not re-enter leave/end while restoring.
      if (!startProjectTransition()) return;
      await enterProjectRef.current?.(
        await invoke<ProjectSnapshot>("open_project", { path: prior }),
        { skipCollabLifecycle: true },
      );
      setNotice("Returned to your previous project");
    } catch {
      cancelProjectTransition();
      setNotice("Share ended. Open one of your projects from the menu.");
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, recentProjects, startProjectTransition]);

  const endHostShareSession = useCallback(async (noticeText: string) => {
    if (collabLeavingRef.current) return;
    collabLeavingRef.current = true;
    try {
      if (activeCollabVersion === 2 && collabRoleRef.current === "host") {
        await collabV2ControllerRef.current?.close();
      }
      await clearCollabLocalState();
      setNotice(noticeText);
      setCollabOpen(false);
      // Peers edited these files during the session; re-read from disk so the
      // navigator, papers and citations reflect what is actually there now.
      try {
        await refreshProject();
      } catch {
        // A refresh failure must not block ending the share.
      }
    } finally {
      collabLeavingRef.current = false;
    }
  }, [activeCollabVersion, clearCollabLocalState, refreshProject, refreshRecentRooms]);

  const leaveGuestShareSession = useCallback(async (noticeText: string, restorePrior: boolean) => {
    if (collabLeavingRef.current) return;
    collabLeavingRef.current = true;
    try {
      await clearCollabLocalState();
      setCollabOpen(false);
      if (restorePrior) {
        setNotice(noticeText);
        await restorePreCollabProject();
      } else {
        preCollabProjectRootRef.current = null;
        clearPreCollabProjectRoot();
        setNotice(noticeText);
      }
    } finally {
      collabLeavingRef.current = false;
    }
  }, [clearCollabLocalState, restorePreCollabProject]);


  /** Dialog button: host stops for everyone; guest leaves without affecting the host. */
  const disconnectCollab = useCallback(() => {
    if (collabRoleRef.current === "host") {
      void endHostShareSession("Stopped sharing");
      return;
    }
    void leaveGuestShareSession("Left the shared session", true);
  }, [endHostShareSession, leaveGuestShareSession]);

  const settleCollabBeforeProjectSwitch = useCallback(async (nextRoot: string) => {
    const session = collabSessionRef.current;
    if (!session) return;
    const currentRoot = projectRootRef.current;
    if (currentRoot && currentRoot === nextRoot) return;
    if (collabRoleRef.current === "host") {
      // Switching projects only detaches the host locally — like closing the
      // app — instead of ending the room for everyone. The others keep editing,
      // the room stays in the recent-shares list, and the host can rejoin it.
      // Only "Stop sharing" ends the session for all.
      await clearCollabLocalState();
      setCollabOpen(false);
      setNotice("Left the share — it keeps running; rejoin it from Live collaboration");
      return;
    }
    // Guest opened a different project: leave quietly; host keeps sharing.
    await leaveGuestShareSession("Left the shared session", false);
  }, [clearCollabLocalState, leaveGuestShareSession]);


  const mapV2Status = useCallback((status: CollabProjectStatusV2) => {
    const mapped: CollabStatus = status === "error" ? "error" : status === "durable" || status === "server-received" ? "synced" : "connecting";
    setCollabStatus(mapped);
    setCollabStatusDetail(status === "importing" ? "Importing all project files…" : null);
  }, []);

  /**
   * v2 catalog push (peer create/rename/delete, grants, lifecycle): keep the
   * file count live, and refresh the on-disk project tree when the live path
   * set changes — the controller reconciles the tree onto disk before this
   * fires. The first callback after join only records the baseline; the
   * materialize flow refreshes the tree itself.
   */
  const handleV2Catalog = useCallback((catalog: CatalogV2) => {
    const livePaths = catalog.files.filter((file) => file.state === "live").map((file) => file.path).sort();
    setCollabFileCount(livePaths.length);
    const signature = livePaths.join("\n");
    if (collabV2TreeSignatureRef.current === null) {
      collabV2TreeSignatureRef.current = signature;
      return;
    }
    if (collabV2TreeSignatureRef.current !== signature) {
      collabV2TreeSignatureRef.current = signature;
      void refreshProject().catch(() => undefined);
    }
  }, [refreshProject]);

  /**
   * Disk callbacks for a v2 workspace: initial materialization plus peer tree
   * reconciliation (create/rename/delete pulled from the catalog event stream).
   * Rename covers arbitrary path changes by composing move + rename.
   */
  const v2WorkspaceCallbacks = useCallback((lease: CollabWorkspaceLease): CollabMaterializeCallbacksV2 => ({
    writeText: (path, content, projectRoot) => collabDiskWriteQueueRef.current.run(lease, path, () => invoke("write_project_file", { path, content, projectRoot })),
    writeBytes: (path, bytes, projectRoot) => collabDiskWriteQueueRef.current.run(lease, path, () => invoke("write_project_bytes", { path, base64Data: bytesToBase64(bytes), projectRoot })),
    delete: (path, projectRoot) => collabDiskWriteQueueRef.current.run(lease, path, () => invoke("delete_project_entry", { path, projectRoot })),
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
  }), []);

  /**
   * Push a non-active text buffer into the v2 session and onto disk. Sideload:
   * publishing must not steal the session's active file (editor binding,
   * awareness path) from whatever the user is editing. Returns false when the
   * file is not live in the share (no session, or a path outside the catalog),
   * so the caller can fall back to a plain local write.
   */
  const publishTextToCollabV2 = useCallback(async (path: string, content: string): Promise<boolean> => {
    const controller = collabV2ControllerRef.current;
    if (activeCollabVersion !== 2 || !controller || path.toLocaleLowerCase().endsWith(".tldr")) return false;
    if (!controller.hasTextPath(path)) return false;
    const ytext = await controller.openPath(path, "secondary", { sideload: true });
    // Minimal-span merge, not delete-all + insert-all: a peer's concurrent
    // edits outside the changed span survive, and the local origin keeps disk
    // observers from rewriting the file we are about to write ourselves.
    mergeTextIntoYText(ytext, content);
    const lease = collabWorkspaceLeaseRef.current;
    const projectRoot = lease?.projectRoot ?? projectRootRef.current;
    if (!projectRoot) throw new Error("The project closed before the file could be written.");
    await invoke("write_project_file", { path, content: ytext.toString(), projectRoot });
    return true;
  }, [activeCollabVersion]);

  /**
   * Register a locally created file with the live v2 share so collaborators
   * receive it: catalog create (the host then marks it live), then content —
   * a text seed for text/board files, a binary upload for figures. No-ops
   * outside a share; on failure the file stays local-only (the pre-existing
   * behavior) and the user gets a warning naming the file.
   */
  const shareCreatedFileWithCollabV2 = useCallback(async (path: string, kind: "text" | "binary" | "board") => {
    const controller = collabV2ControllerRef.current;
    if (activeCollabVersion !== 2 || !controller) return;
    try {
      if (kind === "binary") {
        const asset = await invoke<AssetPreview>("read_project_asset", { path });
        const bytes = Uint8Array.from(atob(asset.base64), (character) => character.charCodeAt(0));
        const conflictWriter = {
          rename: async () => { throw new Error("Unexpected rename during binary publish"); },
          delete: async () => { throw new Error("Unexpected delete during binary publish"); },
          writeBinaryConflict: async (conflictPath: string, conflictBytes: Uint8Array, projectRoot: string) => {
            await collabDiskWriteQueueRef.current.run(collabWorkspaceLeaseRef.current!, conflictPath, () => invoke("write_project_bytes", { path: conflictPath, base64Data: bytesToBase64(conflictBytes), projectRoot }));
          },
        };
        // Importing over an already-shared path is a content update, not a create.
        if (!controller.catalogFiles().some((entry) => entry.path === path && entry.state === "live")) {
          await controller.create(path, "binary");
        }
        await controller.replaceBinary(path, bytes, asset.mimeType, conflictWriter);
      } else {
        const seed = await invoke<string>("read_project_file", { path });
        // Boards keep live state in the doc's records, not the content text,
        // so an import over a shared .tldr leaves the shared doc as-is.
        if (controller.hasTextPath(path)) {
          if (kind !== "board") await publishTextToCollabV2(path, seed);
        } else {
          await controller.create(path, kind, { seedText: seed || undefined });
        }
      }
    } catch (reason) {
      setError(`${path} was created locally but could not be shared: ${toMessage(reason)}. Restart the share to include it.`);
    }
  }, [activeCollabVersion, publishTextToCollabV2]);

  const startCollabShare = useCallback(() => {
    if (!collabName.trim()) {
      setError("Enter your name before starting a share.");
      setCollabOpen(true);
      return;
    }
    if (!project) {
      setError("Open a project before starting live collaboration.");
      return;
    }
    void (async () => {
        setCollabStatus("connecting");
        setCollabStatusDetail("Importing all project files…");
        try {
          const resolved = resolveCollabHost(collabHost);
          saveCollabHost(resolved);
          saveCollabDisplayName(collabName.trim());
          const deployment = new URL(resolved.includes("://") ? resolved : `https://${resolved}`).origin;
          const nativeInventory = await invoke<{ files: Array<{ path: string; contentKind: "text" | "binary"; size: number }>; excluded: Array<{ pathOrPattern: string; reason: string }> }>("collab_project_inventory_v2");
          if (nativeInventory.excluded.length) {
            const details = nativeInventory.excluded.map(item => `• ${item.pathOrPattern} — ${item.reason}`).join("\n");
            if (!window.confirm(`Some project items won't be included in this share:\n\n${details}\n\nContinue with the listed regular files?`)) {
              setCollabStatus("disconnected");
              setCollabStatusDetail(null);
              return;
            }
          }
          const inventory = nativeInventory.files.map(item => ({ path: item.path, kind: item.contentKind }));
          const kinds = new Map(inventory.map((item) => [item.path, item.kind]));
          const store = collabCredentialStore();
          const record = await createProjectV2({
            deployment,
            credentialStore: store,
            source: {
              inventory: async () => inventory,
              read: async (path) => {
                if (kinds.get(path) === "text") return new TextEncoder().encode(await invoke<string>("read_project_file", { path }));
                const asset = await invoke<AssetPreview>("read_project_asset", { path });
                return Uint8Array.from(atob(asset.base64), (character) => character.charCodeAt(0));
              },
            },
            onRecord: async (created) => rememberCollabProjectV2({ version: 2, projectInstanceId: created.projectInstanceId, host: created.deployment, credentialRef: created.credentialRef, permission: "host", title: project.root.split(/[/\\]/).filter(Boolean).pop() || "Shared project", projectRoot: project.root, lastUsed: Date.now() }),
          });
          const controller = await CollabProjectControllerV2.start({ deployment, projectInstanceId: record.projectInstanceId, credentialRef: record.credentialRef, credentialStore: store, permission: "host", onStatus: mapV2Status, onCatalog: handleV2Catalog, displayName: collabName, onPeers: setCollabPeerList });
          const path = controller.hasTextPath(activeFile || "") ? activeFile : controller.catalogTextPaths()[0];
          if (!path) throw new Error("The shared project has no text files");
          await controller.openPath(path);
          const workspaceGeneration = collabWorkspaceGenerationRef.current + 1;
          collabWorkspaceGenerationRef.current = workspaceGeneration;
          collabWorkspaceLeaseRef.current = {
            projectRoot: project.root,
            generation: workspaceGeneration,
            isCurrent: () => collabWorkspaceGenerationRef.current === workspaceGeneration && projectRootRef.current === project.root,
          };
          controller.bindWorkspace(collabWorkspaceLeaseRef.current, v2WorkspaceCallbacks(collabWorkspaceLeaseRef.current));
          collabV2ControllerRef.current = controller;
          collabSessionRef.current = controller;
          collabRoleRef.current = "host";
          setCollabRole("host");
          setActiveCollabVersion(2);
          setCollabRoom(controller.room);
          setCollabSession(controller);
          setCollabFileCount(controller.fileCount());
          setCollabReady(true);
          await loadFile(path);
          const invitation = await controller.createInvitation("write");
          collabV2InvitationRef.current = invitation;
          await writeText(invitation);
          setCollabStatus("synced");
          setNotice("Started v2 project share · invite copied");
        } catch (reason) {
          setCollabStatus("error");
          setCollabStatusDetail("Import failed — retry Start sharing");
          setError(toMessage(reason));
        }
      })();
  }, [activeFile, collabHost, collabName, handleV2Catalog, loadFile, mapV2Status, project, v2WorkspaceCallbacks]);

  const copyCollabInvite = useCallback(async () => {
    if (collabV2InvitationRef.current) await writeText(collabV2InvitationRef.current);
    setNotice("Invite copied");
  }, []);

  const openCollabDialog = useCallback((mode: CollabDialogMode = "start") => {
    // Only an explicit "join" opens Join; guard against a stray event object
    // (e.g. an onClick handler) landing here and leaving neither tab selected.
    setCollabMode(mode === "join" ? "join" : "start");
    setCollabHost(resolveCollabHost(collabHost));
    refreshRecentRooms();
    setCollabOpen(true);
  }, [collabHost, refreshRecentRooms]);

  useEffect(() => {
    if (!collabSession) return;
    return () => {
      collabDetachRef.current?.();
      collabDetachRef.current = null;
      void (collabSession.flush?.() ?? Promise.resolve())
        .catch(() => undefined)
        .finally(() => collabSession.destroy());
    };
  }, [collabSession]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!project) return true;
    try {
      const workspaceLease = collabSession ? collabWorkspaceLeaseRef.current : null;
      let wroteTex = false;
      let wroteBib = false;
      let wrotePaper = false;
      if (activeFile && source !== savedSource) {
        if (workspaceLease) {
          await collabDiskWriteQueueRef.current.run(workspaceLease, activeFile, () => invoke(
            "write_project_file",
            { path: activeFile, content: source, projectRoot: workspaceLease.projectRoot },
          ));
        } else {
          await invoke("write_project_file", {
            path: activeFile,
            content: source,
            projectRoot: project.root,
          });
        }
        // Do NOT push the active buffer into Yjs here. It is already synced
        // character-by-character by yCollab. Re-publishing it as a full
        // delete+insert of the whole Y.Text on every autosave collapses remote
        // carets and bounces recompiles between peers (the "cursors freeze /
        // PDF re-renders forever" bug). The disk write + savedSource are all the
        // active file needs; non-active buffers below still push explicitly.
        setSavedSource(source);
        if (activeCollabVersion === 2) await collabV2ControllerRef.current?.settled();
        await markDiskMtime(activeFile);
        wroteTex = wroteTex || activeFile.endsWith(".tex");
        wroteBib = wroteBib || activeFile === project.manifest.primaryBibliography;
      }
      if (secondaryFile && secondarySource !== secondarySavedSource) {
        // Sideload: saving must not steal the session's active file (and its
        // editor binding / awareness path) from the primary buffer.
        const published = await publishTextToCollabV2(secondaryFile, secondarySource);
        if (!published) {
          await invoke("write_project_file", {
            path: secondaryFile,
            content: secondarySource,
            projectRoot: project.root,
          });
        }
        setSecondarySavedSource(secondarySource);
        wroteTex = wroteTex || secondaryFile.endsWith(".tex");
        wroteBib = wroteBib || secondaryFile === project.manifest.primaryBibliography;
      }
      if (activePaper && paperMarkdown !== savedPaperMarkdown) {
        const path = `.research/papers/${activePaper.arxivId}/paper.md`;
        const published = await publishTextToCollabV2(path, paperMarkdown);
        if (!published) {
          await invoke("write_project_file", {
            path,
            content: paperMarkdown,
            projectRoot: project.root,
          });
        }
        setSavedPaperMarkdown(paperMarkdown);
        wrotePaper = true;
      }
      if (activePaper && paperBlog !== null && paperBlog !== savedPaperBlog) {
        const path = `.research/papers/${activePaper.arxivId}/blog.md`;
        const published = await publishTextToCollabV2(path, paperBlog);
        if (!published) {
          await invoke("write_project_file", {
            path,
            content: paperBlog,
            projectRoot: project.root,
          });
        }
        setSavedPaperBlog(paperBlog);
        wrotePaper = true;
      }
      if (
        !wroteTex
        && !wroteBib
        && !wrotePaper
        && source === savedSource
        && secondarySource === secondarySavedSource
      ) {
        return true;
      }
      setSaveGeneration((generation) => generation + 1);
      // Saving must only wait for durable writes. The derived sidebars are
      // useful, but making file switches and builds wait on six independent
      // project scans turned every save into a visible pause.
      refreshAfterSave(project.root, wroteTex, wroteBib);
      return true;
    } catch (reason) {
      setError(toMessage(reason));
      return false;
    }
  }, [
    activeFile,
    activePaper,
    activeCollabVersion,
    collabSession,
    markDiskMtime,
    paperBlog,
    paperMarkdown,
    project,
    refreshAfterSave,
    savedPaperBlog,
    savedPaperMarkdown,
    savedSource,
    secondaryFile,
    secondarySavedSource,
    secondarySource,
    source,
  ]);

  const secondarySourceRef = useRef(secondarySource);
  const secondarySavedRef = useRef(secondarySavedSource);
  secondarySourceRef.current = secondarySource;
  secondarySavedRef.current = secondarySavedSource;
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
  ) => {
    const keepDocumentMode = (mode: CanvasMode): CanvasMode => (
      mode === "pdf" || mode === "asset" ? "split" : mode
    );
    const requestedPane = targetPane ?? focusedPane;
    const secondaryFocused = (canvasMode === "dual" || canvasMode === "columns")
      && requestedPane === "secondary"
      && !activePaper
      && !activeAsset;
    if (secondaryFocused) {
      if (activeCollabVersion === 2) {
        try {
          if (secondaryFile && secondarySource !== secondarySavedSource && !(await save())) return;
          const controller = collabV2ControllerRef.current;
          if (!controller?.hasTextPath(path)) throw new Error(`${path} is not a v2 text file`);
          const ytext = await controller.openPath(path, "secondary");
          const content = ytext.toString();
          setSecondaryFile(path);
          setSecondarySource(content);
          setSecondarySavedSource(content);
          setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
          setFocusedPane("secondary");
          setError(null);
        } catch (reason) {
          setError(toMessage(reason));
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
        const content = await invoke<string>("read_project_file", { path });
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
        setError(toMessage(reason));
      }
      return;
    }
    const alreadyOpen = path === activeFile && !activePaper && !activeAsset;
    if (alreadyOpen) {
      setFocusedPane("primary");
      if (line) {
        setEditorNavigation({ path, line, id: crypto.randomUUID() });
        setCanvasMode(keepDocumentMode);
        pushNavigation(path, line);
      }
      return;
    }
    if (activeFile && !activePaper && !activeAsset) {
      const current = viewStateRef.current.get(activeFile);
      viewStateRef.current.set(activeFile, {
        cursor: current?.cursor ?? 0,
        scrollTop: current?.scrollTop ?? 0,
      });
    }
    if (
      activePaperDirty
      || source !== savedSource
      || (secondaryFile && secondarySource !== secondarySavedSource)
    ) {
      const saved = await save();
      if (!saved) return;
    }
    await loadFile(path, { restoreView: !line, revealSource: true });
    setFocusedPane("primary");
    if (line) {
      setEditorNavigation({ path, line, id: crypto.randomUUID() });
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
    collabSession,
    focusedPane,
    loadFile,
    project?.root,
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
    // Go through the normal open-a-file route: a bare navigation request is
    // ignored unless that file is already on screen, which is exactly the case
    // when following someone into a file you are not in.
    try {
      await openProjectFile(path, location?.line ?? 1);
    } catch {
      setNotice(`Could not open ${path}`);
    }
  }, [openProjectFile]);

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

  const closeEditorTab = useCallback(async (path: string) => {
    const remaining = openTabs.filter((tab) => tab !== path);
    // Source-backed modes must always retain a document. PDF is the one mode
    // where an empty tab strip is meaningful because the compiled preview can
    // stand on its own.
    if (!remaining.length && canvasMode !== "pdf") return;
    if (
      isPaperTabKey(path)
      && activePaper
      && paperTabKey(activePaper.arxivId) === path
      && activePaperDirty
      && !(await save())
    ) {
      return;
    }
    setOpenTabs(remaining);
    tabRecency.current = tabRecency.current.filter((key) => key !== path);
    viewStateRef.current.delete(path);
    closedTabsRef.current = [path, ...closedTabsRef.current.filter((item) => item !== path)].slice(0, 20);
    // The most recent still-open text file to fall back to (papers can't load
    // into the editor).
    const fileFallback = [...remaining].reverse().find((key) => !isPaperTabKey(key) && !projectAssetPaths.has(key));
    if (isPaperTabKey(path)) {
      // Only the paper currently on screen needs the canvas returned to the editor.
      if (activePaper && paperTabKey(activePaper.arxivId) === path) {
        setActivePaper(null);
        setPaperMarkdown("");
        setSavedPaperMarkdown("");
        setPaperBlog(null);
        setSavedPaperBlog(null);
        if (fileFallback) await openProjectFile(fileFallback);
        else setCanvasMode((mode) => mode === "pdf" ? "split" : mode);
      }
      return;
    }
    if (projectAssetPaths.has(path)) {
      if (activeAsset?.path === path) {
        setActiveAsset(null);
        if (fileFallback) await openProjectFile(fileFallback);
        else setCanvasMode((mode) => (mode === "asset" ? "split" : mode));
      }
      return;
    }
    if (path === secondaryFile) {
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
    activePaperDirty,
    canvasMode,
    openProjectFile,
    openTabs,
    projectAssetPaths,
    save,
    secondaryFile,
  ]);

  const reopenClosedTab = useCallback(async () => {
    const path = closedTabsRef.current.shift();
    if (!path) return;
    await openProjectFile(path);
  }, [openProjectFile]);

  const revealPdfSource = useCallback(async (page: number, x: number, y: number) => {
    try {
      const target = await invoke<SyncTexTarget>("synctex_edit", { page, x, y });
      await openProjectFile(target.path, target.line);
      setCanvasMode((mode) => (
        mode === "pdf" || mode === "asset"
          ? "split"
          : mode === "columns"
            ? "columns"
            : mode === "dual"
              ? "split"
              : mode
      ));
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [openProjectFile]);

  const runBuild = useCallback(async (
    force = false,
    options?: { immediatePreview?: boolean },
  ) => {
    if (buildingRef.current) {
      buildQueued.current = true;
      return;
    }
    buildingRef.current = true;
    setBuilding(true);
    const immediatePreview = options?.immediatePreview ?? force;
    let buildScope: {
      operationGeneration: number;
      previewGeneration: number;
      projectRoot: string;
    } | null = null;
    const scopeIsCurrent = () => Boolean(buildScope
      && projectOperationGenerationRef.current === buildScope.operationGeneration
      && previewGenerationRef.current === buildScope.previewGeneration
      && projectRef.current?.root === buildScope.projectRoot);
    try {
      do {
        buildQueued.current = false;
        const previewGeneration = previewGenerationRef.current;
        const operationGeneration = projectOperationGenerationRef.current;
        const projectRoot = projectRef.current?.root;
        if (!projectRoot) continue;
        buildScope = { operationGeneration, previewGeneration, projectRoot };
        const compiledSource = sourceRef.current;
        const compiledSecondarySource = secondarySourceRef.current;
        let result: BuildResult;
        try {
          result = await invoke<BuildResult>("build_project", { force, projectRoot });
        } catch (reason) {
          if (!scopeIsCurrent()) continue;
          throw reason;
        }
        if (!scopeIsCurrent()) continue;
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
        setDiagnosticBuildSource(compiledSource);
        setDiagnosticBuildSecondarySource(compiledSecondarySource);
        setDiagnosticsDismissed(false);
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
          const firstError = result.diagnostics.find((item) => item.level === "error")
            ?? result.diagnostics[0]
            ?? null;
          if (firstError) void openCompileDiagnosticRef.current(firstError);
          setError(firstError?.message
            ? `LaTeX compilation failed: ${firstError.message}`
            : "LaTeX compilation failed.");
          const failureText = [
            result.log,
            ...result.diagnostics.map((item) => item.message),
          ].join("\n");
          if (isMissingTexBuildError(failureText)) setTexSetupOpen(true);
        } else {
          setError(null);
        }
      } while (buildQueued.current);
    } catch (reason) {
      if (scopeIsCurrent()) {
        const message = toMessage(reason);
        setError(message);
        if (isMissingTexBuildError(message)) setTexSetupOpen(true);
      }
    } finally {
      buildingRef.current = false;
      setBuilding(false);
    }
  }, []);

  const compile = useCallback(async (force = false) => {
    if (!project) return;
    await runBuild(force, { immediatePreview: true });
  }, [project, runBuild]);
  compileRef.current = compile;

  // ---- Overleaf bridge -----------------------------------------------------

  /**
   * A paused link reads as no link at all here, which is what everything
   * downstream means by it: the toolbar cloud, auto-sync, the live channel,
   * chat, collaborators and the comment threads should all be off. Settings
   * reads the link itself, so it still sees the project and can resume it.
   */
  const activeLink = (link: OverleafLink | null | undefined) => (
    link && !link.paused ? link : null
  );

  // Know whether the open project is linked to an Overleaf project (cloned via
  // "Open from Overleaf"). Drives the toolbar sync button and auto-sync.
  useEffect(() => {
    let cancelled = false;
    setOverleafLink(null);
    if (!project?.root) return;
    void invoke<OverleafLink | null>("overleaf_link")
      .then((link) => {
        if (!cancelled) setOverleafLink(activeLink(link));
      })
      .catch(() => {
        // A project without the state file is simply not linked.
      });
    return () => {
      cancelled = true;
    };
  }, [project?.root]);

  /**
   * Re-read the link after Settings changes it. Unlinking has to be felt
   * everywhere — the toolbar cloud, the live channel, chat, collaborators and
   * the comment threads all key off this, and they used to keep running
   * against a project that had just been unlinked.
   */
  const refreshOverleafLink = useCallback(() => {
    void invoke<OverleafLink | null>("overleaf_link")
      .then((link) => setOverleafLink(link && !link.paused ? link : null))
      .catch(() => setOverleafLink(null));
  }, []);

  /**
   * Deal with files that are gone here but still on Overleaf.
   *
   * Deleting from a shared project is not something to infer from a missing
   * file, so this obeys the setting: leave them, remove them, or ask. Removing
   * needs the entity's Overleaf id, which only the realtime channel knows —
   * without it there is nothing to name in the request, so the ask is skipped
   * rather than offered and then failed.
   */
  const settleRemoteDeletes = useCallback(async (
    paths: string[],
    projectRoot: string,
    generation: number,
  ) => {
    const stillCurrent = () => (
      projectOperationGenerationRef.current === generation
      && projectRef.current?.root === projectRoot
    );
    if (!stillCurrent()) return;
    const policy = overleafRemoteDeleteRef.current;
    if (policy === "never") return;
    const known = paths
      .map((path) => ({ path, entity: overleafEntitiesRef.current.get(path) }))
      .filter((entry): entry is { path: string; entity: { id: string; kind: string } } => (
        entry.entity !== undefined
      ));
    if (!known.length) return;
    if (policy === "ask") {
      const names = known.map((entry) => entry.path).join(", ");
      const removeThem = await confirmAction(
        `${names} ${known.length === 1 ? "is" : "are"} gone here but still on Overleaf.\n\n`
        + "Remove them from the Overleaf project too? Overleaf's history keeps them either way.",
      );
      if (!removeThem || !stillCurrent()) return;
    }
    for (const entry of known) {
      if (!stillCurrent()) return;
      try {
        await invoke("overleaf_delete_entity", {
          projectRoot,
          kind: entry.entity.kind,
          entityId: entry.entity.id,
        });
      } catch (reason) {
        if (stillCurrent()) {
          setError(`Could not remove ${entry.path} from Overleaf: ${toMessage(reason)}`);
        }
        return;
      }
    }
    if (stillCurrent()) {
      setNotice(`Removed ${known.length} file${known.length === 1 ? "" : "s"} from Overleaf too`);
    }
  }, []);

  const runOverleafSync = useCallback(async (options?: { auto?: boolean }) => {
    if (!project || overleafSyncingRef.current) return;
    const syncRoot = project.root;
    const syncGeneration = projectOperationGenerationRef.current;
    const stillCurrent = () => (
      projectOperationGenerationRef.current === syncGeneration
      && projectRef.current?.root === syncRoot
    );
    overleafSyncingRef.current = true;
    setOverleafSyncing(true);
    // Saving below clears the dirty flag, which cancels the pending autosave
    // compile — that is how a sync landing mid-edit left the editor showing a
    // change the PDF never caught up with. Remember it so we can rebuild.
    const hadUnsavedEdits = sourceRef.current !== savedSourceRef.current;
    let compiled = false;
    try {
      if (!(await save())) return;
      if (!stillCurrent()) return;
      const result = await invoke<OverleafSyncResult>("overleaf_sync", {
        projectRoot: syncRoot,
        live: overleafLivePathsRef.current,
      });
      if (!stillCurrent()) return;
      // A file gone from here is still on Overleaf, because syncing has never
      // removed anything from a shared project on its own. What should happen
      // instead is a decision only the user can make, so it is a setting.
      if (result.skippedRemoteDeletes.length) {
        await settleRemoteDeletes(
          result.skippedRemoteDeletes,
          syncRoot,
          syncGeneration,
        );
        if (!stillCurrent()) return;
      }
      // A file too big for Overleaf to accept stays here and is named, because
      // to the writer it otherwise looks synced like everything else and the
      // absence is only discovered from the other side.
      if (result.skippedLarge?.length) {
        setNotice(
          `Too large for Overleaf, so left on this machine: ${result.skippedLarge.join(", ")}.`,
        );
      }
      // Merged and conflicted files were rewritten on disk just like pulled
      // ones, so the editor has to reload them too or it would keep showing
      // stale text and save over the incoming edits.
      const changedOnDisk = new Set([
        ...result.pulled,
        ...result.merged,
        ...result.conflicts.map((item) => item.path),
      ]);
      if (result.conflicts.length) {
        // A file with markers in it has spots to work through; a figure or a
        // PDF does not, and saying "resolve each spot" about one — then
        // opening a marker resolver that finds nothing — is worse than saying
        // plainly that both versions are sitting on disk.
        const marked = result.conflicts.filter((item) => item.markers !== false);
        const whole = result.conflicts.filter((item) => item.markers === false);
        const parts: string[] = [];
        if (marked.length) {
          parts.push(
            `Overleaf sync could not combine: ${marked.map((item) => item.path).join(", ")}. `
            + "Both versions are kept — resolve each spot to finish. "
            + "Your untouched version is also saved beside it in the “(local conflict …)” files, "
            + "and nothing uploads until the conflicts are settled.",
          );
        }
        if (whole.length) {
          parts.push(
            `Changed in both places and impossible to combine: ${whole.map((item) => item.path).join(", ")}. `
            + "Overleaf's version is now the one in the project, and yours is kept beside it "
            + "in the “(local conflict …)” files — keep whichever you want and delete the other.",
          );
        }
        setError(parts.join(" "));
        // Only worth opening for a file that actually has markers in it.
        const first = marked[0]?.path ?? null;
        if (first) setConflictPath(first);
      }
      if (changedOnDisk.size || result.deletedLocal.length) {
        await refreshProject({ expectedRoot: syncRoot, generation: syncGeneration });
        if (!stillCurrent()) return;
        if (activeFile && changedOnDisk.has(activeFile)) {
          await loadFile(activeFile, {
            expectedProjectRoot: syncRoot,
            projectGeneration: syncGeneration,
          });
          if (!stillCurrent()) return;
        }
        // Files arriving from Overleaf haven't touched the live share, so a
        // Lattice collaborator would never see them without this push. Only
        // paths already in the v2 catalog can update — brand-new files stay
        // local until the share is restarted (no v2 create-entry API yet).
        if (collabSession && changedOnDisk.size) {
          for (const path of changedOnDisk) {
            if (!stillCurrent()) return;
            try {
              const content = await invoke<string>("read_project_file", { path });
              if (!stillCurrent()) return;
              await publishTextToCollabV2(path, content);
            } catch {
              // Binary or unreadable files must not stop the rest.
            }
          }
        }
        if (!stillCurrent()) return;
        await compile();
        if (!stillCurrent()) return;
        compiled = true;
      }
      // Nothing arrived, but we flushed the user's own unsaved edits — the
      // autosave compile they were waiting on is gone, so run it here.
      if (!compiled && hadUnsavedEdits) {
        if (!stillCurrent()) return;
        await compile();
        if (!stillCurrent()) return;
        compiled = true;
      }
      if (result.pulled.length || result.pushed.length || result.merged.length) {
        const parts = [`pulled ${result.pulled.length}`, `pushed ${result.pushed.length}`];
        if (result.merged.length) parts.push(`merged ${result.merged.length}`);
        setNotice(`Overleaf: ${parts.join(", ")}.`);
      } else if (!options?.auto) {
        setNotice("Overleaf: already up to date.");
      }
      // Each sync point becomes a version, so the timeline shows what arrived.
      if (!stillCurrent()) return;
      void invoke<string | null>("git_auto_commit", {
        message: "Overleaf sync",
        author: collabName.trim() || null,
        projectRoot: syncRoot,
      }).catch(() => {});
      void invoke<OverleafLink | null>("overleaf_link")
        .then((link) => {
          if (stillCurrent()) setOverleafLink(activeLink(link));
        })
        .catch(() => {});
    } catch (reason) {
      if (stillCurrent()) setError(toMessage(reason));
    } finally {
      overleafSyncingRef.current = false;
      setOverleafSyncing(false);
    }
  }, [
    activeFile,
    collabName,
    collabSession,
    compile,
    loadFile,
    project,
    refreshProject,
    save,
    settleRemoteDeletes,
  ]);

  // First open after launch pulls collaborators' Overleaf edits automatically.
  useEffect(() => {
    if (!overleafLink || !project?.root) return;
    if (overleafAutoSyncedRoot.current === project.root) return;
    overleafAutoSyncedRoot.current = project.root;
    lastAutoSyncRef.current = Date.now();
    void runOverleafSync({ auto: true });
  }, [overleafLink, project?.root, runOverleafSync]);

  // Live mode keeps a linked project close to current without anyone pressing
  // anything. Asking Overleaf "has your history moved?" is a small JSON call,
  // so it can run every few seconds; the expensive full sync only follows when
  // the answer is yes. That is what makes seconds-level latency affordable —
  // polling the project itself would mean re-downloading it every time.
  overleafSyncRef.current = runOverleafSync;
  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "live" || !project?.root) return;
    const projectRoot = project.root;
    let stopped = false;
    let timer: number | null = null;
    // Backs off when Overleaf pushes back, and stays slow when this instance
    // cannot tell us a version — polling only earns its keep when a cheap
    // check can rule a download out.
    const baseWait = () =>
      overleafChannelLiveRef.current ? OVERLEAF_CHANNEL_POLL_MS : OVERLEAF_LIVE_POLL_MS;
    let wait = baseWait();
    const tick = async () => {
      if (stopped) return;
      try {
        if (!overleafSyncingRef.current) {
          const probe = await invoke<OverleafProbe>("overleaf_probe", { projectRoot });
          wait = probe.versionKnown ? baseWait() : OVERLEAF_BLIND_POLL_MS;
          if (!stopped && !probe.versionKnown) {
            // No change signal: fall back to syncing on a slow clock rather
            // than downloading the project over and over.
            if (Date.now() - lastAutoSyncRef.current >= OVERLEAF_BLIND_POLL_MS) {
              lastAutoSyncRef.current = Date.now();
              await overleafSyncRef.current({ auto: true });
            }
          } else if (
            !stopped
            && probe.changed
            && Date.now() - lastAutoSyncRef.current >= OVERLEAF_MIN_SYNC_GAP_MS
          ) {
            lastAutoSyncRef.current = Date.now();
            await overleafSyncRef.current({ auto: true });
          }
        }
      } catch (reason) {
        // Rate limiting means we are asking too often; ease off sharply rather
        // than hammering a server that has already said no.
        const message = String(reason);
        wait = /429|Too Many Requests/i.test(message)
          ? Math.min(wait * 4, 5 * 60_000)
          : Math.min(Math.max(wait * 2, baseWait()), 60_000);
      }
      if (!stopped) timer = window.setTimeout(() => void tick(), wait);
    };
    void tick();
    // Coming back from the browser is the moment stale content is most
    // obvious, so check immediately rather than waiting for the next tick.
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [overleafLink, overleafSyncMode, project?.root]);

  // Editing through Overleaf's own channel, when the project is linked and
  // live. It stays off during a Lattice share: two live channels writing the
  // same buffer would fight over every keystroke, and the Yjs session already
  // owns the editor then.
  const overleafRealtime = useOverleafRealtime({
    enabled: overleafLink !== null,
    documents: overleafSyncMode === "live" && !collabSession,
    projectRoot: project?.root ?? null,
    activeFile,
    readCaret: () => viewStateRef.current.get(activeFileRef.current ?? "")?.cursor ?? 0,
    onRemoteText: (text, caret) => {
      const path = activeFileRef.current;
      if (!path) return;
      setSource(text);
      // Write it through so a rebuild and any later sync see the same bytes,
      // and only call it saved once it is. Marking it saved first and dropping
      // the failure meant a write that could not happen — a full disk, a
      // read-only volume — left the editor showing their paragraph while the
      // file still held the old one: the build compiled the old text, and the
      // next sync read the old bytes back off disk, called them a local edit,
      // and pushed them over the top of what they had written.
      void invoke("write_project_file", {
        path,
        content: text,
        projectRoot: project?.root ?? null,
      })
        .then(() => setSavedSource(text))
        .catch((reason) => setError(toMessage(reason)));
      setViewRestore({ path, cursor: caret, scrollTop: 0, id: crypto.randomUUID() });
    },
    onNotice: (message) => setNotice(message),
  });
  // The poll loop and the sync both read these mid-flight, so keep them in
  // refs rather than restarting either one every time the channel changes.
  // "Carrying documents", not merely "connected": the channel also stays up in
  // manual mode for chat, and slowing the sync down then would leave nothing
  // watching the files.
  overleafRemoteDeleteRef.current = overleafRemoteDelete;
  overleafEntitiesRef.current = overleafRealtime.entities;
  overleafChannelLiveRef.current = overleafRealtime.status === "live"
    && overleafSyncMode === "live"
    && !collabSession;
  overleafLivePathsRef.current = overleafRealtime.livePaths;

  // Who else is in the Overleaf project, and where. Two things the presence
  // hook cannot get anywhere else ride the same channel: our own connection
  // id, announced once, and which file each document id is — the second is
  // what lets a tooltip name the file and a click jump to it.
  const [overleafSelfId, setOverleafSelfId] = useState<string | null>(null);
  const [overleafDocPaths, setOverleafDocPaths] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (overleafLink === null) {
      setOverleafSelfId(null);
      setOverleafDocPaths(new Map());
      return;
    }
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ type: string; publicId?: string; docs?: { id: string; path: string }[] }>(
      "overleaf-realtime",
      (event) => {
        const payload = event.payload;
        if (payload.type === "connected" && payload.publicId) {
          setOverleafSelfId(payload.publicId);
        } else if ((payload.type === "projectJoined" || payload.type === "treeChanged")
          && payload.docs) {
          // Rebuilt on every tree change, not only at join: a file renamed or
          // added in the browser mid-session would otherwise keep answering
          // with the name it had when we connected, and this map is what names
          // the file behind a collaborator's caret or a comment.
          setOverleafDocPaths(new Map(payload.docs.map((doc) => [doc.id, doc.path])));
        } else if (payload.type === "disconnected") {
          setOverleafSelfId(null);
        }
      },
    ).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [overleafLink]);

  const overleafPresence = useOverleafPresence({
    // A local project still has a root, but it has no Overleaf presence
    // scope. Passing that root here kept the previous linked project's roster
    // alive after switching projects.
    projectRoot: overleafLink ? project?.root ?? null : null,
    docId: overleafRealtime.docId,
    selfId: overleafSelfId,
    readCaret: () => {
      const position = editorPositionRef.current;
      return position?.path === activeFileRef.current
        ? { row: position.line - 1, column: position.column }
        : { row: 0, column: 0 };
    },
  });

  // Publishing a position is the only thing that makes us visible to a browser
  // that is already open, so every real caret move in the live file has to
  // reach it.
  useEffect(() => {
    if (!editorPosition || editorPosition.path !== activeFile) return;
    overleafPresence.publish(editorPosition.line - 1, editorPosition.column);
  }, [editorPosition, activeFile, overleafPresence]);

  const jumpToOverleafPeer = useCallback((peer: PresenceUser) => {
    const path = peer.docId ? overleafDocPaths.get(peer.docId) : null;
    if (!path) {
      setNotice(`${peer.name || "This collaborator"} is not in a file right now.`);
      return;
    }
    void openProjectFile(path, (peer.row ?? 0) + 1);
  }, [overleafDocPaths, openProjectFile]);

  /** Carets to draw, which is only ever the document being edited live. */
  const overleafActiveCursors = useMemo<PresenceCursor[]>(() => {
    const docId = overleafRealtime.docId;
    if (
      !docId
      || activePaper
      || activeAsset
      || overleafDocPaths.get(docId) !== activeFile
    ) return [];
    return overleafPresence.peers
      .filter((peer): peer is PresenceUser & { row: number; column: number } => (
        peer.docId === docId && peer.row !== null && peer.column !== null
      ))
      .map((peer) => ({
        name: peer.name || "Anonymous",
        hue: peer.hue,
        row: peer.row,
        column: peer.column,
      }));
  }, [activeAsset, activeFile, activePaper, overleafDocPaths, overleafPresence.peers, overleafRealtime.docId]);

  // Collaborators who stayed in the browser talk in Overleaf's chat, so it has
  // to be readable here or half the conversation happens where we cannot see
  // it. It listens on the same channel the editor uses.
  const overleafChat = useOverleafChat({
    enabled: overleafLink !== null,
    projectRoot: project?.root ?? null,
  });

  // The same conversation, for a share that never goes near Overleaf. It rides
  // the session's own document, so a guest who joins late simply receives the
  // history as part of the normal sync.
  const collabChat = useCollabChat({
    doc: collabSession?.doc ?? null,
    // The identity editor comments already sign with, rather than inventing a
    // second one for the same person.
    selfId: editorCommentAuthorId,
    displayName: collabName,
  });

  // Where each thread sits in the document being edited right now. Deliberately
  // the realtime channel's copy and not the project-wide one the comments hook
  // reads over REST: these positions become highlights in the editor, and the
  // channel moves them as the text around them is typed, while a REST snapshot
  // would keep pointing at where the words used to be until the next refresh.
  const overleafAnchors = useMemo(
    () => new Map(overleafRealtime.comments.map((range) => [range.threadId, range])),
    [overleafRealtime.comments],
  );
  const overleafComments = useOverleafComments({
    enabled: overleafLink !== null,
    projectRoot: project?.root ?? null,
    docId: overleafRealtime.docId,
    anchored: useMemo(
      () => overleafRealtime.comments.map((range) => range.threadId),
      [overleafRealtime.comments],
    ),
    anchor: overleafRealtime.anchorComment,
  });

  // Overleaf's threads, dressed as editor comments so they highlight in the
  // text and answer in place like any other. Their ids are prefixed, which is
  // how every handler below knows to send the reply to Overleaf rather than
  // writing it into this project's own comments file.
  const overleafEditorComments = useMemo<EditorComment[]>(() => {
    const path = activeFile;
    if (!path || !overleafAnchors.size) return [];
    return overleafComments.threads.flatMap((thread) => {
      const anchor = overleafAnchors.get(thread.id);
      if (!anchor) return [];
      const [first, ...rest] = thread.messages;
      return [{
        id: `${OVERLEAF_COMMENT_PREFIX}${thread.id}`,
        path,
        from: anchor.position,
        to: anchor.position + anchor.quote.length,
        quote: anchor.quote,
        prefix: "",
        suffix: "",
        body: first?.content ?? "",
        authorId: first?.authorEmail ?? "overleaf",
        authorName: first ? `${first.authorName} · Overleaf` : "Overleaf",
        resolved: thread.resolved,
        replies: rest.map((message) => ({
          id: message.id,
          authorId: message.authorEmail ?? "overleaf",
          authorName: message.authorName,
          body: message.content,
          createdAt: new Date(message.timestamp).toISOString(),
        })),
        createdAt: new Date(first?.timestamp ?? 0).toISOString(),
        updatedAt: new Date(thread.messages[thread.messages.length - 1]?.timestamp ?? 0).toISOString(),
      }];
    });
  }, [activeFile, overleafAnchors, overleafComments.threads]);

  // Suggestions: reading them is the realtime hook's job, acting on them is
  // this one's — accepting goes through an endpoint and reports no operation,
  // so the document has to be re-read afterwards.
  const overleafTrackChanges = useOverleafTrackChanges({
    enabled: overleafLink !== null,
    projectRoot: project?.root ?? null,
    docId: overleafRealtime.docId,
    reserveOperation: overleafRealtime.reserveOperation,
    noteReservedOperationUnknown: overleafRealtime.noteReservedOperationUnknown,
    settledVersion: overleafRealtime.settledVersion,
    changes: overleafRealtime.changes,
    canAct: overleafRealtime.canWrite,
    reload: overleafRealtime.reload,
  });
  // The comment handlers are declared before this hook runs, so they reach its
  // actions through a ref rather than forcing the whole tree to be reordered.
  overleafCommentsRef.current = overleafComments;

  /** Both kinds of comment, as the editor and the panel want them. */
  const allEditorComments = useMemo(
    () => [...editorComments, ...overleafEditorComments],
    [editorComments, overleafEditorComments],
  );

  // Keep the badge quiet while someone is reading the conversation.
  useEffect(() => {
    if (overleafCollabOpen && overleafCollabTab === "chat") overleafChat.markRead();
  }, [overleafCollabOpen, overleafCollabTab, overleafChat.messages, overleafChat.markRead]);

  // Everything typed goes to the live channel; it ignores text it already has,
  // so this is safe to call on every change including our own remote applies.
  useEffect(() => {
    if (!overleafRealtime.liveFile) return;
    overleafRealtime.pushLocal(source);
  }, [overleafRealtime, source]);

  // A live channel that could not start is invisible otherwise: the dot simply
  // never appears and everything quietly keeps syncing. Say what happened once.
  const overleafRealtimeNotified = useRef<string | null>(null);
  useEffect(() => {
    if (overleafRealtime.status !== "error" || !overleafRealtime.detail) return;
    if (overleafRealtimeNotified.current === overleafRealtime.detail) return;
    overleafRealtimeNotified.current = overleafRealtime.detail;
    setNotice(
      `Live editing with Overleaf could not start (${overleafRealtime.detail}). `
      + "Your project still syncs every few seconds.",
    );
  }, [overleafRealtime.detail, overleafRealtime.status]);

  // Live mode also pushes. This keys off *saves* rather than unsaved edits:
  // autosave clears the dirty flag about a second after typing stops, well
  // before any sensible push delay, so watching for dirty text meant the push
  // was almost always cancelled before it ran.
  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "live" || saveGeneration === 0) return;
    let cancelled = false;
    let timer: number | null = null;
    const attempt = () => {
      if (cancelled) return;
      // If a sync ran moments ago, wait out the remainder instead of dropping
      // the push — dropping meant the edit sat here until something else
      // happened to sync, which is what made pushes feel like they never came.
      // The gap is a floor, not a delay: autosave fires about a second after
      // typing stops, and syncing on each of those meant asking Overleaf for
      // the whole project every couple of seconds, which is over its limit.
      const gap = overleafChannelLiveRef.current
        ? OVERLEAF_CHANNEL_SYNC_GAP_MS
        : OVERLEAF_MIN_SYNC_GAP_MS;
      const wait = gap - (Date.now() - lastAutoSyncRef.current);
      if (wait > 0) {
        timer = window.setTimeout(attempt, wait);
        return;
      }
      lastAutoSyncRef.current = Date.now();
      void overleafSyncRef.current({ auto: true });
    };
    timer = window.setTimeout(attempt, OVERLEAF_PUSH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [overleafLink, overleafSyncMode, saveGeneration]);

  // Manual mode never syncs on its own; it just watches for incoming work so
  // the toolbar can offer it, the way a repository shows commits to pull.
  useEffect(() => {
    if (!overleafLink || overleafSyncMode !== "manual" || !project?.root) {
      setOverleafRemoteChanges(false);
      return;
    }
    const projectRoot = project.root;
    let stopped = false;
    const check = async () => {
      try {
        const probe = await invoke<OverleafProbe>("overleaf_probe", { projectRoot });
        if (!stopped) setOverleafRemoteChanges(probe.changed);
      } catch {
        // Leave the badge as-is when the check cannot run.
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 30_000);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [overleafLink, overleafSyncMode, project?.root]);

  // Auto-save a version after successful builds of Overleaf-linked projects,
  // at most every 2 minutes. Unlinked projects only version on explicit "Save
  // version" — never surprise-commit into a repo the user manages by hand.
  useEffect(() => {
    if (!build?.success || !overleafLink) return;
    const now = Date.now();
    if (now - lastAutoVersionRef.current < 120_000) return;
    lastAutoVersionRef.current = now;
    void invoke<string | null>("git_auto_commit", {
      message: "Auto-saved version",
      author: collabName.trim() || null,
    }).catch(() => {});
  }, [build, collabName, overleafLink]);

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
    if (!project || cleaning || building) return;
    if (!await confirmAction("Delete auxiliary files and rebuild the PDF?")) return;
    setCleaning(true);
    try {
      await invoke("clean_project");
      setCleaning(false);
      await runBuild(true);
    } catch (reason) {
      setError(toMessage(reason));
      setCleaning(false);
    }
  }, [building, cleaning, project, runBuild]);

  const revealSourceInPdf = useCallback(async () => {
    if (!editorPosition || locatingPdf) return;
    const position = editorPosition;
    setWarning(null);
    setLocatingPdf(true);
    try {
      if (!(await save())) return;
      if (source !== savedSource || !pdfUrl) await runBuild();
      const target = await invoke<PdfSyncResponse | null>("synctex_view", {
        path: position.path,
        line: position.line,
        column: position.column,
      });
      if (!target) {
        setError(null);
        setNotice(null);
        setWarning("This source line has no matching position in the PDF.");
        return;
      }
      setWarning(null);
      setPdfSyncTarget({ ...target, id: crypto.randomUUID() });
      setCanvasMode((mode) => {
        if (mode === "dual") return "columns";
        if (mode === "source") return "split";
        return mode;
      });
      setError(null);
    } catch (reason) {
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
      setLocatingPdf(false);
    }
  }, [editorPosition, locatingPdf, pdfUrl, runBuild, save, savedSource, source]);

  const navigateOutline = useCallback(async (path: string, line: number) => {
    setOutlineOpen(false);
    await openProjectFile(path, line);
    try {
      const target = await invoke<PdfSyncResponse | null>("synctex_view", {
        path,
        line,
        column: 0,
      });
      if (target) setPdfSyncTarget({ ...target, id: crypto.randomUUID() });
      setCanvasMode((mode) => mode === "source" ? "split" : mode === "dual" ? "columns" : mode);
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
      setDiskTodos([]);
      setTodosOpen(false);
      setActivePaper(null);
      setActiveAsset(null);
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
      if (primaryFile) await loadFile(primaryFile);
      const secondaryFile = restored?.secondaryFile
        && restored.secondaryFile !== primaryFile
        && sourcePaths.has(restored.secondaryFile)
        ? restored.secondaryFile
        : null;
      if (secondaryFile) {
        try {
          const content = await invoke<string>("read_project_file", { path: secondaryFile });
          setSecondaryFile(secondaryFile);
          setSecondarySource(content);
          setSecondarySavedSource(content);
        } catch {
          setSecondaryFile(null);
          setSecondarySource("");
          setSecondarySavedSource("");
        }
      }
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
      viewStateRef.current.clear();
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
  const didAutoReopenRef = useRef(false);
  useEffect(() => {
    if (didAutoReopenRef.current) return;
    didAutoReopenRef.current = true;
    const mostRecent = loadRecentProjects()[0]?.path;
    if (!mostRecent) return;
    void (async () => {
      try {
        if (!startProjectTransition()) return;
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
  }, [cancelProjectTransition, enterProject, runBuild, startProjectTransition]);

  const openClonedOverleafProject = useCallback(async (root: string) => {
    setBusyLabel("Opening the Overleaf project…");
    try {
      if (!startProjectTransition()) return;
      const snapshot = await invoke<ProjectSnapshot>("open_project", { path: root });
      await enterProject(snapshot);
      setError(null);
    } catch (reason) {
      cancelProjectTransition();
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, enterProject, startProjectTransition]);

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
        let controllerStarted = false;
        try {
          const priorRoot = project?.root ?? null;
          preCollabProjectRootRef.current = priorRoot;
          rememberPreCollabProjectRoot(priorRoot);
          saveCollabDisplayName(collabName.trim());
          if (project && (source !== savedSource || (secondaryFile && secondarySource !== secondarySavedSource)) && !(await save())) return;
          if (!startProjectTransition()) return;
          const shortRoom = v2Invite.projectInstanceId.slice(-12);
          const snapshot = await invoke<ProjectSnapshot>("create_collab_join_workspace", { room: shortRoom });
          await enterProject(snapshot, { skipCollabLifecycle: true, deferInitialBuild: true });
          const workspaceGeneration = collabWorkspaceGenerationRef.current + 1;
          collabWorkspaceGenerationRef.current = workspaceGeneration;
          const lease: CollabWorkspaceLease = { projectRoot: snapshot.root, generation: workspaceGeneration, isCurrent: () => collabWorkspaceGenerationRef.current === workspaceGeneration && projectRootRef.current === snapshot.root };
          collabWorkspaceLeaseRef.current = lease;
          const store = collabCredentialStore();
          const record = await acceptCollabInvitationV2(v2Raw, store, { projectRoot: snapshot.root, title: shortRoom });
          if (!record?.credentialRef) throw new Error("Could not store the v2 collaboration credential");
          const controller = await CollabProjectControllerV2.start({ deployment: v2Invite.deployment, projectInstanceId: v2Invite.projectInstanceId, credentialRef: record.credentialRef, credentialStore: store, permission: v2Invite.permission, onStatus: mapV2Status, onCatalog: handleV2Catalog, displayName: collabName, onPeers: setCollabPeerList });
          controllerStarted = true;
          collabV2ControllerRef.current = controller;
          collabSessionRef.current = controller;
          const materialized = await controller.materializeProject(lease, v2WorkspaceCallbacks(lease));
          assertCollabWorkspaceLease(lease);
          await refreshProject();
          collabRoleRef.current = "guest";
          setCollabRole("guest");
          setActiveCollabVersion(2);
          setCollabRoom(controller.room);
          setCollabSession(controller);
          setCollabFileCount(controller.fileCount());
          setCollabReady(true);
          await loadFile(materialized.openPath);
          setCollabStatus("synced");
          setNotice(`Joined v2 shared workspace · ${controller.fileCount()} files`);
        } catch (reason) {
          setCollabReady(false);
          if (!controllerStarted) cancelProjectTransition();
          setCollabStatus("error");
          setError(toMessage(reason));
        } finally {
          setBusyLabel(null);
        }
      })();
      return;
    }
    setError("That invite is not a v2 collaboration invite — ask the host for a fresh one from Copy invite.");
  }, [cancelProjectTransition, collabHost, collabInvite, collabName, collabRoom, enterProject, handleV2Catalog, loadFile, mapV2Status, project, refreshProject, save, savedSource, secondaryFile, secondarySavedSource, secondarySource, source, startProjectTransition, v2WorkspaceCallbacks]);

  const rejoinCollabProjectV2 = useCallback((record: CollabProjectRecordV2) => {
    void (async () => {
      setBusyLabel("Rejoining v2 collaboration…");
      try {
        const store = collabCredentialStore();
        const credentialRef = await requireRememberedV2Credential(record, store);
        if (project && (source !== savedSource || (secondaryFile && secondarySource !== secondarySavedSource)) && !(await save())) return;
        let root = record.projectRoot;
        if (root && root !== project?.root) {
          if (!startProjectTransition()) return;
          await enterProject(await invoke<ProjectSnapshot>("open_project", { path: root }), { skipCollabLifecycle: true, deferInitialBuild: true });
        } else if (!root) {
          if (!startProjectTransition()) return;
          const snapshot = await invoke<ProjectSnapshot>("create_collab_join_workspace", { room: record.projectInstanceId.slice(-12) });
          root = snapshot.root;
          await enterProject(snapshot, { skipCollabLifecycle: true, deferInitialBuild: true });
        }
        if (!root) throw new Error("The remembered collaboration has no workspace");
        const generation = collabWorkspaceGenerationRef.current + 1; collabWorkspaceGenerationRef.current = generation;
        const lease: CollabWorkspaceLease = { projectRoot: root, generation, isCurrent: () => collabWorkspaceGenerationRef.current === generation && projectRootRef.current === root };
        collabWorkspaceLeaseRef.current = lease;
        const controller = await CollabProjectControllerV2.start({ deployment: record.host, projectInstanceId: record.projectInstanceId, credentialRef, credentialStore: store, permission: record.permission, onStatus: mapV2Status, onCatalog: handleV2Catalog, displayName: collabName, onPeers: setCollabPeerList });
        const materialized = await controller.materializeProject(lease, v2WorkspaceCallbacks(lease));
        await refreshProject(); collabV2ControllerRef.current = controller; collabSessionRef.current = controller;
        collabRoleRef.current = record.permission === "host" ? "host" : "guest"; setCollabRole(collabRoleRef.current); setActiveCollabVersion(2); setCollabRoom(controller.room); setCollabSession(controller); setCollabFileCount(controller.fileCount()); setCollabReady(true); await loadFile(materialized.openPath);
        rememberCollabProjectV2({ ...record, projectRoot: root, lastUsed: Date.now() }); refreshRecentRooms(); setCollabStatus("synced");
      } catch (reason) { cancelProjectTransition(); setError(toMessage(reason)); setCollabStatus("error"); }
      finally { setBusyLabel(null); }
    })();
  }, [cancelProjectTransition, collabName, enterProject, handleV2Catalog, loadFile, mapV2Status, project, refreshProject, refreshRecentRooms, save, savedSource, secondaryFile, secondarySavedSource, secondarySource, source, startProjectTransition, v2WorkspaceCallbacks]);

  const forgetRecentProjectV2 = useCallback((record: CollabProjectRecordV2) => {
    forgetCollabProjectV2(record.host, record.projectInstanceId);
    refreshRecentRooms();
    if (record.credentialRef && window.confirm("Also remove this collaboration credential from Keychain?")) void collabCredentialStore().delete(record.credentialRef, record.projectInstanceId, record.host).catch(reason => setError(toMessage(reason)));
  }, [refreshRecentRooms]);

  const chooseExisting = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "Open a LaTeX project" });
    if (!selected) return;
    setBusyLabel("Opening project…");
    try {
      if (!(await save())) return;
      if (!startProjectTransition()) return;
      await enterProject(await invoke<ProjectSnapshot>("open_project", { path: selected }));
    } catch (reason) {
      cancelProjectTransition();
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, enterProject, save, startProjectTransition]);

  const createProject = useCallback(async () => {
    if (!projectName.trim()) {
      setCreateError("Enter a project name.");
      return;
    }
    const parent = await open({ directory: true, multiple: false, title: "Choose where to create the project" });
    if (!parent) return;
    setBusyLabel("Creating project…");
    try {
      if (!(await save())) return;
      if (!startProjectTransition()) return;
      const snapshot = await invoke<ProjectSnapshot>("create_project", {
        parent,
        name: projectName,
        venue: projectVenue,
      });
      setCreateError(null);
      setCreateOpen(false);
      await enterProject(snapshot);
    } catch (reason) {
      cancelProjectTransition();
      setCreateError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [
    cancelProjectTransition,
    enterProject,
    projectName,
    projectVenue,
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
      if (!startProjectTransition()) {
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
  }, [cancelProjectTransition, enterProject, save, setError, setSidebarOpen, startProjectTransition]);

  useEffect(() => {
    if (!project || tutorialActive || autoTutorialAttemptedRef.current || hasSeenTutorial()) return;
    void openTutorialProject();
  }, [openTutorialProject, project, tutorialActive]);

  const importOverleafZip = useCallback(async () => {
    const zipPath = await open({
      multiple: false,
      title: "Import Overleaf ZIP",
      filters: [{ name: "ZIP archive", extensions: ["zip"] }],
    });
    if (!zipPath) return;
    const parent = await open({
      directory: true,
      multiple: false,
      title: "Choose where to extract the project",
    });
    if (!parent) return;
    setBusyLabel("Importing ZIP…");
    try {
      if (!(await save())) return;
      if (!startProjectTransition()) return;
      await enterProject(await invoke<ProjectSnapshot>("import_project_zip", {
        zipPath,
        parent,
      }));
    } catch (reason) {
      cancelProjectTransition();
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [cancelProjectTransition, enterProject, save, startProjectTransition]);

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
    if (!(await save())) return;
    setBusyLabel("Switching project…");
    try {
      if (!startProjectTransition()) return;
      await enterProject(await invoke<ProjectSnapshot>("open_project", { path }));
    } catch (reason) {
      cancelProjectTransition();
      setRecentProjects((items) => {
        const next = items.filter((item) => item.path !== path);
        persistRecentProjects(next);
        return next;
      });
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [
    cancelProjectTransition,
    enterProject,
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
      .then((snapshot) => {
        if (active && snapshot) return enterProjectRef.current?.(snapshot);
      })
      .catch((reason) => active && setError(toMessage(reason)));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void invoke<DoctorReport>("run_doctor")
      .then((report) => {
        if (!active) return;
        setDoctorReport(report);
        if (isTexToolchainMissing(report) && !wasTexSetupDismissed()) {
          setTexSetupOpen(true);
        }
      })
      .catch(() => {
        // Tests and incomplete environments may not expose doctor.
      });
    return () => {
      active = false;
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
    const documentDirty = Boolean(!activePaper && activeFile && source !== savedSource);
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
      if (activePaperDirty) void save();
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
      const result = await invoke<{ arxivId: string; title: string; citationKey?: string; alreadyImported: boolean }>("import_reference", {
        input: trimmed,
      });
      const snapshot = await refreshProject();
      await refreshHistory();
      if (collabSession && !result.alreadyImported) {
        // A work with no arXiv id has no text on disk to share — only the
        // bibliography changed, and sending `.research/papers//paper.md` would
        // be asking for a file that cannot exist. Only paths already in the
        // v2 catalog propagate; files created by the import stay local until
        // the share is restarted.
        for (const path of [
          ...(result.arxivId ? [
            `.research/papers/${result.arxivId}/paper.md`,
            `.research/papers/${result.arxivId}/blog.md`,
            `.research/papers/${result.arxivId}/metadata.json`,
          ] : []),
          snapshot.manifest.primaryBibliography,
        ].filter(Boolean) as string[]) {
          try {
            const content = await invoke<string>("read_project_file", { path });
            await publishTextToCollabV2(path, content);
          } catch {
            // Optional sidecar / bib may be missing.
          }
        }
      }
      setNotice(result.alreadyImported
        ? `“${result.title}” is already in Papers${result.citationKey ? ` as \\cite{${result.citationKey}}` : ""}.`
        : result.arxivId
          ? `Imported “${result.title}”${result.citationKey ? ` as \\cite{${result.citationKey}}` : ""}.`
          : `Cited “${result.title}”${result.citationKey ? ` as \\cite{${result.citationKey}}` : ""}. No full text to open.`);
    } catch (reason) {
      setError(toMessage(reason));
      throw reason instanceof Error ? reason : new Error(toMessage(reason));
    } finally {
      setImporting(false);
    }
  }, [collabSession, refreshHistory, refreshProject]);

  const importPaper = useCallback(async () => {
    if (!importInput.trim()) return;
    try {
      await importReferenceInput(importInput);
      setImportInput("");
    } catch {
      // Error already surfaced by importReferenceInput.
    }
  }, [importReferenceInput, importInput]);

  const openPaper = useCallback(async (paper: PaperSummary, localBlogOnly = false) => {
    try {
      if (!(await save())) return;
      // Full text and the overview are independent: an arxiv2md conversion can
      // fail while alphaXiv still supplied a useful blog. Keep either readable
      // result instead of letting one rejected promise discard the other.
      const [fullTextResult, blogResult] = await Promise.allSettled([
        invoke<string>("read_paper", { arxivId: paper.arxivId }),
        invoke<string | null>(localBlogOnly ? "read_paper_blog_local" : "read_paper_blog", { arxivId: paper.arxivId }),
      ]);
      const fullText = fullTextResult.status === "fulfilled" ? fullTextResult.value : "";
      const blog = blogResult.status === "fulfilled" ? blogResult.value : null;
      if (!fullText && !blog) {
        throw fullTextResult.status === "rejected" ? fullTextResult.reason : new Error("No readable paper content is available.");
      }
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
      return { hasBlog: blog !== null, hasFullText: Boolean(fullText) };
    } catch (reason) {
      setError(toMessage(reason));
      return null;
    }
  }, [save]);

  const fetchAndOpenPaper = useCallback(async (paper: PaperSummary) => {
    const key = paperKey(paper);
    setPaperFetchStates((current) => ({ ...current, [key]: "loading" }));
    try {
      const result = await invoke<{ arxivId: string; paperPath: string; blogPath?: string | null }>("fetch_paper", {
        arxivId: paper.arxivId,
      });
      await refreshProject();
      const fetched = (await invoke<PaperSummary[]>("list_papers"))
        .find((item) => item.arxivId === result.arxivId) ?? { ...paper, hasFullText: true };
      if (collabSession) {
        // Only paths already in the v2 catalog propagate; the fetched files
        // themselves are new and stay local until the share is restarted.
        for (const path of [
          result.paperPath,
          result.blogPath,
          `.research/papers/${result.arxivId}/metadata.json`,
          ...(fetched.assetPaths ?? []),
        ].filter(Boolean) as string[]) {
          try {
            const content = await invoke<string>("read_project_file", { path });
            await publishTextToCollabV2(path, content);
          } catch {
            // Binary assets and missing sidecars have nothing to publish.
          }
        }
      }
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
      const opened = await openPaper(fetched);
      if (tutorialActive && tutorialStep === TUTORIAL_STEPS.importVit && result.arxivId === "2010.11929") {
        if (opened?.hasBlog) setPaperView("blog");
        setTutorialStep(opened?.hasBlog ? TUTORIAL_STEPS.paperBlog : TUTORIAL_STEPS.paperFullText);
      }
    } catch (reason) {
      setPaperFetchStates((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setError(toMessage(reason));
    }
  }, [collabSession, openPaper, refreshProject, tutorialActive, tutorialStep]);

  useEffect(() => () => {
    Object.values(paperFetchTimers.current).forEach((timer) => window.clearTimeout(timer));
  }, []);

  const openProjectAsset = useCallback(async (path: string) => {
    try {
      if (!(await save())) return;
      const asset = await invoke<AssetPreview>("read_project_asset", { path });
      setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
      setActiveAsset(asset);
      setActivePaper(null);
      setPaperMarkdown("");
      setSavedPaperMarkdown("");
      setPaperBlog(null);
      setSavedPaperBlog(null);
      setCanvasMode("asset");
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [save]);

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
          await openPaper(paper, true);
          if (projectRef.current?.root === pending.root) {
            setPaperView(pending.paperView);
            setCanvasMode(
              pending.canvasMode === "source" || pending.canvasMode === "split"
                ? pending.canvasMode
                : "pdf",
            );
          }
        }
      } else {
        await openProjectAsset(pending.activeTab);
      }
      if (projectRef.current?.root === pending.root) {
        setWorkspacePersistenceReadyRoot(pending.root);
      }
    })();
  }, [openPaper, openProjectAsset, papers, project?.root]);

  useEffect(() => {
    referencePreviewCache.current.clear();
  }, [project?.root, references]);

  const loadReferenceImage = useCallback((path: string) => {
    const cached = referencePreviewCache.current.get(path);
    if (cached) return cached;
    const preview = invoke<AssetPreview>("read_project_asset", { path })
      .then(referenceAssetPreviewDataUrl)
      .catch((reason) => {
        referencePreviewCache.current.delete(path);
        throw reason;
      });
    referencePreviewCache.current.set(path, preview);
    return preview;
  }, []);

  const openProjectAssetFromClick = useCallback((path: string) => {
    if (suppressedFigureClick.current === path) {
      suppressedFigureClick.current = null;
      return;
    }
    void openProjectAsset(path);
  }, [openProjectAsset]);

  const openMarkdownProjectPath = useCallback((path: string) => {
    if (isProjectAssetFilePath(path)) openProjectAssetFromClick(path);
    else openProjectFileFromClick(path);
  }, [openProjectAssetFromClick, openProjectFileFromClick]);

  const beginProjectFigureDrag = useCallback((path: string, label: string, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const elementAt = (clientX: number, clientY: number) =>
      document.elementFromPoint(clientX, clientY) as Element | null;
    const insertionTargetAt = (clientX: number, clientY: number) => {
      const pane = editorPaneAt({ x: clientX, y: clientY });
      const targetPath = pane === "secondary" ? secondaryFileRef.current : activeFileRef.current;
      return pane && /\.(?:tex|md)$/i.test(targetPath ?? "") ? pane : null;
    };
    const treeAt = (clientX: number, clientY: number) => {
      const element = elementAt(clientX, clientY);
      if (!element) return false;
      if (element.closest(".project-file-tree-surface, file-tree-container")) return true;
      const root = element.getRootNode();
      return root instanceof ShadowRoot
        && Boolean((root.host as Element).closest(".project-file-tree-surface"));
    };
    const move = (pointerEvent: PointerEvent) => {
      if (!dragging && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 5) return;
      dragging = true;
      const insertAtEditor = Boolean(insertionTargetAt(pointerEvent.clientX, pointerEvent.clientY));
      const overCanvas = canvasContentAt({
        x: pointerEvent.clientX,
        y: pointerEvent.clientY,
      });
      setNativeEditorDropActive(insertAtEditor);
      if (!overCanvas && treeAt(pointerEvent.clientX, pointerEvent.clientY)) {
        setFigurePointerDrag(null);
        return;
      }
      setFigurePointerDrag({
        path,
        label,
        clientX: pointerEvent.clientX,
        clientY: pointerEvent.clientY,
        overCanvas,
        insertAtEditor,
      });
    };
    const finish = (pointerEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      setNativeEditorDropActive(false);
      setFigurePointerDrag(null);
      if (!dragging) return;
      suppressedFigureClick.current = path;
      window.setTimeout(() => {
        if (suppressedFigureClick.current === path) suppressedFigureClick.current = null;
      }, 0);
      const insertionPane = insertionTargetAt(pointerEvent.clientX, pointerEvent.clientY);
      if (insertionPane) {
        setFigureDropRequest({
          id: crypto.randomUUID(),
          paths: [path],
          clientX: pointerEvent.clientX,
          clientY: pointerEvent.clientY,
          pane: insertionPane,
        });
      } else if (canvasContentAt({ x: pointerEvent.clientX, y: pointerEvent.clientY })) {
        void openProjectAsset(path);
      }
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      setNativeEditorDropActive(false);
      setFigurePointerDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
  }, [openProjectAsset]);

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
      dragging = true;
      const pane = editorPaneAt({ x: pointerEvent.clientX, y: pointerEvent.clientY });
      setFileDropTargetPane(pane);
    };
    const clear = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      setFileDropTargetPane(null);
    };
    const finish = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      const pane = dragging
        ? editorPaneAt({ x: pointerEvent.clientX, y: pointerEvent.clientY })
        : null;
      const overCanvas = dragging && canvasContentAt({
        x: pointerEvent.clientX,
        y: pointerEvent.clientY,
      });
      clear();
      if (!dragging) return;
      suppressedProjectFileClick.current = path;
      window.setTimeout(() => {
        if (suppressedProjectFileClick.current === path) {
          suppressedProjectFileClick.current = null;
        }
      }, 0);
      if (pane) void openProjectFileRef.current(path, undefined, pane);
      else if (overCanvas) void openProjectFileRef.current(path, undefined, "primary");
    };
    const cancel = () => clear();
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
  }, []);

  const ensureSecondaryFile = useCallback(async (preferred?: string | null) => {
    const candidate = preferred
      ?? (secondaryFile && secondaryFile !== activeFile ? secondaryFile : null)
      ?? openTabs.find((path) => path !== activeFile && path.endsWith(".tex"))
      ?? openTabs.find((path) => path !== activeFile && !isPaperTabKey(path))
      ?? null;
    if (!candidate) return null;
    if (candidate === secondaryFile) return candidate;
    const content = await invoke<string>("read_project_file", { path: candidate });
    setSecondaryFile(candidate);
    setSecondarySource(content);
    setSecondarySavedSource(content);
    setOpenTabs((tabs) => (tabs.includes(candidate) ? tabs : [...tabs, candidate]));
    return candidate;
  }, [activeFile, openTabs, secondaryFile]);

  const openDocumentMode = useCallback((mode: DocumentViewMode) => {
    void (async () => {
      if (activePaperDirty && !(await save())) return;
      if (activePaper) {
        setCanvasMode(mode);
        return;
      }
      if (isHtmlFilePath(activeFile)) htmlViewModesRef.current.set(activeFile, mode);
      else documentModeRef.current = mode;
      setActiveAsset(null);
      setActivePaper(null);
      setPaperMarkdown("");
      setSavedPaperMarkdown("");
      setPaperBlog(null);
      setSavedPaperBlog(null);
      // PDF can stand alone without a source tab. Returning to any source-backed
      // view restores the active document to the strip before rendering it.
      if (mode !== "pdf" && activeFile) {
        setOpenTabs((tabs) => (tabs.includes(activeFile) ? tabs : [...tabs, activeFile]));
      }
      if (mode === "dual" || mode === "columns") {
        try {
          await ensureSecondaryFile();
          setCanvasMode(mode);
        } catch (reason) {
          setError(toMessage(reason));
        }
        return;
      }
      setCanvasMode(mode);
    })();
  }, [activeFile, activePaper, activePaperDirty, ensureSecondaryFile, save, setError]);

  const swapEditorPanes = useCallback(async () => {
    if (!secondaryFile || !activeFile || secondaryFile === activeFile) return;
    try {
      if (source !== savedSource || secondarySource !== secondarySavedSource) {
        if (!(await save())) return;
      }
      const nextPrimary = secondaryFile;
      const nextSecondary = activeFile;
      const primaryContent = await invoke<string>("read_project_file", { path: nextPrimary });
      const secondaryContent = await invoke<string>("read_project_file", { path: nextSecondary });
      setActiveFile(nextPrimary);
      setSource(primaryContent);
      setSavedSource(primaryContent);
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
      if (canvasMode !== "dual" && canvasMode !== "columns") {
        setCanvasMode("dual");
      }
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [
    activeFile,
    canvasMode,
    save,
    savedSource,
    secondaryFile,
    secondarySavedSource,
    secondarySource,
    source,
  ]);

  const createProjectEntry = useCallback(async (path: string, kind: "file" | "folder") => {
    try {
      const createdPath = await invoke<string>("create_project_entry", {
        path,
        kind,
        projectRoot: project?.root,
      });
      await refreshProject();
      await refreshHistory();
      if (kind === "file") {
        // Mid-share creates must join the v2 catalog before loadFile, so the
        // editor binds the shared doc instead of a local-only file.
        await shareCreatedFileWithCollabV2(createdPath, createdPath.toLocaleLowerCase().endsWith(".tldr") ? "board" : "text");
        // A local-only file has no Overleaf document id and therefore cannot
        // join realtime editing. Upload it before opening the editor so the
        // first keystroke does not have to wait for a later full-sync timer.
        if (overleafLink && overleafSyncMode === "live") {
          await overleafSyncRef.current({ auto: true });
        }
        await loadFile(createdPath);
      }
      return createdPath;
    } catch (reason) {
      setError(toMessage(reason));
      throw reason;
    }
  }, [
    loadFile,
    overleafLink,
    overleafSyncMode,
    project?.root,
    refreshHistory,
    refreshProject,
    shareCreatedFileWithCollabV2,
  ]);

  const importProjectAssets = useCallback(async (paths: string[], targetDirectory = "figures"): Promise<string[]> => {
    if (!paths.length || assetImporting) return [];
    setAssetImporting(true);
    try {
      const imported = await invoke<string[]>("import_project_assets", {
        paths,
        targetDirectory,
        projectRoot: project?.root,
      });
      await refreshProject();
      setNotice(`Imported ${imported.length} figure${imported.length === 1 ? "" : "s"} into ${targetDirectory}.`);
      setError(null);
      // After setError(null): a share failure must remain visible.
      for (const path of imported) await shareCreatedFileWithCollabV2(path, "binary");
      return imported;
    } catch (reason) {
      setError(toMessage(reason));
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
      await reconcileProjectTree();
      await refreshHistory();
      setError(null);
      // After setError(null): a share failure must remain visible.
      for (const path of imported) await shareCreatedFileWithCollabV2(path, path.toLocaleLowerCase().endsWith(".tldr") ? "board" : "text");
      return imported;
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
        const dropKind = classifyExternalProjectDrop(dragPaths);
        const editorPath = editorPosition?.pane === "secondary"
          ? secondaryFileRef.current
          : activeFileRef.current;
        const insertsIntoEditor = Boolean(
          editorPosition
          && dropKind === "asset"
          && /\.(?:tex|md)$/i.test(editorPath ?? ""),
        );
        setAssetDropTarget(dropKind === "asset" ? targetDirectory : null);
        setNativeEditorDropActive(insertsIntoEditor);
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
          nativeDragPathsRef.current = [];
          if (!event.payload.paths.length) return;
          if (dropKind === "source" && (editorPosition || canvasTarget)) {
            void importProjectSources(event.payload.paths).then(async (paths) => {
              for (const path of paths) {
                await openProjectFileRef.current(
                  path,
                  undefined,
                  editorPosition?.pane ?? "primary",
                );
              }
            });
          } else if (dropKind === "source") {
            setError("Drop source files onto an editor to import and open them.");
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
          } else if (targetDirectory) void importProjectAssets(event.payload.paths, targetDirectory);
          else if (canvasTarget) {
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
  }, [importProjectAssets, importProjectSources, openProjectAsset, project]);

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
    loadFile,
    overleafLink,
    project,
    refreshHistory,
    refreshProject,
    settleRemoteDeletes,
  ]);

  const applyProjectEntryPathChanges = useCallback((changes: readonly ProjectPathChange[]) => {
    if (changes.length === 0) return;
    const remapPath = (path: string) => remapProjectPath(path, changes);

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
    activeFileRef.current = remapPath(activeFileRef.current);
    secondaryFileRef.current = secondaryFileRef.current
      ? remapPath(secondaryFileRef.current)
      : null;
  }, []);

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

    projectTreeMutationCountRef.current += 1;
    try {
      applyProjectEntryPathChanges(plannedChanges);
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
      }
      if (activeFileRef.current) void markDiskMtime(activeFileRef.current);
      setError(null);
      return completedChanges.map((change) => change.nextPath);
    } catch (reason) {
      const completedPaths = new Set(completedChanges.map((change) => change.previousPath));
      const rollbackChanges = plannedChanges
        .filter((change) => !completedPaths.has(change.previousPath))
        .reverse()
        .map((change) => ({
          previousPath: change.nextPath,
          nextPath: change.previousPath,
        }));
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
    reconcileProjectTree,
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
    fromRecheck?: boolean;
  }) => {
    setDoctorBusy(true);
    setDoctorNotice("");
    if (options?.fromRecheck) setTexSetupStatus("Checking…");
    try {
      const report = await invoke<DoctorReport>("run_doctor");
      setDoctorReport(report);
      const missing = isTexToolchainMissing(report);
      const fontsMissing = isConferenceFontsMissing(report);
      if (options?.openWizardIfMissing && missing) setTexSetupOpen(true);
      if (options?.fromRecheck) {
        setTexSetupStatus(
          missing || fontsMissing
            ? "Still not ready. Finish the Terminal install, then Recheck."
            : "LaTeX is ready. You can Build now.",
        );
      }
      return report;
    } catch (reason) {
      const message = toMessage(reason);
      setDoctorNotice(message);
      if (options?.fromRecheck) setTexSetupStatus(message);
      return null;
    } finally {
      setDoctorBusy(false);
    }
  }, []);

  const openTexSetupWizard = useCallback(() => {
    setTexSetupStatus(null);
    setTexSetupOpen(true);
    void runDoctor();
  }, [runDoctor]);

  const copyDoctorSummary = useCallback(async () => {
    if (!doctorReport) return;
    try {
      await writeText(doctorReport.summary);
      setDoctorNotice("Copied doctor summary.");
    } catch (reason) {
      setDoctorNotice(toMessage(reason));
    }
  }, [doctorReport]);


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
    if (!await confirmAction(`Remove “${paper.title}” from the bibliography? Downloaded paper files will be kept.`)) return;
    try {
      const bibliographyPath = project?.manifest.primaryBibliography;
      const result = await invoke<{ removed: boolean; blockers: SymbolOccurrence[] }>("remove_reference", {
        key: paper.citationKey,
      });
      if (!result.removed) {
        const first = result.blockers[0];
        setError(first
          ? `Remove citations to \\cite{${paper.citationKey}} first (${first.path}:${first.line}).`
          : `Could not remove \\cite{${paper.citationKey}}.`);
        return;
      }
      if (collabSession && bibliographyPath) {
        const content = await invoke<string>("read_project_file", { path: bibliographyPath });
        await publishTextToCollabV2(bibliographyPath, content);
      }
      if (activePaper && paperKey(activePaper) === paperKey(paper)) {
        setActivePaper(null);
        setPaperMarkdown("");
        setSavedPaperMarkdown("");
        setPaperBlog(null);
        setSavedPaperBlog(null);
        setCanvasMode("split");
      }
      await refreshProject();
      await refreshHistory();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activePaper, collabSession, project, refreshHistory, refreshProject]);

  const openSettings = useCallback((tab: SettingsTab = "appearance") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  }, []);

  const revert = useCallback(
    async (id: string) => {
      if (!await confirmAction(
        "Restore the project to the state before this change? The restore will be added as a new history entry.",
      )) return;
      try {
        await invoke("revert_transaction", { transactionId: id });
        if (activeFile) await loadFile(activeFile);
        await refreshProject();
        await refreshHistory();
        await compile();
      } catch (reason) {
        setError(toMessage(reason));
      }
    },
    [activeFile, compile, loadFile, refreshHistory, refreshProject],
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
    setEditorComments(next);
    const payload = serializeEditorComments(next);
    try {
      await invoke("save_editor_comments", { comments: next });
      // Push the same payload we just saved — avoid a disk re-read race.
      const published = await publishTextToCollabV2(EDITOR_COMMENTS_PATH, payload);
      if (!published && activeCollabVersion === 2 && collabV2ControllerRef.current) {
        // The project never had a comments file, so it is not in the catalog
        // yet — register it mid-share, seeding the payload we already hold.
        const controller = collabV2ControllerRef.current;
        await controller.create(EDITOR_COMMENTS_PATH, "text", { seedText: payload, adoptExisting: true });
        // Always merge after creation: another peer can enter the fresh Y.Text
        // before the catalog winner inserts its seed.
        const ytext = await controller.openPath(EDITOR_COMMENTS_PATH, "secondary", { sideload: true });
        const combined = mergeEditorComments(tryParseEditorComments(ytext.toString()) ?? [], next);
        setEditorComments(combined);
        await invoke("save_editor_comments", { comments: combined });
        await publishTextToCollabV2(EDITOR_COMMENTS_PATH, serializeEditorComments(combined));
      }
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeCollabVersion, editorComments, publishTextToCollabV2]);

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
    void v2.openPath(EDITOR_COMMENTS_PATH, "secondary", { sideload: true }).then((ytext) => {
      if (cancelled) return;
      const onRemote = (_event: unknown, transaction: { local: boolean }) => {
        if (transaction.local) return;
        const parsed = tryParseEditorComments(ytext.toString());
        if (parsed) setEditorComments(parsed);
      };
      ytext.observe(onRemote);
      detach = () => ytext.unobserve(onRemote);
    }).catch(() => undefined);
    return () => { cancelled = true; detach?.(); };
  }, [activeCollabVersion, collabFileCount, collabSession]);

  /** An Overleaf thread's id, when this comment is one of theirs. */
  const overleafThreadOf = useCallback((commentId: string) => (
    commentId.startsWith(OVERLEAF_COMMENT_PREFIX)
      ? commentId.slice(OVERLEAF_COMMENT_PREFIX.length)
      : null
  ), [OVERLEAF_COMMENT_PREFIX]);

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
  }, [editorComments, overleafThreadOf, persistEditorComments]);

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
  }, [collabName, editorCommentAuthorId, editorComments, overleafThreadOf, persistEditorComments]);

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
          setSettingsTab(tab);
          if (tab === "doctor") void runDoctor();
        }}
        doctorReport={doctorReport}
        doctorBusy={doctorBusy}
        doctorNotice={doctorNotice}
        onRunDoctor={() => { void runDoctor(); }}
        onOpenTexSetup={() => openTexSetupWizard()}
        onCopyDoctorSummary={() => { void copyDoctorSummary(); }}
        onCleanProject={() => { void cleanProject(); }}
        cleaning={cleaning}
        building={building}
        appearance={appearance}
        setAppearance={setAppearance}
        theme={theme}
        setTheme={setTheme}
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
        onClose={() => {
          setOverleafPickerOpen(false);
          if (tutorialActive && tutorialStep === TUTORIAL_STEPS.overleafPanel) {
            setTutorialStep(TUTORIAL_STEPS.git);
          }
        }}
        onBeforeClone={startProjectTransition}
        onCloneCancelled={cancelProjectTransition}
        onCloned={(root) => {
          setOverleafPickerOpen(false);
          void openClonedOverleafProject(root);
        }}
        onOpenSettings={() => openSettings("overleaf")}
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
  const liveOutlineSources = useMemo(() => ({
    ...outlineSources,
    ...(activeFile.endsWith(".tex") ? { [activeFile]: source } : {}),
  }), [activeFile, outlineSources, source]);
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
    if (activeFile.endsWith(".tex")) {
      merged = mergeReferences(merged, activeFile, parseLocalLabels(activeFile, source));
    }
    if (secondaryFile?.endsWith(".tex")) {
      merged = mergeReferences(merged, secondaryFile, parseLocalLabels(secondaryFile, secondarySource));
    }
    return merged;
  }, [activeFile, references, secondaryFile, secondarySource, source]);
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
        return { path, kind: "asset" as const };
      }
      return {
        path,
        kind: "file" as const,
        dirty: (path === activeFile && source !== savedSource)
          || (path === secondaryFile && secondarySource !== secondarySavedSource),
        beside: path === secondaryFile && (canvasMode === "dual" || canvasMode === "columns"),
      };
    }),
    [
      activeFile,
      activePaper?.arxivId,
      activePaperDirty,
      canvasMode,
      openTabs,
      papers,
      projectAssetPaths,
      savedSource,
      secondaryFile,
      secondarySavedSource,
      secondarySource,
      source,
    ],
  );
  useLayoutEffect(() => {
    fitSidebarToContent();
  }, [canvasMode, editorTabItems.length, fitSidebarToContent]);
  // The tab that reads as active: the open paper in paper mode, else the focused
  // editor pane. Also the key eviction must never close.
  const activeTabKey = activePaper
    ? paperTabKey(activePaper.arxivId)
    : canvasMode === "asset" && activeAsset
      ? activeAsset.path
      : (focusedPane === "secondary" && secondaryFile ? secondaryFile : activeFile);
  // Whatever is on screen is the most-recently-used tab; the split's other pane
  // counts too. Tracking recency here covers every path that opens a tab.
  useEffect(() => {
    if (activeTabKey) noteTabActive(activeTabKey);
  }, [activeTabKey, noteTabActive]);
  useEffect(() => {
    if (secondaryFile) noteTabActive(secondaryFile);
  }, [secondaryFile, noteTabActive]);
  // Cap open tabs: over the limit, close the least-recently-active tab that is
  // neither on screen nor the split's other pane (papers are never dirty; only
  // the active/secondary editors can be, and both are protected here).
  useEffect(() => {
    if (openTabs.length <= appearance.maxOpenTabs) return;
    const keep = new Set([activeTabKey, activeFile, secondaryFile].filter(Boolean) as string[]);
    const candidates = openTabs.filter((key) => !keep.has(key));
    if (!candidates.length) return;
    const staleness = (key: string) => {
      const index = tabRecency.current.indexOf(key);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    const victim = candidates.reduce((worst, key) => (staleness(key) > staleness(worst) ? key : worst));
    setOpenTabs((tabs) => tabs.filter((key) => key !== victim));
    tabRecency.current = tabRecency.current.filter((key) => key !== victim);
  }, [openTabs, appearance.maxOpenTabs, activeTabKey, activeFile, secondaryFile]);
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
    ...(activeFile.endsWith(".tex") ? { [activeFile]: source } : {}),
    ...(secondaryFile?.endsWith(".tex") ? { [secondaryFile]: secondarySource } : {}),
  }), [activeFile, outlineSources, secondaryFile, secondarySource, source]);
  const liveMacroSources = useMemo(() => Object.values(liveSourceMap), [liveSourceMap]);
  const liveMacros = useMemo(() => parseLocalMacros(liveMacroSources), [liveMacroSources]);
  const graphicsRoots = useMemo(
    () => parseGraphicsPaths(liveMacroSources),
    [liveMacroSources],
  );
  const katexMacros = useMemo(() => katexMacrosFromSources(liveMacroSources), [liveMacroSources]);
  const todoHits = useMemo(
    () => mergeTodosWithBuffer(diskTodos, activeFile, source),
    [activeFile, diskTodos, source],
  );

  useEffect(() => {
    if (!build?.success || !pdfUrl) {
      setMainBodyPages(null);
      return;
    }
    const marker = findAppendixMarker(liveSourceMap);
    if (!marker) {
      setMainBodyPages(null);
      return;
    }
    let cancelled = false;
    void invoke<{ page: number } | null>("synctex_view", {
      path: marker.path,
      line: marker.line,
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
  }, [build?.success, liveSourceMap, pdfUrl]);

  useEffect(() => {
    if (!project || !activeFile.endsWith(".tex")) {
      setTexlabDiagnostics([]);
      return;
    }
    setTexlabDiagnostics([]);
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
          if (!cancelled) setTexlabDiagnostics([]);
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
          error={error}
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
              inviteText={collabInvite}
              status={collabStatus}
              statusDetail={collabStatusDetail}
              peerCount={collabPeers}
              fileCount={collabFileCount}
              connectedRoom={collabSession?.room ?? null}
              onClose={() => setCollabOpen(false)}
              onModeChange={setCollabMode}
              onRoomChange={setCollabRoom}
              onDisplayNameChange={setCollabName}
              onInviteChange={setCollabInvite}
              onStartShare={startCollabShare}
              onJoinShare={joinCollabShare}
              recentProjectsV2={recentProjectsV2}
              onRejoinProjectV2={rejoinCollabProjectV2}
              onForgetProjectV2={forgetRecentProjectV2}
              onDisconnect={disconnectCollab}
              onCopyInvite={copyCollabInvite}
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
          statusMessage={texSetupStatus}
          onClose={() => setTexSetupOpen(false)}
          onDismiss={() => {
            dismissTexSetup();
            setTexSetupOpen(false);
          }}
          onRecheck={() => { void runDoctor({ openWizardIfMissing: true, fromRecheck: true }); }}
        />
      </>
    );
  }

  return (
    <div className={`app-shell ${isFullscreen ? "fullscreen" : ""}`} ref={shellRef}>
      <header className="titlebar" onMouseDown={beginWindowDrag} onDoubleClick={toggleWindowFullscreen}>
        <div className={`titlebar-sidebar ${sidebarOpen ? "" : "collapsed"}`} style={{ width: sidebarOpen ? sidebarWidth + 1 : undefined }}>
          <div className="titlebar-navigator">
            <div className="traffic-space" />
            <Tip label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}>
              <button className="icon-button" onClick={() => setSidebarOpen((value) => !value)}>
                <span key={sidebarOpen ? "open" : "closed"} className="toggle-icon">
                  {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
                </span>
              </button>
            </Tip>
          </div>
          <div className="project-switcher">
            <DropdownMenu open={projectMenuOpen} onOpenChange={setProjectMenuOpen} modal={false}>
              <DropdownMenuTrigger asChild>
                <button
                  className="project-title"
                  aria-label="Switch project"
                  disabled={building || importing}
                >
                  <span>{project.manifest.name}</span>
                  <ChevronDown size={13} />
                </button>
              </DropdownMenuTrigger>
              <ProjectMenu
                currentPath={project.root}
                recentProjects={recentProjects}
                busyLabel={busyLabel}
                onRecent={chooseRecentProject}
                onOpen={() => void chooseExisting()}
                onNew={() => {
                  setCreateError(null);
                  setCreateOpen(true);
                }}
                onOpenOverleaf={() => setOverleafPickerOpen(true)}
                onOpenTutorial={() => void openTutorialProject()}
                onExportZip={() => void exportProjectZip()}
                onSettings={() => openSettings("appearance")}
              />
            </DropdownMenu>
            {(collabStatus === "synced" || collabStatus === "connecting") && (
              <button
                type="button"
                className="collab-title-chip"
                title="Live collaboration"
                onClick={() => openCollabDialog(collabRole === "guest" ? "join" : "start")}
              >
                <Radio size={12} />
                <span>
                  {collabStatus === "connecting"
                    ? "Connecting…"
                    : collabRole === "guest"
                      ? (collabPeers > 0 ? `Guest · ${collabPeers} other${collabPeers === 1 ? "" : "s"}` : "Guest · live")
                      : (collabPeers > 0 ? `Sharing · ${collabPeers} other${collabPeers === 1 ? "" : "s"}` : "Sharing · just you")}
                </span>
              </button>
            )}
            {collabPeerList.length > 0 && (
              <AvatarGroup className="collab-peer-avatars" ariaLabel="People in this session">
                {collabPeerList.slice(0, 5).map((peer) => (
                  <button
                    key={peer.clientId}
                    type="button"
                    className="collab-peer-avatar"
                    style={{ background: peer.color }}
                    title={peer.path ? `${peer.name} · ${peer.path} — click to follow` : peer.name}
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
            )}
            <div className="titlebar-drag-area" aria-hidden="true" />
          </div>
        </div>
        <div className="titlebar-main">
          <EditorTabs
            tabs={editorTabItems}
            activePath={activeTabKey}
            animateLayout={!sidebarResizing}
            canCloseLast={canvasMode === "pdf"}
            onSelect={(path) => {
              if (isPaperTabKey(path)) {
                const paper = papers.find((item) => item.arxivId === arxivIdFromTabKey(path));
                if (paper) void openPaper(paper);
                else void closeEditorTab(path);
              } else if (projectAssetPaths.has(path)) {
                void openProjectAsset(path);
              } else {
                void openProjectFile(path);
              }
            }}
            onClose={(path) => { void closeEditorTab(path); }}
            onReorder={(next) => setOpenTabs(next)}
          />
          <CanvasToolbar
            mode={canvasMode}
            setMode={openDocumentMode}
            markdown={Boolean(activePaper)
              || (!activeAsset && activeFile.toLocaleLowerCase().endsWith(".md"))}
            html={!activePaper && !activeAsset && isHtmlFilePath(activeFile)}
            paperView={activePaper ? paperView : undefined}
            paperHasBlog={paperBlog !== null}
            paperHasFullText={Boolean(paperMarkdown)}
            onPaperView={activePaper ? (view) => {
              setPaperView(view);
              if (tutorialActive && tutorialStep === TUTORIAL_STEPS.paperBlog && view === "fulltext") {
                setTutorialStep(TUTORIAL_STEPS.paperFullText);
              }
            } : undefined}
            activePath={activeAsset?.path ?? activePaper?.title ?? (
              focusedPane === "secondary" && secondaryFile ? secondaryFile : activeFile
            )}
            activeKind={activeAsset ? "asset" : activePaper ? "paper" : "document"}
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
              if (tutorialActive) {
                if (tutorialStep === TUTORIAL_STEPS.collaboration) {
                  openCollabDialog("start");
                  setTutorialStep(TUTORIAL_STEPS.collaborationPanel);
                }
                return;
              }
              openCollabDialog("start");
            }}
            collabLive={collabStatus === "synced" || collabStatus === "connecting"}
            collabPeers={collabPeers}
            onHistory={() => setHistoryOpen(true)}
            onGit={() => {
              if (tutorialActive) {
                if (tutorialStep === TUTORIAL_STEPS.git) {
                  setGitOpen(true);
                  setTutorialStep(TUTORIAL_STEPS.gitPanel);
                }
                return;
              }
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
            overleafPresence={overleafPresence.peers.length ? (
              <OverleafPresenceAvatars
                peers={overleafPresence.peers}
                pathForDoc={(id) => overleafDocPaths.get(id) ?? null}
                onJump={jumpToOverleafPeer}
              />
            ) : null}
            onOverleafSync={() => {
              if (tutorialActive) {
                if (tutorialStep === TUTORIAL_STEPS.overleaf) setTutorialStep(TUTORIAL_STEPS.git);
                return;
              }
              // Manual mode is a review step, not a button that quietly
              // rewrites files: show what would change and let the user decide.
              if (overleafSyncMode === "manual") setOverleafReviewOpen(true);
              else void runOverleafSync();
            }}
            onOverleafOpen={() => {
              if (tutorialActive) {
                if (tutorialStep === TUTORIAL_STEPS.overleaf) {
                  setOverleafPickerOpen(true);
                  setTutorialStep(TUTORIAL_STEPS.overleafPanel);
                }
                return;
              }
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
          <div className="title-actions">
            {building ? (
              <Tip label="Stop the current LaTeX build">
                <button
                  className="build-button stop"
                  onClick={() => void abortBuild()}
                  aria-live="polite"
                >
                  <Square size={13} fill="currentColor" />
                  Stop
                </button>
              </Tip>
            ) : (
              <Tip label={`${autoBuildDescription(buildPreferences.autoBuildMode)}. Shift-click for clean rebuild.`}>
                <button
                  aria-label="Build"
                  data-tour="build"
                  className={`build-button ${build?.success ? "success" : ""}`}
                  onClick={(event) => {
                    if (event.shiftKey) void cleanAndRebuild();
                    else void compile();
                  }}
                  disabled={cleaning}
                  aria-live="polite"
                >
                  {build?.success ? <Check size={15} /> : <Play size={15} />}
                  {build?.success ? `${(build.durationMs / 1000).toFixed(1)}s` : "Build"}
                </button>
              </Tip>
            )}
          </div>
        </div>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          <CircleAlert size={15} aria-hidden="true" />
          <span>{error}</span>
          <CopyButton aria-label="Copy error message" title="Copy error message" text={error} />
          <button
            aria-label="Dismiss error"
            title="Dismiss error"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setError(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {warning && !error && (
        <div className="warning-banner" role="status">
          <TriangleAlert size={15} aria-hidden="true" />
          <span>{warning}</span>
          <button
            aria-label="Dismiss warning"
            title="Dismiss warning"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setWarning(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      {notice && !error && !warning && (
        <div className="notice-banner" role="status">
          <Check size={15} aria-hidden="true" />
          <span>{notice}</span>
          <button
            aria-label="Dismiss notice"
            title="Dismiss notice"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setNotice(null)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
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
          <>
            <section className="shared-sidebar" data-tour="sidebar">
              <div ref={sidebarModeHeaderRef} className="sidebar-mode-header" data-mode-tier={sidebarModeTier}>
                <SlidingTabs
                  value={sidebarMode}
                  onChange={(value) => chooseSidebarMode(value as "project" | "papers" | "agent")}
                  ariaLabel="Sidebar mode"
                  className="sidebar-mode-tabs"
                  items={[
                    { value: "project", title: "Project", label: <><FolderTree size={15} /><span>Project</span></> },
                    { value: "papers", title: "Papers", dataTour: "papers-tab", label: <><Library size={15} /><span>Papers</span></> },
                    { value: "agent", title: "Agent", dataTour: "agent-tab", label: <><Bot size={15} /><span>Agent</span></> },
                  ]}
                />
                <div ref={sidebarModeActionsRef} className="sidebar-mode-actions">
                  {sidebarMode === "project" && (
                    <>
                      <Tip label="New board">
                        <button
                          aria-label="New board"
                          onClick={() => setBoardCreateRequest((request) => request + 1)}
                        >
                          <Shapes size={13} />
                        </button>
                      </Tip>
                      <Tip label={projectSearchOpen ? "Hide file search" : "Search files"}>
                        <button
                          aria-pressed={projectSearchOpen}
                          onPointerDown={(event) => {
                            if (projectSearchOpen) event.preventDefault();
                          }}
                          onClick={() => setProjectSearchOpen((open) => !open)}
                        >
                          <Search size={13} />
                        </button>
                      </Tip>
                    </>
                  )}
                  {sidebarMode === "papers" && (
                    <>
                      <Tip label="Discover literature">
                        <button aria-label="Discover literature" onClick={() => setLiteratureOpen(true)}>
                          <BookOpen size={14} />
                        </button>
                      </Tip>
                      <Tip label="Add bibliography entry">
                        <button onClick={() => openBibEntryDialog()}><BookMarked size={14} /></button>
                      </Tip>
                    </>
                  )}
                  {sidebarMode === "agent" && synaraOrigin && (
                    <SynaraPermissionPicker
                      value={synaraPermissionMode}
                      autoModeAvailable={synaraAutoModeAvailable}
                      onChange={changeSynaraPermissionMode}
                    />
                  )}
                </div>
              </div>
              <div className="sidebar-pane" data-tour="project-panel" hidden={sidebarMode === "agent"}>
                <Navigator
                  mode={sidebarMode === "papers" ? "papers" : "project"}
                  projectKey={project.root}
                  searchOpen={projectSearchOpen}
                  boardCreateRequest={boardCreateRequest}
                  onSearchOpenChange={setProjectSearchOpen}
                  files={project.files}
                  gitStatus={projectGitStatus.projectRoot === project.root ? projectGitStatus.files : []}
                  activeFile={activeAsset || activePaper ? "" : activeFile}
                  activeAssetPath={activeAsset?.path ?? ""}
                  protectedPaths={[
                    ...project.manifest.rootDocuments.map((document) => document.path),
                    project.manifest.primaryBibliography,
                  ]}
                  papers={papers}
                  activePaper={activePaper}
                  onFile={openProjectFileFromClick}
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
                      if (opened?.hasBlog) setPaperView("blog");
                      setTutorialStep(opened?.hasBlog ? TUTORIAL_STEPS.paperBlog : TUTORIAL_STEPS.paperFullText);
                    }
                  })}
                  onFetchFullText={(paper) => void fetchAndOpenPaper(paper)}
                  paperFetchStates={paperFetchStates}
                  onDeletePaper={deletePaper}
                  onEditBibEntry={(paper) => void openEditBibEntry(paper)}
                  importInput={importInput}
                  setImportInput={setImportInput}
                  onImport={importPaper}
                  importing={importing}
                />
              </div>
              <div
                className={`sidebar-pane synara-sidebar-pane ${sidebarMode === "agent" ? "active" : ""}`}
                aria-hidden={sidebarMode !== "agent"}
              >
                <div className="synara-frame-shell" data-tour="agent-panel" data-ready={synaraFrameReady || undefined}>
                  {synaraFrameMounted && synaraOrigin && (
                    <iframe
                      ref={synaraIframeRef}
                      className="synara-poc-frame"
                      src={synaraEmbedUrl(
                        synaraOrigin,
                        synaraRuntime.authToken,
                        project.root,
                        theme,
                      )}
                      title="Agent"
                      allow="clipboard-read; clipboard-write; microphone"
                      sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
                    />
                  )}
                  {!synaraFrameReady && (
                    <SynaraLoadingSurface
                      runtime={synaraRuntime}
                      preparingWorkspace={Boolean(synaraOrigin)}
                      onRetry={retrySynaraRuntime}
                    />
                  )}
                </div>
              </div>
            </section>
            <PanelResizer
              label="Resize workspace sidebar"
              value={sidebarWidth}
              onPointerDown={beginSidebarResize}
              onNudge={nudgeSidebar}
            />
          </>
        )}

        <section className="canvas-panel" data-tour="canvas">
          <div className="canvas-body">
          <span className="canvas-tour-card-anchor" data-tour="canvas-tour-card-anchor" aria-hidden="true" />
          <Suspense fallback={<div className="document-canvas-loading" aria-label="Preparing editor" />}>
          <DocumentCanvas
            mode={canvasMode}
            workspaceIndex={workspaceIndex}
            source={activePaper ? activePaperSource : source}
            markdownPreviewSource={activePaper ? activePaperPreviewSource : undefined}
            activeFile={activePaperPath ?? activeFile}
            secondaryFile={secondaryFile}
            secondarySource={secondarySource}
            setSecondarySource={setSecondarySource}
            focusedPane={focusedPane}
            onFocusPane={setFocusedPane}
            setSource={activePaper ? setActivePaperSource : setSource}
            setSelection={(value) => reportAgentSelection(activePaper ? "paper" : "editor", value)}
            onPdfTextSelect={(value) => reportAgentSelection("pdf", value)}
            onPaperTextSelect={(value) => reportAgentSelection("paper", value)}
            onImportAsset={importClipboardImageFile}
            onContextSurfaceActivate={activateAgentHostSurface}
            onViewMarkdownSource={() => setCanvasMode("split")}
            pdfUrl={pdfUrl}
            pdfBase64={null}
            pdfBytes={displayedPdfBytesRef.current}
            pdfTop={!diagnosticsDismissed && build && (!build.success || build.diagnostics.length > 0) ? (
              <Suspense fallback={null}>
                <CompileDiagnosticsPanel
                  diagnostics={build.diagnostics}
                  log={build.log}
                  success={build.success}
                  expanded={diagnosticsExpanded}
                  onExpandedChange={setDiagnosticsExpanded}
                  onSelect={(diagnostic) => void openCompileDiagnostic(diagnostic)}
                  onDismiss={() => setDiagnosticsDismissed(true)}
                />
              </Suspense>
            ) : null}
            activePaper={activePaper}
            activeAsset={activeAsset}
            canOpenCitation={(key) => papers.some((item) => item.citationKey?.toLocaleLowerCase() === key.toLocaleLowerCase()
              && (item.hasFullText || item.hasBlog))}
            onOpenCitation={(key) => {
              const paper = papers.find((item) => item.citationKey?.toLocaleLowerCase() === key.toLocaleLowerCase()
                && (item.hasFullText || item.hasBlog));
              if (paper) void openPaper(paper, true);
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
            onViewState={(path, state) => { viewStateRef.current.set(path, state); }}
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
            spellingWords={project.manifest.spellingWords ?? []}
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
            canForwardSync={Boolean(editorPosition && pdfUrl)}
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
                overleafLink === null
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
          />
          </Suspense>
          </div>
        </section>

      </main>

      {collabOpen && (
        <Suspense fallback={null}>
          <CollabDialog
            open
            mode={collabMode}
            role={collabRole}
            joinOnly={false}
            chatMessages={collabChat.messages}
            chatSelfId={editorCommentAuthorId}
            chatUnread={collabChat.unread}
            onChatSend={collabChat.send}
            onChatOpen={collabChat.markRead}
            host={collabHost}
            room={collabRoom}
            displayName={collabName}
            inviteText={collabInvite}
            status={collabStatus}
            statusDetail={collabStatusDetail}
            peerCount={collabPeers}
            fileCount={collabFileCount}
            connectedRoom={collabSession?.room ?? null}
            onClose={() => {
              setCollabOpen(false);
              if (tutorialActive && tutorialStep === TUTORIAL_STEPS.collaborationPanel) {
                setTutorialStep(TUTORIAL_STEPS.overleaf);
              }
            }}
            onModeChange={setCollabMode}
            onRoomChange={setCollabRoom}
            onDisplayNameChange={setCollabName}
            onInviteChange={setCollabInvite}
            onStartShare={startCollabShare}
            onJoinShare={joinCollabShare}
            recentProjectsV2={recentProjectsV2}
            onRejoinProjectV2={rejoinCollabProjectV2}
            onForgetProjectV2={forgetRecentProjectV2}
            onDisconnect={disconnectCollab}
            onCopyInvite={copyCollabInvite}
            onInstallTex={openTexSetupWizard}
          />
        </Suspense>
      )}

      <TexSetupWizard
        open={texSetupOpen}
        report={doctorReport}
        checking={doctorBusy}
        statusMessage={texSetupStatus}
        onClose={() => setTexSetupOpen(false)}
        onDismiss={() => {
          dismissTexSetup();
          setTexSetupOpen(false);
        }}
        onRecheck={() => { void runDoctor({ openWizardIfMissing: true, fromRecheck: true }); }}
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

      <Suspense fallback={null}>
      {historyOpen && (
        <HistoryDrawer
          history={projectHistory}
          onClose={() => setHistoryOpen(false)}
          onVersionsChanged={async () => {
            await refreshProject();
            if (activeFile) await loadFile(activeFile);
            await refreshHistory();
            await compile();
          }}
          onRevert={(item) => {
            if (
              item.kind === "agent-checkpoint"
              && item.threadId
              && typeof item.turnCount === "number"
              && synaraOrigin
            ) {
              synaraIframeRef.current?.contentWindow?.postMessage(
                {
                  type: LATTICE_RESTORE_AGENT_CHECKPOINT,
                  threadId: item.threadId,
                  turnCount: item.turnCount,
                },
                synaraOrigin,
              );
              return;
            }
            void revert(item.id);
          }}
          onRevertFile={async (id, path) => {
            if (!await confirmAction(
              `Restore only “${path}” to the state before this change? The restore will be added as a new history entry.`,
            )) return;
            try {
              await invoke("revert_history_file", { transactionId: id, path });
              if (activeFile === path || activeFile) await loadFile(activeFile);
              await refreshProject();
              await refreshHistory();
              await compile();
            } catch (reason) {
              setError(toMessage(reason));
            }
          }}
          onDelete={deleteHistory}
          onOpenFile={(path, line) => { void openProjectFile(path, line); }}
          overleafLinked={overleafLink !== null}
          overleafProjectRoot={project.root}
          onOverleafRestored={async () => {
            // The restore happened on Overleaf's server and left the local
            // files alone, so pull it down the same way a manual sync does
            // before anything on this side reloads.
            await runOverleafSync();
            await refreshProject();
            if (activeFile) await loadFile(activeFile);
            await refreshHistory();
            await compile();
          }}
        />
      )}
      {gitOpen && project ? (
        <ResizableDrawer
          className="git-drawer synara-source-control-drawer"
          dataTour="git-panel"
          onClose={() => {
            setGitOpen(false);
            if (tutorialActive && tutorialStep === TUTORIAL_STEPS.gitPanel) {
              setTutorialStep(TUTORIAL_STEPS.openPapers);
            }
          }}
        >
          <div className="agent-git-workspace-header">
            <div className="agent-git-workspace-tabs" role="tablist" aria-label="Git workspace">
              <button
                type="button"
                role="tab"
                aria-selected={gitWorkspaceView === "changes"}
                className={gitWorkspaceView === "changes" ? "active" : ""}
                onClick={() => setGitWorkspaceView("changes")}
              >
                Changes
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={gitWorkspaceView === "pull-requests"}
                className={gitWorkspaceView === "pull-requests" ? "active" : ""}
                onClick={() => setGitWorkspaceView("pull-requests")}
              >
                Pull requests
              </button>
            </div>
            <button
              type="button"
              className="agent-git-workspace-close"
              aria-label="Close Git workspace"
              title="Close"
              onClick={() => {
                setGitOpen(false);
                if (tutorialActive && tutorialStep === TUTORIAL_STEPS.gitPanel) {
                  setTutorialStep(TUTORIAL_STEPS.openPapers);
                }
              }}
            >
              <X size={14} />
            </button>
          </div>
            {synaraOrigin ? (
              <iframe
                ref={synaraSourceControlFrameRef}
                className="synara-source-control-frame"
                src={synaraSourceControlUrl(
                  synaraOrigin,
                  synaraRuntime.authToken,
                  project.root,
                  theme,
                  gitWorkspaceView,
                )}
                title={gitWorkspaceView === "changes" ? "Changes" : "Pull requests"}
                allow="clipboard-read; clipboard-write"
                sandbox="allow-scripts allow-same-origin allow-forms allow-downloads"
              />
            ) : (
              <SynaraLoadingSurface runtime={synaraRuntime} onRetry={retrySynaraRuntime} />
            )}
        </ResizableDrawer>
      ) : null}
      {overleafCollabOpen && overleafLink && (
        <Suspense fallback={null}>
          <OverleafCollabDrawer
            tab={overleafCollabTab}
            onTab={setOverleafCollabTab}
            projectName={overleafLink.projectName}
            onClose={() => setOverleafCollabOpen(false)}
            threads={overleafComments.threads}
            anchors={overleafComments.anchors}
            activeDocId={overleafRealtime.docId}
            pathForDoc={(id) => overleafDocPaths.get(id) ?? null}
            documentOpen={overleafRealtime.docId !== null}
            commentsLoading={overleafComments.loading}
            commentsError={overleafComments.error}
            onReply={overleafComments.reply}
            onResolve={overleafComments.setResolved}
            onDeleteThread={overleafComments.remove}
            onEditMessage={overleafComments.editMessage}
            onDeleteMessage={overleafComments.deleteMessage}
            onRevealComment={(path, position) => {
            // The comment may be on a file that is not open, so open it first
            // and place the caret after. A comment's anchor is a character
            // offset rather than a line, which is what `viewRestore` takes.
            void openProjectFile(path).then(() => {
              setViewRestore({ path, cursor: position, scrollTop: 0, id: crypto.randomUUID() });
              setOverleafCollabOpen(false);
            });
          }}
          onReveal={(position) => {
            const path = activeFileRef.current;
            if (!path) return;
            setViewRestore({ path, cursor: position, scrollTop: 0, id: crypto.randomUUID() });
            setOverleafCollabOpen(false);
          }}
          messages={overleafChat.messages}
          chatLoading={overleafChat.loading}
          chatError={overleafChat.error}
          onSend={overleafChat.send}
          unreadChat={overleafChat.unread}
          changes={overleafRealtime.changes}
          source={source}
          changeAuthorName={overleafTrackChanges.authorName}
          canActOnChanges={overleafRealtime.canWrite}
          changesBusy={overleafTrackChanges.busy}
          changesError={overleafTrackChanges.error}
          onAcceptChanges={overleafTrackChanges.accept}
            onRejectChanges={overleafTrackChanges.reject}
          />
        </Suspense>
      )}
      {editorCommentsOpen && (
        <EditorCommentsPanel
          comments={allEditorComments}
          activePath={activeFile}
          currentAuthorId={editorCommentAuthorId}
          focusCommentId={commentPanelFocusId}
          onClose={() => {
            setEditorCommentsOpen(false);
            setCommentPanelFocusId(null);
          }}
          onOpen={(comment) => {
            setActiveEditorCommentId(comment.id);
            setEditorCommentsOpen(false);
            setCommentPanelFocusId(null);
            void openProjectFile(comment.path).then(() => {
              setCommentFocusRequest({ id: comment.id, nonce: crypto.randomUUID() });
            });
          }}
          onDelete={(id) => {
            void (async () => {
              if (!await confirmAction(
                "Delete this comment? Its replies will be removed too. This cannot be undone.",
              )) {
                return;
              }
              const threadId = overleafThreadOf(id);
              if (threadId) {
                await overleafComments.remove(threadId).catch((reason) => setError(toMessage(reason)));
                return;
              }
              await persistEditorComments(editorComments.filter((comment) => comment.id !== id));
              setActiveEditorCommentId((current) => (current === id ? null : current));
            })();
          }}
          onToggleResolved={(comment) => toggleEditorCommentResolved(comment.id)}
          onUpdateBody={(comment, body) => {
            const trimmed = body.trim();
            if (!trimmed) return;
            // Overleaf's threads are edited where they live; changing the text
            // of someone else's first message is not ours to do from here.
            if (overleafThreadOf(comment.id)) return;
            void persistEditorComments(editorComments.map((item) => (
              item.id === comment.id
                ? { ...item, body: trimmed, updatedAt: new Date().toISOString() }
                : item
            )));
          }}
          onReply={(comment, body) => replyToEditorComment(comment.id, body)}
        />
      )}
      </Suspense>
      {todosOpen && (
        <TodoScavengerPanel
          hits={todoHits}
          onClose={() => setTodosOpen(false)}
          onOpen={(path, line) => {
            void openProjectFile(path, line);
            setTodosOpen(false);
          }}
        />
      )}
      {checklistOpen && project && (
        <ManuscriptChecklistPanel
          data={{
            words: projectWordCount?.total ?? 0,
            wordSource: projectWordCount?.source ?? "estimate",
            wordBudget: project.manifest.wordBudget ?? null,
            pages: pdfPageCount,
            mainPages: mainBodyPages,
            pageBudget: project.manifest.pageBudget ?? null,
            todos: todoHits.length,
            unusedLabels: unusedSymbols.labels.length,
            unusedCitations: unusedSymbols.citations.length,
            buildOk: build ? build.success : null,
            buildMessage: build?.log?.split("\n").slice(-1)[0] ?? "",
          }}
          onClose={() => setChecklistOpen(false)}
          onOpenTodos={() => {
            setChecklistOpen(false);
            void refreshTodos();
            setTodosOpen(true);
          }}
          onSaveBudgets={(wordBudget, pageBudget) => {
            void (async () => {
              try {
                const manifest = await invoke<ProjectManifest>("update_project_manifest", {
                  wordBudget: wordBudget ?? undefined,
                  pageBudget: pageBudget ?? undefined,
                  clearWordBudget: wordBudget == null,
                  clearPageBudget: pageBudget == null,
                });
                setProject((current) => current ? { ...current, manifest } : current);
              } catch (reason) {
                setError(toMessage(reason));
              }
            })();
          }}
        />
      )}
      <QuickOpenDialog
        open={quickOpenOpen}
        paths={projectPaths}
        onClose={() => setQuickOpenOpen(false)}
        onOpen={(path) => {
          setQuickOpenOpen(false);
          void openProjectFile(path);
        }}
      />
      <SearchPickerDialog
        open={goToSymbolOpen}
        title="Go to symbol"
        placeholder="Go to section or label…"
        items={goToSymbolItems}
        onClose={() => setGoToSymbolOpen(false)}
        onSelect={(item) => {
          setGoToSymbolOpen(false);
          if (item.id.startsWith("section:")) {
            const node = flattenOutline(outlineNodes).find((entry) => `section:${entry.id}` === item.id);
            if (node) void openProjectFile(node.path || activeFile, node.line);
            return;
          }
          const reference = liveReferences.find((entry) => `label:${entry.path}:${entry.label}` === item.id);
          if (reference) void openProjectFile(reference.path, reference.line);
        }}
      />
      <SearchPickerDialog
        open={refCitePicker === "cite"}
        title="Insert citation"
        placeholder="Insert \\cite{…}"
        items={citePickerItems}
        onClose={() => setRefCitePicker(null)}
        onSelect={(item) => {
          setRefCitePicker(null);
          setCiteInsertRequest({ key: item.label, command: "cite", id: crypto.randomUUID() });
          setCanvasMode((mode) => (mode === "pdf" || mode === "asset" ? "split" : mode));
        }}
      />
      <SearchPickerDialog
        open={refCitePicker === "ref"}
        title="Insert reference"
        placeholder="Insert \\ref{…}"
        items={refPickerItems}
        onClose={() => setRefCitePicker(null)}
        onSelect={(item) => {
          setRefCitePicker(null);
          setCiteInsertRequest({ key: item.label, command: "ref", id: crypto.randomUUID() });
          setCanvasMode((mode) => (mode === "pdf" || mode === "asset" ? "split" : mode));
        }}
      />
      <GotoLineDialog
        open={gotoLineOpen}
        line={editorPosition?.line ?? 1}
        maxLine={Math.max(1, source.split("\n").length)}
        onClose={() => setGotoLineOpen(false)}
        onGoto={(line) => {
          setGotoLineOpen(false);
          if (activeFile) {
            setEditorNavigation({ path: activeFile, line, id: crypto.randomUUID() });
          }
        }}
      />
      <ProjectFindDialog
        open={projectFindOpen}
        busy={projectFindBusy}
        error={projectFindError}
        hits={projectFindHits}
        onClose={() => {
          setProjectFindOpen(false);
          setProjectFindError(null);
        }}
        onSearch={(query) => {
          void (async () => {
            if (!query.trim()) {
              setProjectFindHits([]);
              setProjectFindBusy(false);
              setProjectFindError(null);
              return;
            }
            setProjectFindBusy(true);
            setProjectFindError(null);
            try {
              const results = await invoke<ProjectFindHit[]>("search_project", { query });
              setProjectFindHits(results);
            } catch (reason) {
              setProjectFindHits([]);
              setProjectFindError(toMessage(reason));
            } finally {
              setProjectFindBusy(false);
            }
          })();
        }}
        onOpenHit={(path, line) => {
          void openProjectFile(path, line);
        }}
      />
      <ProjectReplaceDialog
        open={projectReplaceOpen}
        busy={projectReplaceBusy}
        error={projectReplaceError}
        preview={projectReplacePreview}
        onClose={() => {
          setProjectReplaceOpen(false);
          setProjectReplacePreview(null);
        }}
        onOpenMatch={(path, line) => {
          void openProjectFile(path, line);
        }}
        onPreview={(query, options) => {
          void (async () => {
            setProjectReplaceBusy(true);
            setProjectReplaceError(null);
            try {
              if (source !== savedSource) {
                const saved = await save();
                if (!saved) return;
              }
              const preview = await invoke<ReplacePreviewResult>("preview_replace_in_project", {
                query,
                paths: null,
                matchCase: options.matchCase,
                useRegex: options.useRegex,
              });
              setProjectReplacePreview(preview);
            } catch (reason) {
              setProjectReplacePreview(null);
              setProjectReplaceError(toMessage(reason));
            } finally {
              setProjectReplaceBusy(false);
            }
          })();
        }}
        onReplace={(query, replacement, options) => {
          void (async () => {
            setProjectReplaceBusy(true);
            setProjectReplaceError(null);
            try {
              if (source !== savedSource) {
                const saved = await save();
                if (!saved) return;
              }
              const result = await invoke<ReplaceResult>("replace_in_project", {
                query,
                replacement,
                paths: null,
                matchCase: options.matchCase,
                useRegex: options.useRegex,
              });
              if (activeFile) await loadFile(activeFile);
              await refreshProject();
              await refreshHistory();
              setProjectReplaceOpen(false);
              setProjectReplacePreview(null);
              setError(null);
              setNotice(result.replacements
                ? `Replaced ${result.replacements} occurrence${result.replacements === 1 ? "" : "s"} in ${result.filesChanged.length} file${result.filesChanged.length === 1 ? "" : "s"}.`
                : "No matches found.");
            } catch (reason) {
              setProjectReplaceError(toMessage(reason));
            } finally {
              setProjectReplaceBusy(false);
            }
          })();
        }}
      />
      <BibEntryDialog
        key={bibEntryKey}
        open={bibEntryOpen}
        busy={bibEntryBusy}
        resolving={bibEntryResolving}
        error={bibEntryError}
        mode={bibEntryMode}
        initialResolveQuery={bibResolveSeed}
        initialDraft={bibEntryInitial}
        onClose={() => {
          if (!bibEntryBusy && !bibEntryResolving) setBibEntryOpen(false);
        }}
        onResolve={resolveBibQuery}
        onSave={(draft, insertCite) => { void saveBibEntry(draft, insertCite); }}
      />
      {literatureOpen && (
        <Suspense fallback={null}>
          <LiteratureDiscoveryPanel
            onClose={() => setLiteratureOpen(false)}
            importedIds={importedArxivIds}
            onImportArxiv={(arxivId) => importReferenceInput(arxivId)}
            onAddBib={(query) => {
              setLiteratureOpen(false);
              openBibEntryDialog(query);
            }}
          />
        </Suspense>
      )}
      <SearchPickerDialog
        open={commandPaletteOpen}
        title="Command palette"
        placeholder="Run a command…"
        items={[
          { id: "build", label: "Build project", detail: "Compile LaTeX", group: "Build" },
          { id: "rebuild", label: "Clean rebuild", detail: "latexmk -c then -g", group: "Build" },
          { id: "clean", label: "Clean aux files", group: "Build" },
          { id: "stop-build", label: "Stop build", group: "Build" },
          { id: "sync-pdf", label: "Jump to PDF", detail: "⌘⇧J", group: "Navigate" },
          { id: "quick-open", label: "Quick open file", detail: "⌘P", group: "Navigate" },
          { id: "goto-line", label: "Go to line", detail: "⌘G", group: "Navigate" },
          { id: "goto-symbol", label: "Go to symbol", detail: "⌘⇧O", group: "Navigate" },
          { id: "view-dual", label: "Dual source view", detail: "Two files side by side", group: "View" },
          { id: "view-columns", label: "Two sources + PDF", detail: "2+pdf", group: "View" },
          { id: "view-split", label: "Source + PDF", detail: "split", group: "View" },
          { id: "swap-panes", label: "Swap editor panes", detail: secondaryFile ? `${activeFile} ↔ ${secondaryFile}` : "Needs dual view", group: "View" },
          ...(canInsert
            ? [{ id: "insert", label: "Insert snippet", detail: "⌘⇧I", group: "Edit" }]
            : []),
          {
            id: "collab",
            label: collabSession ? "Live sharing…" : "Start / join live sharing",
            detail: collabSession ? `${collabPeers} connected · ${collabSession.room}` : "Share invite with a collaborator",
            group: "Edit",
          },
          { id: "table", label: "Insert table", detail: "Grid generator", group: "Edit" },
          { id: "cite", label: "Insert citation", detail: "⌘⇧K", group: "Edit" },
          { id: "ref", label: "Insert reference", detail: "⌘⇧L", group: "Edit" },
          { id: "bib", label: "Add bibliography entry", group: "Edit" },
          { id: "discover", label: "Discover literature", detail: "OpenAlex search", group: "Research" },
          { id: "find", label: "Find in project", detail: "⌘⇧F · all .tex files", group: "Edit" },
          { id: "replace", label: "Replace in project", detail: "⌘⇧H · all .tex files", group: "Edit" },
          { id: "todos", label: "Manuscript TODOs", detail: `${todoHits.length || "No"} markers`, group: "Edit" },
          { id: "checklist", label: "Submission checklist", detail: "Words / pages / TODOs", group: "Edit" },
          { id: "paste-image", label: "Paste clipboard image as figure", group: "Edit" },
          { id: "format", label: "Format document", detail: "latexindent", group: "Edit" },
          { id: "history", label: "Open project history", group: "Project" },
          { id: "export-zip", label: "Export project ZIP", detail: "Overleaf / arXiv source pack", group: "Project" },
          { id: "tutorial", label: "Start product tour", detail: "Guided tour with the Understanding Attention sample project", group: "Project" },
          { id: "doctor", label: "Run TeX doctor", group: "Project" },
          { id: "settings", label: "Open settings", group: "Project" },
        ]}
        onClose={() => setCommandPaletteOpen(false)}
        onSelect={(item) => {
          setCommandPaletteOpen(false);
          switch (item.id) {
            case "build": void compile(); break;
            case "rebuild": void cleanAndRebuild(); break;
            case "clean": void cleanProject(); break;
            case "stop-build": void abortBuild(); break;
            case "sync-pdf": void revealSourceInPdf(); break;
            case "quick-open": setQuickOpenOpen(true); break;
            case "goto-line": setGotoLineOpen(true); break;
            case "goto-symbol": setGoToSymbolOpen(true); break;
            case "view-dual": openDocumentMode("dual"); break;
            case "view-columns": openDocumentMode("columns"); break;
            case "view-split": openDocumentMode("split"); break;
            case "swap-panes": void swapEditorPanes(); break;
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
                setError("Open a .tex file before formatting.");
                break;
              }
              void import("./texlab-language")
                .then(({ formatLatexDocument }) => formatLatexDocument(path, text))
                .then((formatted) => {
                  if (formatted === text) {
                    setNotice("Document is already formatted.");
                    return;
                  }
                  if (focusedPane === "secondary" && secondaryFile) setSecondarySource(formatted);
                  else setSource(formatted);
                  setNotice("Formatted with latexindent.");
                })
                .catch((reason) => setError(toMessage(reason)));
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
      {tutorialActive && (
        <Suspense fallback={null}>
          <OnboardingTour
            key={`tutorial:${tutorialStep}:${canvasMode}`}
            active
            stepIndex={tutorialStep}
            onSelectTutorialFile={(path, nextStep) => {
              const mode: CanvasMode = path.endsWith(".html")
                ? "pdf"
                : path.endsWith(".tldr")
                  ? "source"
                  : "split";
              void openProjectFile(path).then(() => {
                setCanvasMode(mode);
                setTutorialStep(nextStep);
              });
            }}
            onStepIndexChange={(nextStep) => {
              const openTutorialDocument = async (path: string, mode: CanvasMode) => {
                await openProjectFile(path);
                setCanvasMode(mode);
                setTutorialStep(nextStep);
              };
              if (tutorialStep === TUTORIAL_STEPS.collaborationPanel) setCollabOpen(false);
              if (tutorialStep === TUTORIAL_STEPS.overleafPanel) setOverleafPickerOpen(false);
              if (tutorialStep === TUTORIAL_STEPS.gitPanel) setGitOpen(false);
              if (nextStep === TUTORIAL_STEPS.latex) {
                void openTutorialDocument("main.tex", "split");
              } else if (nextStep === TUTORIAL_STEPS.markdown || nextStep === TUTORIAL_STEPS.markdownVisual) {
                void openTutorialDocument("notes.md", "split");
              } else if (nextStep === TUTORIAL_STEPS.html) {
                void openTutorialDocument("attention-demo.html", "pdf");
              } else if (nextStep === TUTORIAL_STEPS.board) {
                void openTutorialDocument("attention-map.tldr", "source");
              } else if (nextStep === TUTORIAL_STEPS.collaboration) {
                void openTutorialDocument("main.tex", "split");
              } else if (nextStep === TUTORIAL_STEPS.paperBlog) {
                setPaperView("blog");
                setTutorialStep(nextStep);
              } else if (nextStep === TUTORIAL_STEPS.paperFullText) {
                setPaperView("fulltext");
                setTutorialStep(nextStep);
              } else {
                setTutorialStep(nextStep);
              }
            }}
            onSkip={() => {
              markTutorialSeen();
              setCollabOpen(false);
              setOverleafPickerOpen(false);
              setGitOpen(false);
              setTutorialActive(false);
            }}
            onComplete={() => {
              markTutorialSeen();
              setCollabOpen(false);
              setOverleafPickerOpen(false);
              setGitOpen(false);
              setTutorialActive(false);
              setSidebarMode("project");
              setSidebarOpen(true);
              void openProjectFile("main.tex").then(() => {
                setCanvasMode("split");
                setNotice("Tutorial complete · keep exploring or start your own project.");
              });
            }}
          />
        </Suspense>
      )}
      {createOpen && (
        <CreateProjectDialog
          projectName={projectName}
          setProjectName={(value) => {
            setProjectName(value);
            setCreateError(null);
          }}
          projectVenue={projectVenue}
          setProjectVenue={(value) => {
            setProjectVenue(value);
            setCreateError(null);
          }}
          error={createError}
          onCreate={createProject}
          onClose={() => {
            setCreateError(null);
            setCreateOpen(false);
          }}
        />
      )}
      {renameTarget && (
        <RenameDialog
          target={renameTarget}
          error={renameError}
          onRename={submitRename}
          onClose={() => {
            setRenameError(null);
            setRenameTarget(null);
          }}
        />
      )}
    </div>
  );
}

function PanelResizer(props: {
  label: string;
  value: number;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onNudge: (delta: number) => void;
}) {
  return (
    <div
      className="panel-resizer sidebar-resizer"
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuenow={Math.round(props.value)}
      tabIndex={0}
      onPointerDown={props.onPointerDown}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          props.onNudge(-16);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          props.onNudge(16);
        }
      }}
    />
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export default App;
