import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import CodeMirror from "@uiw/react-codemirror";
import { linter, lintGutter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { emacs } from "@replit/codemirror-emacs";
import { vim } from "@replit/codemirror-vim";
import { latex } from "codemirror-lang-latex";
import {
  BookMarked,
  Download,
  BookOpen,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  Copy,
  Eraser,
  File,
  FileArchive,
  FileCode2,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  History,
  Image,
  ImagePlus,
  KeyRound,
  Library,
  ListTodo,
  LoaderCircle,
  LocateFixed,
  MessageSquareText,
  Omega,
  Columns2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  Pencil,
  Quote,
  Radio,
  RotateCcw,
  RefreshCw,
  Search,
  Send,
  Settings2,
  Sparkles,
  TerminalSquare,
  Square,
  Trash2,
  Undo2,
  Redo2,
  X,
} from "lucide-react";
import {
  bibliographyEntryLine,
  countWords,
  latexEditorExtensions,
  latexLanguageOptions,
  mergeReferences,
  parseGraphicsPaths,
  parseLocalLabels,
  parseLocalMacros,
  renameEnvironmentAt,
  textStats,
  wrapEnvironment,
  type CitationInfo,
  type DefinitionTarget,
  type ReferenceInfo,
  type SymbolTarget,
} from "./latex-editor";
import { appendBibEntry, formatBibEntry, type BibEntryDraft } from "./bib-entry";
import { BibEntryDialog, type ResolvedCitationDraft } from "./bib-entry-dialog";
import { clipboardImageFileName, fileToBase64, rgbaImageToPngBase64 } from "./clipboard-image";
import { latexFigureInsertion, type FigureInsertOptions } from "./figure-insertion";
import { FigureInsertDialog } from "./figure-insert-dialog";
import { GotoLineDialog } from "./goto-line-dialog";
import { QuickOpenDialog } from "./quick-open-dialog";
import { SearchPickerDialog, type SearchPickerItem } from "./search-picker-dialog";
import { CollabDialog, type CollabDialogMode } from "./collab-dialog";
import { TexSetupWizard } from "./tex-setup-wizard";
import {
  dismissTexSetup,
  isConferenceFontsMissing,
  isMissingTexBuildError,
  isTexToolchainMissing,
  wasTexSetupDismissed,
} from "./tex-setup";
import {
  attachCollabProjectObservers,
  materializeCollabDocToProject,
  pushLocalBlobToCollab,
  pushLocalTextToCollab,
  seedCollabDocFromProject,
} from "./collab-project-io";
import {
  COLLAB_EDITOR_COMMENTS_PATH,
  classifySyncablePath,
  collabDocHasProject,
  collabTextsMap,
  endCollabShare,
  observeCollabShareEnded,
  removeCollabPath,
  renameCollabPath,
  waitForCollabProject,
} from "./collab-project-sync";
import {
  createEditorComment,
  createEditorCommentReply,
  editorCommentsExtension,
  loadEditorCommentAuthorId,
  resolveCommentRange,
  serializeEditorComments,
  setEditorCommentsEffect,
  tryParseEditorComments,
} from "./editor-comments";
import { useUpdater, type UpdateMode } from "./app-updater";
import {
  type EditorComment,
} from "./editor-comments";
import { EditorCommentsPanel } from "./editor-comments-panel";
import {
  clearPreCollabProjectRoot,
  rememberPreCollabProjectRoot,
  resolvePreCollabProjectRoot,
} from "./collab-return";
import { pdfBase64Fingerprint, pdfBase64ToObjectUrl } from "./pdf-bytes";
import {
  collabEditorExtensions,
  createCollabSession,
  createShareRoomCode,
  formatCollabInviteMessage,
  loadCollabDisplayName,
  loadCollabHost,
  parseCollabInvite,
  resolveCollabHost,
  saveCollabDisplayName,
  saveCollabHost,
  peerCursorLocation,
  peerInitials,
  type CollabPeer,
  type CollabSession,
  type CollabStatus,
} from "./collab-session";
import { CompileDiagnosticsPanel } from "./compile-diagnostics-panel";
import {
  editorDiagnosticsForFile,
  flattenProjectPaths,
  resolveDiagnosticPath,
  type CompileDiagnostic,
} from "./compile-diagnostics";
import { editorTexlabDiagnosticsForFile } from "./texlab-diagnostics";
import { formatLatexDocument } from "./texlab-language";
import { DocumentOutline } from "./document-outline";
import {
  activeOutlineNode,
  flattenOutline,
  includedPathsIn,
  parseProjectOutline,
  sectionBreadcrumbNodes,
  type OutlineNode,
} from "./latex-outline";
import { ReferencesPanel, type SymbolOccurrence } from "./references-panel";
import { GitPanel } from "./git-panel";
import { HistoryDrawer, type HistoryItem } from "./history-drawer";
import { InsertPalette } from "./insert-palette";
import type { InsertSnippet } from "./insert-snippets";
import { expandSnippetPlaceholders, nextSnippetStop, previousSnippetStop } from "./snippet-placeholders";
import { MathPreview } from "./math-preview";
import { katexMacrosFromSources } from "./katex-macros";
import { ChatMarkdown } from "./chat-markdown";
import { applySlashCommand, filterSlashCommands, slashAtCaret, type AgentCommand, type SlashState } from "./slash-commands";
import { EditorTabs } from "./editor-tabs";
import { Tip } from "./components/icon-tip";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { TableGeneratorDialog } from "./table-generator-dialog";
import { ProjectFindDialog, type ProjectFindHit } from "./project-find-dialog";
import { ProjectReplaceDialog, type ReplacePreviewResult } from "./project-replace-dialog";
import type { PdfMark } from "./pdf-annotations";
import { LiteratureDiscoveryPanel, baseArxivId } from "./literature-discovery-panel";
import { PdfPreview, type PdfSyncTarget } from "./pdf-viewer";
import { findAppendixMarker } from "./appendix-pages";
import { ManuscriptChecklistPanel } from "./manuscript-checklist";
import { mergeTodosWithBuffer, type TodoHit } from "./todo-scavenger";
import { TodoScavengerPanel } from "./todo-scavenger-panel";
import { referenceAssetPreviewDataUrl, type ReferenceAssetPreview } from "./reference-preview";
import { ThinkingOrb, type OrbState } from "./thinking-orbs";
import {
  DEFAULT_EDITOR_FONT,
  DEFAULT_UI_FONT,
  EDITOR_FONT_OPTIONS,
  UI_FONT_OPTIONS,
  availableFontOptions,
  resolveFontValue,
} from "./available-fonts";
import "./App.css";

type RootDocument = {
  path: string;
  name: string;
  isDefault: boolean;
};

type ProjectVenue = "neurips" | "icml" | "iclr";

type ProjectManifest = {
  schemaVersion: number;
  projectId: string;
  name: string;
  rootDocuments: RootDocument[];
  primaryBibliography: string;
  trusted: boolean;
  engine?: string;
  venue?: ProjectVenue | string;
  wordBudget?: number | null;
  pageBudget?: number | null;
};

type WordCount = {
  text: number;
  headers: number;
  captions: number;
  total: number;
  source: string;
};

type AgentToolStep = {
  id: string;
  name: string;
  detail: string;
  phase: "start" | "end";
};

type UnusedSymbols = {
  labels: string[];
  citations: string[];
};

type ReplaceResult = {
  filesChanged: string[];
  replacements: number;
};

type EditorViewState = {
  cursor: number;
  scrollTop: number;
};

type NavigationEntry = {
  path: string;
  line: number;
};

type FileNode = {
  name: string;
  path: string;
  kind: string;
  children: FileNode[];
};

type ProjectSnapshot = {
  root: string;
  manifest: ProjectManifest;
  files: FileNode[];
};

type AssetPreview = ReferenceAssetPreview;

type FigureDropRequest = {
  id: string;
  paths: string[];
  clientX: number;
  clientY: number;
};

type FigurePointerDrag = {
  path: string;
  label: string;
  clientX: number;
  clientY: number;
  overEditor: boolean;
};

type SyncTexTarget = {
  path: string;
  line: number;
};

type EditorNavigation = SyncTexTarget & { id: string };
type EditorPosition = { path: string; line: number; column: number };
type PdfSyncResponse = Omit<PdfSyncTarget, "id">;

type ProjectSearchResult = {
  kind: "file" | "paper";
  path: string;
  title: string;
  snippet: string;
  line?: number | null;
  arxivId?: string;
  fileKind?: string;
};

type BuildResult = {
  success: boolean;
  pdfBase64?: string;
  log: string;
  durationMs: number;
  diagnostics: CompileDiagnostic[];
};

type AgentResult = {
  summary: string;
  changedFiles: string[];
  transactionId?: string;
  skillsUsed: string[];
};

type AgentStreamEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string }
  | { type: "cancellable"; enabled: boolean }
  | { type: "tool"; name: string; detail: string; phase: string };

type PaperSummary = {
  arxivId: string;
  title: string;
  citationKey?: string;
  /** False for works that are only cited — there is nothing to open. */
  hasFullText: boolean;
};

/** What the second line of a paper row says: where it came from, and its state. */
function paperSubtitle(paper: PaperSummary, snippet?: string): string {
  if (snippet) return snippet;
  const parts: string[] = [];
  // Just the key: the \cite{} wrapper is noise in a list that is entirely
  // citations, and it crowds out the arXiv id in a narrow panel.
  if (paper.citationKey) parts.push(paper.citationKey);
  if (paper.arxivId) parts.push(`arXiv ${paper.arxivId}`);
  if (!paper.hasFullText) {
    // Say why it cannot be opened, and whether that is fixable from here.
    parts.push(paper.arxivId ? "get full text" : "cited only");
  }
  return parts.join(" · ");
}

/** A cited-only work may have no arXiv id, so identity falls back to its key. */
function paperKey(paper: PaperSummary): string {
  return paper.arxivId || `cite:${paper.citationKey ?? paper.title}`;
}

type RenameTarget =
  | { kind: "entry"; path: string; name: string }
  | { kind: "paper"; paper: PaperSummary }
  | { kind: "label"; label: string }
  | { kind: "citation"; key: string }
  | { kind: "environment"; name: string }
  | { kind: "wrap-environment" };

type RenameSymbolResult = {
  changedFiles: string[];
  occurrenceCount: number;
  transactionId: string;
};

/** One chronological slice of an agent turn: something it said, or something it did. */
type ChatPart =
  | { kind: "text"; text: string }
  | ({ kind: "tool" } & AgentToolStep);

type ChatMessage = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  files?: string[];
  skills?: string[];
  /** Absent on user/system turns; the bubble falls back to `text` then. */
  parts?: ChatPart[];
};

type AgentSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: AgentProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  messages: ChatMessage[];
};

type AgentSessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  provider: AgentProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  messageCount: number;
};

type AgentSessionSearchResult = AgentSessionSummary & { snippet: string };
type AgentSkill = {
  name: string;
  description: string;
  scope: "built-in" | "application" | "project";
  enabled: boolean;
  editable: boolean;
  overridden: boolean;
  content: string;
};
type SkillDraft = { originalName?: string; scope: "application" | "project"; content: string };
type AgentMention = { key: string; label: string; path: string; kind: "file" | "paper" };
type MentionState = { start: number; end: number; query: string };

type CanvasMode = "source" | "pdf" | "split" | "dual" | "columns" | "paper" | "asset";
type EditorPaneId = "primary" | "secondary";
type DocumentViewMode = "source" | "split" | "pdf" | "dual" | "columns";
type Theme = "light" | "dark";
type AgentProvider = "codex" | "claude" | "openai-api" | "anthropic-api";
type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
type RecentProject = { name: string; path: string };
type PanelKind = "navigator" | "agent";
type PanelWidths = { navigator: number; agent: number };
type SettingsTab = "appearance" | "editor" | "agent" | "accounts" | "api" | "doctor";
type CiteCommand = "cite" | "citep" | "citet";
type InsertSymbolCommand = CiteCommand | "ref" | "eqref";
type DoctorCheck = { name: string; detail: string; ok: boolean };
type DoctorReport = { ok: boolean; summary: string; checks: DoctorCheck[] };
type EditorKeymap = "default" | "vim" | "emacs";
const CITE_COMMANDS: CiteCommand[] = ["cite", "citep", "citet"];
type AppearanceSettings = {
  uiFont: string;
  interfaceScale: number;
  editorFont: string;
  editorFontSize: number;
  editorKeymap: EditorKeymap;
  editorSpellcheck: boolean;
  maxOpenTabs: number;
};
type AutoBuildMode = "manual" | "automatic";
type BuildPreferences = { autoBuildMode: AutoBuildMode };
type SubscriptionStatus = { provider: "codex" | "claude"; installed: boolean; loggedIn: boolean; detail: string };
type ModelOption = { value: string; label: string; efforts: ReasoningEffort[] };

const RECENT_PROJECTS_KEY = "lattice.recent-projects.v1";
const PANEL_WIDTHS_KEY = "lattice.panel-widths.v2";
const APPEARANCE_KEY = "lattice.appearance.v4";
const LEGACY_APPEARANCE_KEY = "lattice.appearance.v3";
const THEME_KEY = "lattice.theme.v1";
const BUILD_PREFERENCES_KEY = "lattice.build-preferences.v2";
const SPLIT_RATIO_KEY = "lattice.split-ratio.v1";
const COLUMNS_PDF_RATIO_KEY = "lattice.columns-pdf-ratio.v1";
const NAVIGATOR_SPLIT_KEY = "lattice.navigator-split.v1";
const AGENT_SYSTEM_PROMPT_KEY = "lattice.agent-system-prompt.v1";
const PROJECT_FIGURE_DRAG_TYPE = "application/x-lattice-project-figure";

const WELCOME_MESSAGE = "What would you like to work on?";
const defaultWelcomeMessages: ChatMessage[] = [
  {
    id: "welcome",
    role: "agent",
    text: WELCOME_MESSAGE,
  },
];

function isConversationWelcome(message: ChatMessage, index: number): boolean {
  return index === 0 && message.role === "agent" && message.text.trim() === WELCOME_MESSAGE;
}

function App() {
  const [project, setProject] = useState<ProjectSnapshot | null>(null);
  const [activeFile, setActiveFile] = useState("");
  const [source, setSource] = useState("");
  const [savedSource, setSavedSource] = useState("");
  const [secondaryFile, setSecondaryFile] = useState<string | null>(null);
  const [secondarySource, setSecondarySource] = useState("");
  const [secondarySavedSource, setSecondarySavedSource] = useState("");
  const [focusedPane, setFocusedPane] = useState<EditorPaneId>("primary");
  const [selection, setSelection] = useState("");
  const [selectionSource, setSelectionSource] = useState<"editor" | "pdf" | null>(null);
  // The editor re-reports its live selection on every update, so clearing the
  // chip isn't enough — remember the text we dismissed and ignore the editor
  // re-reporting that same text until the selection actually changes.
  const dismissedSelectionRef = useRef("");
  const [texlabDiagnostics, setTexlabDiagnostics] = useState<CompileDiagnostic[]>([]);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("split");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  /** Stable preview payload — debounced so automatic rebuilds do not thrash pdf.js. */
  const [previewPdfBase64, setPreviewPdfBase64] = useState<string | null>(null);
  const pdfFingerprintRef = useRef<string | null>(null);
  const pdfPreviewTimerRef = useRef<number | null>(null);
  const pendingPreviewPdfRef = useRef<string | null>(null);
  /** Bumped when leaving a project so a late build cannot revive a stale PDF. */
  const previewGenerationRef = useRef(0);
  const [editorPosition, setEditorPosition] = useState<EditorPosition | null>(null);
  const [pdfSyncTarget, setPdfSyncTarget] = useState<PdfSyncTarget | null>(null);
  const [locatingPdf, setLocatingPdf] = useState(false);
  const [build, setBuild] = useState<BuildResult | null>(null);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [diagnosticsDismissed, setDiagnosticsDismissed] = useState(false);
  const [building, setBuilding] = useState(false);
  const [papers, setPapers] = useState<PaperSummary[]>([]);
  const [citationKeys, setCitationKeys] = useState<string[]>([]);
  const [citations, setCitations] = useState<CitationInfo[]>([]);
  const [references, setReferences] = useState<ReferenceInfo[]>([]);
  const [unusedSymbols, setUnusedSymbols] = useState<UnusedSymbols>({ labels: [], citations: [] });
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  // Most-recently-active tab key first; drives LRU eviction over the max-tabs cap.
  const tabRecency = useRef<string[]>([]);
  const noteTabActive = useCallback((key: string) => {
    tabRecency.current = [key, ...tabRecency.current.filter((existing) => existing !== key)];
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
  // The alphaXiv overview ("blog") is the default reading view; null when the
  // paper has no report. `paperView` picks which of blog/full-text is shown.
  const [paperBlog, setPaperBlog] = useState<string | null>(null);
  const [paperView, setPaperView] = useState<"blog" | "fulltext">("blog");
  const [activeAsset, setActiveAsset] = useState<AssetPreview | null>(null);
  const [nativeEditorDropActive, setNativeEditorDropActive] = useState(false);
  const [figureDropRequest, setFigureDropRequest] = useState<FigureDropRequest | null>(null);
  const [figurePointerDrag, setFigurePointerDrag] = useState<FigurePointerDrag | null>(null);
  const suppressedFigureClick = useRef<string | null>(null);
  const [editorNavigation, setEditorNavigation] = useState<EditorNavigation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>(defaultWelcomeMessages);
  const [agentSessions, setAgentSessions] = useState<AgentSessionSummary[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [branchSource, setBranchSource] = useState<{ sessionId: string; messageId: string } | null>(null);
  const [agentInput, setAgentInput] = useState("");
  const [provider, setProvider] = useState<AgentProvider>("codex");
  const [agentModel, setAgentModel] = useState(defaultModel("codex"));
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>("high");
  const [agentRunning, setAgentRunning] = useState(false);
  const [agentStreaming, setAgentStreaming] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");
  const [agentCommands, setAgentCommands] = useState<AgentCommand[]>([]);
  const [agentStopping, setAgentStopping] = useState(false);
  const [agentCancellable, setAgentCancellable] = useState(false);
  const [projectWordCount, setProjectWordCount] = useState<WordCount | null>(null);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [mainBodyPages, setMainBodyPages] = useState<number | null>(null);
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [importInput, setImportInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [assetImporting, setAssetImporting] = useState(false);
  const [assetDropTarget, setAssetDropTarget] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
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
  const [collabOpen, setCollabOpen] = useState(false);
  const [collabMode, setCollabMode] = useState<CollabDialogMode>("start");
  const [collabHost, setCollabHost] = useState(loadCollabHost);
  const [collabRoom, setCollabRoom] = useState("");
  const [collabInvite, setCollabInvite] = useState("");
  const [collabName, setCollabName] = useState(loadCollabDisplayName);
  const [collabStatus, setCollabStatus] = useState<CollabStatus>("disconnected");
  const [collabStatusDetail, setCollabStatusDetail] = useState<string | null>(null);
  const [collabSession, setCollabSession] = useState<CollabSession | null>(null);
  // True only after the shared doc has been seeded (host) / materialized (guest).
  // The editor must not bind yCollab before this: binding early makes the guest
  // create a competing main.tex Y.Text that loses the map key to the host's copy,
  // orphaning the editor on the "Waiting for shared project files" placeholder.
  const [collabReady, setCollabReady] = useState(false);
  const [collabPeerList, setCollabPeerList] = useState<CollabPeer[]>([]);
  const collabPeers = collabPeerList.length;
  const [collabFileCount, setCollabFileCount] = useState(0);
  const [collabRole, setCollabRole] = useState<"host" | "guest">("host");
  const collabRoleRef = useRef<"host" | "guest">("host");
  const collabSessionRef = useRef<CollabSession | null>(null);
  const collabDetachRef = useRef<(() => void) | null>(null);
  const collabShareWatchRef = useRef<(() => void) | null>(null);
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
  activeFileRef.current = activeFile;
  secondaryFileRef.current = secondaryFile;
  const collabRebuildTimerRef = useRef<number | null>(null);
  const scheduleCollabRebuild = useCallback(() => {
    // Shared inputs (figures, \input'd sections, .sty/.bib) can arrive just after
    // the join's first compile, so that compile fails on not-yet-present files.
    // Coalesce late arrivals into a single rebuild so the guest's PDF heals on its
    // own instead of needing a manual Build.
    if (collabRebuildTimerRef.current) window.clearTimeout(collabRebuildTimerRef.current);
    collabRebuildTimerRef.current = window.setTimeout(() => {
      collabRebuildTimerRef.current = null;
      void compileRef.current();
    }, 1_500);
  }, []);
  useEffect(() => {
    // Asked once: the list is a property of the bundled OMP build, not of the
    // project or session. Failing leaves the menu empty rather than nagging.
    void invoke<AgentCommand[]>("list_agent_commands")
      .then(setAgentCommands)
      .catch(() => setAgentCommands([]));
  }, []);

  collabSessionRef.current = collabSession;
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
  const [navigatorOpen, setNavigatorOpen] = useState(true);
  const [agentOpen, setAgentOpen] = useState(true);
  const [panelWidths, setPanelWidths] = useState<PanelWidths>(loadPanelWidths);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("appearance");
  const [appearance, setAppearance] = useState<AppearanceSettings>(loadAppearance);
  const [buildPreferences, setBuildPreferences] = useState<BuildPreferences>(loadBuildPreferences);
  const [systemPrompt, setSystemPrompt] = useState(loadSystemPrompt);
  const [agentSkills, setAgentSkills] = useState<AgentSkill[]>([]);
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [subscriptions, setSubscriptions] = useState<SubscriptionStatus[]>([]);
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(false);
  const [subscriptionNotice, setSubscriptionNotice] = useState("");
  const [apiProvider, setApiProvider] = useState<"openai" | "anthropic">("openai");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyStatus, setApiKeyStatus] = useState<Record<string, boolean>>({});
  const saveTimer = useRef<number | null>(null);
  const automaticBuildPending = useRef(false);
  const buildingRef = useRef(false);
  const buildQueued = useRef(false);
  const chatEnd = useRef<HTMLDivElement | null>(null);
  const runningAgentSession = useRef<string | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const agentMentions = useMemo(
    () => buildAgentMentions(project?.files ?? [], papers),
    [papers, project?.files],
  );

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

  const refreshProject = useCallback(async () => {
    const snapshot = await invoke<ProjectSnapshot>("refresh_project");
    setProject(snapshot);
    const [nextPapers, nextCitationKeys, nextCitations, nextReferences] = await Promise.all([
      invoke<PaperSummary[]>("list_papers"),
      invoke<string[]>("list_citation_keys"),
      invoke<CitationInfo[]>("list_citations"),
      invoke<ReferenceInfo[]>("list_references"),
    ]);
    setPapers(nextPapers);
    setCitationKeys(nextCitationKeys);
    setCitations(nextCitations);
    setReferences(nextReferences ?? []);
    await refreshUnusedSymbols();
    return snapshot;
  }, [refreshUnusedSymbols]);

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

  const loadFile = useCallback(async (path: string) => {
    try {
      const content = await invoke<string>("read_project_file", { path });
      setActiveFile(path);
      setOpenTabs((tabs) => (tabs.includes(path) ? tabs : [...tabs, path]));
      setSource(content);
      setSavedSource(content);
      setActivePaper(null);
      setActiveAsset(null);
      setPaperMarkdown("");
      setCanvasMode((mode) => (mode === "paper" || mode === "asset" ? "split" : mode));
      setError(null);
      await markDiskMtime(path);
      const saved = viewStateRef.current.get(path);
      if (saved) {
        setViewRestore({ path, cursor: saved.cursor, scrollTop: saved.scrollTop, id: crypto.randomUUID() });
      }
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [markDiskMtime]);

  const clearCollabLocalState = useCallback(() => {
    collabInitializedRef.current = false;
    setCollabReady(false);
    collabShareWatchRef.current?.();
    collabShareWatchRef.current = null;
    collabDetachRef.current?.();
    collabDetachRef.current = null;
    const session = collabSessionRef.current;
    if (session) session.destroy();
    collabSessionRef.current = null;
    setCollabSession(null);
    setCollabStatus("disconnected");
    setCollabStatusDetail(null);
    setCollabPeerList([]);
    setCollabFileCount(0);
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
      await enterProjectRef.current?.(
        await invoke<ProjectSnapshot>("open_project", { path: prior }),
        { skipCollabLifecycle: true },
      );
      setNotice("Returned to your previous project");
    } catch {
      setNotice("Share ended. Open one of your projects from the menu.");
    } finally {
      setBusyLabel(null);
    }
  }, [recentProjects]);

  const endHostShareSession = useCallback(async (noticeText: string) => {
    if (collabLeavingRef.current) return;
    collabLeavingRef.current = true;
    try {
      const session = collabSessionRef.current;
      if (session && collabRoleRef.current === "host") {
        endCollabShare(session.doc);
        // Flush the end signal to peers before tearing down the socket.
        await new Promise((resolve) => window.setTimeout(resolve, 280));
      }
      clearCollabLocalState();
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
  }, [clearCollabLocalState, refreshProject]);

  const leaveGuestShareSession = useCallback(async (noticeText: string, restorePrior: boolean) => {
    if (collabLeavingRef.current) return;
    collabLeavingRef.current = true;
    try {
      clearCollabLocalState();
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
      await endHostShareSession("Sharing stopped — you switched projects");
      return;
    }
    // Guest opened a different project: leave quietly; host keeps sharing.
    await leaveGuestShareSession("Left the shared session", false);
  }, [endHostShareSession, leaveGuestShareSession]);

  const connectCollab = useCallback((
    hostRaw: string,
    roomRaw: string,
    noticeText: string,
    role: "host" | "guest",
  ) => {
    // Host shares the currently open project. Guests join into a fresh
    // Documents/Lattice Shares workspace created before connect.
    if (role === "host" && !project) {
      setError("Open a project before starting live collaboration.");
      return;
    }
    const room = roomRaw.trim();
    if (!room) {
      setError("A share room is required.");
      return;
    }
    const host = resolveCollabHost(hostRaw);
    saveCollabHost(host);
    saveCollabDisplayName(collabName.trim());
    setCollabHost(host);
    setCollabRoom(room);
    collabRoleRef.current = role;
    setCollabRole(role);
    // Fresh session: the next "sync" is a first sync, not a reconnect.
    collabInitializedRef.current = false;
    setCollabReady(false);
    collabShareWatchRef.current?.();
    collabShareWatchRef.current = null;
    collabDetachRef.current?.();
    collabDetachRef.current = null;
    collabSession?.destroy();
    try {
      const session = createCollabSession({
        host,
        room,
        displayName: collabName,
        // Guests just entered a blank Shares workspace; React state may still
        // hold the previous project's activeFile until the next render.
        activePath: role === "guest" ? "main.tex" : (activeFile || "main.tex"),
        onStatus: (status, detail) => {
          setCollabStatus(status);
          setCollabStatusDetail(detail ?? null);
          if (status === "error" && detail) setError(detail);
        },
        onActiveText: (path, text) => {
          // Active file is live-bound by yCollab; setSource here re-renders React
          // on every remote keystroke and makes carets/edits feel seconds late.
          if (path === activeFileRef.current) {
            setSavedSource(text);
          } else if (path === secondaryFileRef.current) {
            setSecondarySource(text);
            setSecondarySavedSource(text);
          }
        },
        onSynced: async (live) => {
          const roleNow = collabRoleRef.current;
          // Seed (host) / materialize (guest) exactly once per session. On a
          // reconnect the doc already has project data, so without this guard a
          // host would fall into the guest branch and clobber its own tab, and a
          // guest would be yanked back to the root doc on every blip.
          if (!collabInitializedRef.current) {
          if (roleNow === "host" && !collabDocHasProject(live.doc)) {
            if (!project) {
              throw new Error("Open a project before starting live collaboration.");
            }
            const seeded = await seedCollabDocFromProject(live.doc, {
              files: project.files,
              manifest: project.manifest,
              papers,
            });
            const openPath = activeFileRef.current || "main.tex";
            // Seed uses COLLAB_LOCAL_ORIGIN so the active observer skips UI updates —
            // bind + pull the seeded text back into the editor explicitly.
            live.setActivePath(openPath);
            const text = collabTextsMap(live.doc).get(openPath)?.toString();
            if (text != null && text.length > 0) {
              setSource(text);
              setSavedSource(text);
            }
            setCollabFileCount(live.fileCount());
            const skip = seeded.skippedBlobs.length
              ? ` · skipped ${seeded.skippedBlobs.length} large figure(s)`
              : "";
            setNotice(`Sharing project · ${seeded.textCount + seeded.blobCount} files${skip}`);
          } else {
            // Guest/rejoin: wait for the host to publish project meta, then
            // materialize into the current Shares workspace only.
            if (roleNow === "guest" && !collabDocHasProject(live.doc)) {
              setCollabStatus("connecting");
              setCollabStatusDetail("Waiting for host to Start sharing…");
              setNotice("Waiting for the host to Start sharing…");
              await waitForCollabProject(live.doc);
              setCollabStatusDetail(null);
            }
            const applied = await materializeCollabDocToProject(live.doc);
            const snapshot = await refreshProject();
            const openPath = applied.rootDocument
              || activeFileRef.current
              || snapshot.manifest.rootDocuments.find((document) => document.path === "main.tex")?.path
              || snapshot.manifest.rootDocuments.find((document) => document.isDefault)?.path
              || snapshot.manifest.rootDocuments[0]?.path
              || "main.tex";
            live.setActivePath(openPath);
            await loadFile(openPath);
            try {
              setEditorComments(await invoke<EditorComment[]>("list_editor_comments"));
            } catch {
              setEditorComments([]);
            }
            setCollabFileCount(live.fileCount());
            const skipped = applied.skippedBlobs.length
              ? ` · ${applied.skippedBlobs.length} figure(s) too large to sync`
              : "";
            setNotice(
              roleNow === "guest"
                ? `Joined shared workspace · ${applied.textCount + applied.blobCount} files${skipped}`
                : `Rejoined share · ${applied.textCount + applied.blobCount} files${skipped}`,
            );
            // The shared sources, figures, and .sty are now all on disk. Build
            // once so the guest sees the real PDF instead of the deferred empty
            // scaffold (previously this required a manual recompile after join).
            void compileRef.current();
          }
          collabInitializedRef.current = true;
          }
          // Shared doc is seeded/materialized: the real Y.Texts now exist, so it is
          // safe to bind the editor to them without racing the initial sync.
          setCollabReady(true);

          collabDetachRef.current?.();
          collabDetachRef.current = attachCollabProjectObservers(live.doc, {
            onRemoteText: (path, content) => {
              // Apply comments immediately from the Y payload — don't wait on disk I/O.
              if (path === COLLAB_EDITOR_COMMENTS_PATH) {
                const parsed = tryParseEditorComments(content);
                // A corrupt payload (two peers rewrote the whole JSON at once and
                // the CRDT merged them into invalid text) must not wipe or persist
                // over everyone's comments. Keep the last good state on disk and in
                // memory; the next comment edit heals the shared doc.
                if (!parsed) return;
                setEditorComments(parsed);
                void invoke("write_project_file", { path, content })
                  .catch((reason) => setError(toMessage(reason)));
                return;
              }
              void invoke("write_project_file", { path, content }).then(async () => {
                // Active path is bound through yCollab — only keep savedSource in sync.
                if (path === activeFileRef.current) {
                  setSavedSource(content);
                } else if (path === secondaryFileRef.current) {
                  setSecondarySource(content);
                  setSecondarySavedSource(content);
                }
                if (path.startsWith(".research/papers/") || path.endsWith(".bib")) {
                  await refreshProject();
                }
                // A changed shared input that isn't the buffer you're editing won't
                // trip the editor's own autobuild — rebuild so the PDF reflects it
                // (and so the join's first compile heals once late files arrive).
                if (path !== activeFileRef.current && path !== secondaryFileRef.current) {
                  scheduleCollabRebuild();
                }
              }).catch((reason) => setError(toMessage(reason)));
            },
            onRemoteBlob: (path, _mime, base64) => {
              void invoke("write_project_bytes", { path, base64Data: base64 })
                .then(() => refreshProject())
                .then(() => scheduleCollabRebuild())
                .catch((reason) => setError(toMessage(reason)));
            },
            onRemoteDelete: (path) => {
              void invoke("delete_project_entry", { path })
                .then(() => refreshProject())
                .catch(() => { /* path may already be gone */ });
            },
          });

          // Guests leave when the host ends the share (or switches projects).
          collabShareWatchRef.current?.();
          collabShareWatchRef.current = null;
          if (roleNow === "guest") {
            collabShareWatchRef.current = observeCollabShareEnded(live.doc, () => {
              void leaveGuestShareSession(
                "Host stopped sharing — returned to your project",
                true,
              );
            });
          }
          setCollabFileCount(live.fileCount());
        },
        onPeers: setCollabPeerList,
      });
      setCollabSession(session);
      setNotice(noticeText);
    } catch (reason) {
      setCollabStatus("error");
      setCollabStatusDetail(toMessage(reason));
      setError(toMessage(reason));
    }
  }, [
    activeFile,
    collabName,
    collabSession,
    leaveGuestShareSession,
    loadFile,
    papers,
    project,
    refreshProject,
  ]);

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
    const room = createShareRoomCode();
    const host = resolveCollabHost(collabHost);
    setCollabRoom(room);
    connectCollab(host, room, `Starting project share ${room}…`, "host");
    void writeText(formatCollabInviteMessage(host, room))
      .then(() => setNotice(`Started share ${room} · invite copied`))
      .catch(() => setNotice(`Started share ${room}`));
  }, [collabHost, collabName, connectCollab, project]);

  const copyCollabInvite = useCallback(async () => {
    const host = collabSession?.host ?? resolveCollabHost(collabHost);
    const room = collabSession?.room ?? collabRoom;
    if (!room) return;
    await writeText(formatCollabInviteMessage(host, room));
    setNotice("Invite copied");
  }, [collabHost, collabRoom, collabSession]);

  const openCollabDialog = useCallback((mode: CollabDialogMode = "start") => {
    setCollabMode(mode);
    setCollabHost(resolveCollabHost(collabHost));
    setCollabOpen(true);
  }, [collabHost]);

  useEffect(() => {
    if (!collabSession) return;
    return () => {
      collabShareWatchRef.current?.();
      collabShareWatchRef.current = null;
      collabDetachRef.current?.();
      collabDetachRef.current = null;
      collabSession.destroy();
    };
  }, [collabSession]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!project) return true;
    try {
      let wroteTex = false;
      let wroteBib = false;
      if (activeFile && source !== savedSource) {
        await invoke("write_project_file", { path: activeFile, content: source });
        // Do NOT push the active buffer into Yjs here. It is already synced
        // character-by-character by yCollab. Re-publishing it as a full
        // delete+insert of the whole Y.Text on every autosave collapses remote
        // carets and bounces recompiles between peers (the "cursors freeze /
        // PDF re-renders forever" bug). The disk write + savedSource are all the
        // active file needs; non-active buffers below still push explicitly.
        setSavedSource(source);
        await markDiskMtime(activeFile);
        wroteTex = wroteTex || activeFile.endsWith(".tex");
        wroteBib = wroteBib || activeFile === project.manifest.primaryBibliography;
      }
      if (secondaryFile && secondarySource !== secondarySavedSource) {
        await invoke("write_project_file", { path: secondaryFile, content: secondarySource });
        if (collabSession) pushLocalTextToCollab(collabSession.doc, secondaryFile, secondarySource);
        setSecondarySavedSource(secondarySource);
        wroteTex = wroteTex || secondaryFile.endsWith(".tex");
        wroteBib = wroteBib || secondaryFile === project.manifest.primaryBibliography;
      }
      if (!wroteTex && !wroteBib && source === savedSource && secondarySource === secondarySavedSource) {
        return true;
      }
      if (wroteBib) {
        const [nextCitationKeys, nextCitations] = await Promise.all([
          invoke<string[]>("list_citation_keys"),
          invoke<CitationInfo[]>("list_citations"),
        ]);
        setCitationKeys(nextCitationKeys);
        setCitations(nextCitations);
      }
      if (wroteTex) {
        setReferences((await invoke<ReferenceInfo[]>("list_references")) ?? []);
      }
      await refreshUnusedSymbols();
      await refreshHistory();
      await refreshTodos();
      await refreshWordCount();
      return true;
    } catch (reason) {
      setError(toMessage(reason));
      return false;
    }
  }, [
    activeFile,
    collabSession,
    markDiskMtime,
    project,
    refreshHistory,
    refreshTodos,
    refreshUnusedSymbols,
    refreshWordCount,
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
                setSource(content);
                setSavedSource(content);
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
            setSecondarySource(content);
            setSecondarySavedSource(content);
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
  }, [activeAsset, activeFile, activePaper, project, secondaryFile]);

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

  const openProjectFile = useCallback(async (path: string, line?: number) => {
    const keepDocumentMode = (mode: CanvasMode): CanvasMode => (
      mode === "pdf" || mode === "paper" || mode === "asset" ? "split" : mode
    );
    const secondaryFocused = (canvasMode === "dual" || canvasMode === "columns")
      && focusedPane === "secondary"
      && !activePaper
      && !activeAsset;
    if (secondaryFocused) {
      if (path === secondaryFile) {
        if (line) {
          setEditorNavigation({ path, line, id: crypto.randomUUID() });
          pushNavigation(path, line);
        }
        return;
      }
      if (secondaryFile && secondarySource !== secondarySavedSource) {
        try {
          await invoke("write_project_file", { path: secondaryFile, content: secondarySource });
          if (collabSession) pushLocalTextToCollab(collabSession.doc, secondaryFile, secondarySource);
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
    if (source !== savedSource || (secondaryFile && secondarySource !== secondarySavedSource)) {
      const saved = await save();
      if (!saved) return;
    }
    await loadFile(path);
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
    activeFile,
    activePaper,
    canvasMode,
    collabSession,
    focusedPane,
    loadFile,
    pushNavigation,
    save,
    savedSource,
    secondaryFile,
    secondarySavedSource,
    secondarySource,
    source,
  ]);

  /** Jump to where a collaborator is working, following them into their file. */
  const followCollabPeer = useCallback(async (peer: CollabPeer) => {
    const session = collabSessionRef.current;
    const location = session ? peerCursorLocation(session, peer.clientId) : null;
    // Their caret is the precise answer; the file they announced is the fallback
    // for a peer who has not placed a cursor yet.
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
    setOpenTabs(remaining);
    tabRecency.current = tabRecency.current.filter((key) => key !== path);
    viewStateRef.current.delete(path);
    closedTabsRef.current = [path, ...closedTabsRef.current.filter((item) => item !== path)].slice(0, 20);
    // The most recent still-open text file to fall back to (papers can't load
    // into the editor).
    const fileFallback = [...remaining].reverse().find((key) => !isPaperTabKey(key));
    if (isPaperTabKey(path)) {
      // Only the paper currently on screen needs the canvas returned to the editor.
      if (canvasMode === "paper" && activePaper && paperTabKey(activePaper.arxivId) === path) {
        setActivePaper(null);
        setPaperMarkdown("");
        setPaperBlog(null);
        if (fileFallback) await openProjectFile(fileFallback);
        else setCanvasMode((mode) => (mode === "paper" ? "split" : mode));
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
  }, [activeFile, activePaper, canvasMode, openTabs, openProjectFile, secondaryFile]);

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
        mode === "pdf" || mode === "paper" || mode === "asset"
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
    const previewGeneration = previewGenerationRef.current;
    try {
      do {
        buildQueued.current = false;
        const result = await invoke<BuildResult>("build_project", { force });
        setBuild(result);
        setDiagnosticsDismissed(false);
        setDiagnosticsExpanded(!result.success || result.diagnostics.some((item) => item.level === "error"));
        if (result.pdfBase64) {
          // LaTeX rewrites PDF metadata on every compile, so bytes almost always
          // change. Debounce preview updates for autosave compiles so pdf.js is
          // not destroyed mid-load on every keystroke pause.
          pendingPreviewPdfRef.current = result.pdfBase64;
          if (pdfPreviewTimerRef.current) window.clearTimeout(pdfPreviewTimerRef.current);
          const applyPreview = () => {
            pdfPreviewTimerRef.current = null;
            if (previewGeneration !== previewGenerationRef.current) return;
            const base64 = pendingPreviewPdfRef.current;
            if (!base64) return;
            const fingerprint = pdfBase64Fingerprint(base64);
            if (fingerprint === pdfFingerprintRef.current) return;
            pdfFingerprintRef.current = fingerprint;
            const nextUrl = pdfBase64ToObjectUrl(base64);
            setPreviewPdfBase64(base64);
            setPdfUrl((previous) => {
              if (previous) URL.revokeObjectURL(previous);
              return nextUrl;
            });
          };
          // Autosave compiles settle longer than typing pauses so a slow first
          // pdf.js load is not cancelled by the next rebuild.
          if (immediatePreview) applyPreview();
          else pdfPreviewTimerRef.current = window.setTimeout(applyPreview, 2_800);
        }
        if (!result.success) {
          const firstError = result.diagnostics.find((item) => item.level === "error")
            ?? result.diagnostics[0]
            ?? null;
          if (firstError) void openCompileDiagnosticRef.current(firstError);
          if (!result.diagnostics.length) setError("LaTeX compilation failed.");
          else setError(null);
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
      const message = toMessage(reason);
      setError(message);
      if (isMissingTexBuildError(message)) setTexSetupOpen(true);
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
    if (!window.confirm("Delete LaTeX auxiliary files (`.aux`, `.log`, `.bbl`, …) from this project?")) return;
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
    if (!window.confirm("Delete auxiliary files and rebuild the PDF?")) return;
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
    setLocatingPdf(true);
    try {
      if (!(await save())) return;
      if (source !== savedSource || !pdfUrl) await runBuild();
      const target = await invoke<PdfSyncResponse>("synctex_view", {
        path: editorPosition.path,
        line: editorPosition.line,
        column: editorPosition.column,
      });
      setPdfSyncTarget({ ...target, id: crypto.randomUUID() });
      setCanvasMode((mode) => {
        if (mode === "dual") return "columns";
        if (mode === "source") return "split";
        return mode;
      });
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setLocatingPdf(false);
    }
  }, [editorPosition, locatingPdf, pdfUrl, runBuild, save, savedSource, source]);

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
      if (!options?.skipCollabLifecycle) {
        await settleCollabBeforeProjectSwitch(snapshot.root);
      }
      setProject(snapshot);
      rememberProject(snapshot);
      setProjectMenuOpen(false);
      setBuild(null);
      setSelection("");
      setSelectionSource(null);
      setTexlabDiagnostics([]);
      setEditorComments([]);
      setEditorCommentsOpen(false);
      setActiveEditorCommentId(null);
      setDiskTodos([]);
      setTodosOpen(false);
      setActivePaper(null);
      setActiveAsset(null);
      setPaperMarkdown("");
      setCanvasMode("split");
      // Invalidate any in-flight preview from the previous project, then clear
      // UI state *before* starting the first build (starting first used to race
      // applyPreview and wipe a just-loaded PDF → endless “Rendering PDF…”).
      previewGenerationRef.current += 1;
      pdfFingerprintRef.current = null;
      pendingPreviewPdfRef.current = null;
      if (pdfPreviewTimerRef.current) {
        window.clearTimeout(pdfPreviewTimerRef.current);
        pdfPreviewTimerRef.current = null;
      }
      setPreviewPdfBase64(null);
      setPdfUrl((previous) => {
        if (previous) URL.revokeObjectURL(previous);
        return null;
      });
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
      if (rootDocument) await loadFile(rootDocument.path);
      const [nextPapers, nextCitationKeys, nextCitations, nextReferences] = await Promise.all([
        invoke<PaperSummary[]>("list_papers"),
        invoke<string[]>("list_citation_keys"),
        invoke<CitationInfo[]>("list_citations"),
        invoke<ReferenceInfo[]>("list_references"),
      ]);
      setPapers(nextPapers);
      setCitationKeys(nextCitationKeys);
      setCitations(nextCitations);
      setReferences(nextReferences ?? []);
      setOpenTabs(rootDocument ? [rootDocument.path] : []);
      tabRecency.current = rootDocument ? [rootDocument.path] : [];
      setNavStack(rootDocument ? [{ path: rootDocument.path, line: 1 }] : []);
      setNavIndex(rootDocument ? 0 : -1);
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
      let sessionList = await invoke<AgentSessionSummary[]>("list_agent_sessions");
      const session = sessionList.length
        ? await invoke<AgentSession>("read_agent_session", { sessionId: sessionList[0].id })
        : await invoke<AgentSession>("create_agent_session", {
          provider: "codex",
          model: defaultModel("codex"),
          reasoningEffort: "high",
        });
      if (!sessionList.length) sessionList = await invoke<AgentSessionSummary[]>("list_agent_sessions");
      setAgentSessions(sessionList);
      setActiveSession(session);
      setMessages(session.messages);
      setBranchSource(null);
      setProvider(session.provider);
      setAgentModel(normalizeModel(session.provider, session.model));
      setReasoningEffort(normalizeEffort(session.reasoningEffort));
      setSessionMenuOpen(false);
      // Never animate shell opacity from 0 — a cancelled/interrupted tween leaves the
      // whole window blank white with the UI still "mounted".
      if (shellRef.current) shellRef.current.style.opacity = "1";
    },
    [loadFile, refreshUnusedSymbols, rememberProject, runBuild, settleCollabBeforeProjectSwitch],
  );
  enterProjectRef.current = enterProject;

  const joinCollabShare = useCallback(() => {
    if (!collabName.trim()) {
      setError("Enter your name before joining a share.");
      setCollabOpen(true);
      return;
    }
    const parsed = parseCollabInvite(collabInvite) ?? parseCollabInvite(collabRoom);
    if (!parsed?.room) {
      setError("Paste the full invite from Copy invite (lattice:host/LT-XXXXXX).");
      return;
    }
    if (!/lattice:\S+\//i.test(collabInvite) && !/lattice:\S+\//i.test(collabRoom)) {
      setError("Paste the full invite from Copy invite (lattice:host/LT-XXXXXX), not just the room code.");
      return;
    }
    const host = resolveCollabHost(parsed.host || collabHost);
    setCollabHost(host);
    setCollabRoom(parsed.room);
    void (async () => {
      setBusyLabel("Opening a shared workspace…");
      try {
        // Remember where the guest came from *before* any await / workspace switch.
        const priorRoot = project?.root ?? null;
        preCollabProjectRootRef.current = priorRoot;
        rememberPreCollabProjectRoot(priorRoot);
        // Save the project the user already had open, then switch into a fresh
        // Lattice Shares folder. Their previous folder is left untouched.
        if (project && (source !== savedSource
          || (secondaryFile && secondarySource !== secondarySavedSource))) {
          if (!(await save())) return;
        }
        const snapshot = await invoke<ProjectSnapshot>("create_collab_join_workspace", {
          room: parsed.room,
        });
        // Guest is entering a new workspace on purpose — do not treat as leave/end.
        // Defer the build: the workspace is an empty scaffold until the shared
        // sources sync, so connectCollab → onSynced compiles once it is populated.
        await enterProject(snapshot, { skipCollabLifecycle: true, deferInitialBuild: true });
        connectCollab(host, parsed.room, `Joining project share ${parsed.room}…`, "guest");
        setNotice(`Opened shared workspace · ${snapshot.root}`);
      } catch (reason) {
        setError(toMessage(reason));
      } finally {
        setBusyLabel(null);
      }
    })();
  }, [
    collabHost,
    collabName,
    collabInvite,
    collabRoom,
    connectCollab,
    enterProject,
    project,
    save,
    savedSource,
    secondaryFile,
    secondarySavedSource,
    secondarySource,
    source,
  ]);

  const chooseExisting = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false, title: "Open a LaTeX project" });
    if (!selected) return;
    setBusyLabel("Opening project…");
    try {
      if (!(await save())) return;
      await enterProject(await invoke<ProjectSnapshot>("open_project", { path: selected }));
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [enterProject, save]);

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
      const snapshot = await invoke<ProjectSnapshot>("create_project", {
        parent,
        name: projectName,
        venue: projectVenue,
      });
      setCreateError(null);
      setCreateOpen(false);
      await enterProject(snapshot);
    } catch (reason) {
      setCreateError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [enterProject, projectName, projectVenue, save]);

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
      await enterProject(await invoke<ProjectSnapshot>("import_project_zip", {
        zipPath,
        parent,
      }));
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [enterProject, save]);

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
      await enterProject(await invoke<ProjectSnapshot>("open_project", { path }));
    } catch (reason) {
      setRecentProjects((items) => {
        const next = items.filter((item) => item.path !== path);
        persistRecentProjects(next);
        return next;
      });
      setError(toMessage(reason));
    } finally {
      setBusyLabel(null);
    }
  }, [enterProject, project?.root, save]);

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
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // Theme changes still apply for the current session without storage.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-font", appearance.uiFont);
    document.documentElement.style.setProperty("--editor-font", appearance.editorFont);
    document.documentElement.style.setProperty("--editor-font-size", `${appearance.editorFontSize}px`);
    try {
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
    } catch {
      // Appearance changes still apply for the current session without storage.
    }
  }, [appearance]);

  useEffect(() => {
    void import("@tauri-apps/api/webview")
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(appearance.interfaceScale))
      .catch(() => {
        // Browser-based tests and previews do not expose native webview zoom.
      });
  }, [appearance.interfaceScale]);

  // Measure the sidebar toggle and tell AppKit to center traffic lights on it.
  // No OS-specific nudges — host and VM share the same geometry once zoom is applied.
  useEffect(() => {
    let cancelled = false;
    const align = () => {
      if (cancelled || isFullscreen) return;
      const titlebar = shellRef.current?.querySelector<HTMLElement>(".titlebar");
      const toggle = shellRef.current?.querySelector<HTMLElement>(".titlebar-navigator > .icon-button");
      if (!titlebar || !toggle) return;
      const titlebarRect = titlebar.getBoundingClientRect();
      const toggleRect = toggle.getBoundingClientRect();
      // WKWebView zoom leaves getBoundingClientRect in CSS pixels; native chrome uses points.
      const zoom = appearance.interfaceScale;
      const centerY = (toggleRect.top + toggleRect.height / 2) * zoom;
      const titlebarHeight = titlebarRect.height * zoom;
      void invoke("align_traffic_lights", { centerY, titlebarHeight }).catch(() => {
        // Browser tests / non-macOS builds have no traffic lights.
      });
    };
    const frame = window.requestAnimationFrame(align);
    const timer = window.setTimeout(align, 120);
    window.addEventListener("resize", align);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      window.removeEventListener("resize", align);
    };
  }, [appearance.interfaceScale, isFullscreen, project]);

  useEffect(() => {
    try {
      localStorage.setItem(BUILD_PREFERENCES_KEY, JSON.stringify(buildPreferences));
    } catch {
      // Build preferences still apply for the current session without storage.
    }
  }, [buildPreferences]);

  useEffect(() => {
    try {
      localStorage.setItem(AGENT_SYSTEM_PROMPT_KEY, systemPrompt);
    } catch {
      // The prompt still applies for the current session without storage.
    }
  }, [systemPrompt]);

  useEffect(() => {
    const appWindow = getCurrentWindow();
    if (typeof appWindow.isFullscreen !== "function" || typeof appWindow.onResized !== "function") return;
    let active = true;
    let stopListening: (() => void) | undefined;
    const refresh = () => {
      void appWindow.isFullscreen().then((value) => active && setIsFullscreen(value));
    };
    refresh();
    void appWindow.onResized(refresh).then((unlisten) => {
      if (active) stopListening = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, agentRunning]);

  useEffect(() => {
    if (!project || !activeFile || source === savedSource) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const automatic = buildPreferences.autoBuildMode === "automatic";
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
  }, [activeFile, buildPreferences.autoBuildMode, project, savedSource, source]);

  // Dual-pane secondary buffer is not yCollab-bound; push + save while sharing.
  useEffect(() => {
    if (!project || !collabSession || !secondaryFile) return;
    if (secondarySource === secondarySavedSource) return;
    const timer = window.setTimeout(() => {
      void invoke("write_project_file", { path: secondaryFile, content: secondarySource })
        .then(() => {
          pushLocalTextToCollab(collabSession.doc, secondaryFile, secondarySource);
          setSecondarySavedSource(secondarySource);
        })
        .catch((reason) => setError(toMessage(reason)));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [collabSession, project, secondaryFile, secondarySavedSource, secondarySource]);

  const buildWhenLeavingEditor = useCallback(() => {
    if (buildPreferences.autoBuildMode !== "automatic" || source === savedSource) return;
    void saveAndCompileAutomatically();
  }, [buildPreferences.autoBuildMode, saveAndCompileAutomatically, savedSource, source]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save().then((saved) => {
          if (saved) void compile();
        });
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "o") {
        event.preventDefault();
        void chooseExisting();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [chooseExisting, compile, save]);

  const importArxivInput = useCallback(async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setImporting(true);
    try {
      const result = await invoke<{ arxivId: string; title: string; citationKey?: string; alreadyImported: boolean }>("import_arxiv", {
        input: trimmed,
      });
      const snapshot = await refreshProject();
      await refreshHistory();
      if (collabSession && !result.alreadyImported) {
        for (const path of [
          `.research/papers/${result.arxivId}/paper.md`,
          `.research/papers/${result.arxivId}/blog.md`,
          `.research/papers/${result.arxivId}/metadata.json`,
          snapshot.manifest.primaryBibliography,
        ].filter(Boolean) as string[]) {
          try {
            const content = await invoke<string>("read_project_file", { path });
            pushLocalTextToCollab(collabSession.doc, path, content);
          } catch {
            // Optional sidecar / bib may be missing.
          }
        }
        setCollabFileCount(collabSession.fileCount());
      }
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          text: result.alreadyImported
            ? `“${result.title}” is already in Papers${result.citationKey ? ` as \\cite{${result.citationKey}}` : ""}.`
            : `Imported “${result.title}”${result.citationKey ? ` as \\cite{${result.citationKey}}` : ""}.`,
        },
      ]);
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
      await importArxivInput(importInput);
      setImportInput("");
    } catch {
      // Error already surfaced by importArxivInput.
    }
  }, [importArxivInput, importInput]);

  const openPaper = useCallback(async (paper: PaperSummary) => {
    try {
      if (source !== savedSource) {
        const saved = await save();
        if (!saved) return;
      }
      // Full text and blog are independent files; fetch together so the toggle
      // is instant. read_paper_blog lazily backfills the blog when missing.
      const [fullText, blog] = await Promise.all([
        invoke<string>("read_paper", { arxivId: paper.arxivId }),
        invoke<string | null>("read_paper_blog", { arxivId: paper.arxivId }).catch(() => null),
      ]);
      setPaperMarkdown(fullText);
      setPaperBlog(blog);
      setPaperView(blog ? "blog" : "fulltext");
      setActivePaper(paper);
      setActiveAsset(null);
      setCanvasMode("paper");
      const key = paperTabKey(paper.arxivId);
      setOpenTabs((tabs) => (tabs.includes(key) ? tabs : [...tabs, key]));
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [save, savedSource, source]);

  const openProjectAsset = useCallback(async (path: string) => {
    try {
      if (source !== savedSource) {
        const saved = await save();
        if (!saved) return;
      }
      const asset = await invoke<AssetPreview>("read_project_asset", { path });
      setActiveAsset(asset);
      setActivePaper(null);
      setPaperMarkdown("");
      setCanvasMode("asset");
      setError(null);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [save, savedSource, source]);

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

  const beginProjectFigureDrag = useCallback((path: string, label: string, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    let dragging = false;
    const editorAt = (clientX: number, clientY: number) =>
      Boolean((document.elementFromPoint(clientX, clientY) as Element | null)?.closest(".source-editor"));
    const move = (pointerEvent: PointerEvent) => {
      if (!dragging && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 5) return;
      dragging = true;
      const overEditor = editorAt(pointerEvent.clientX, pointerEvent.clientY);
      setNativeEditorDropActive(overEditor);
      setFigurePointerDrag({
        path,
        label,
        clientX: pointerEvent.clientX,
        clientY: pointerEvent.clientY,
        overEditor,
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
      if (!editorAt(pointerEvent.clientX, pointerEvent.clientY)) return;
      setFigureDropRequest({
        id: crypto.randomUUID(),
        paths: [path],
        clientX: pointerEvent.clientX,
        clientY: pointerEvent.clientY,
      });
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
    setActiveAsset(null);
    setActivePaper(null);
    setPaperMarkdown("");
    if (mode === "dual" || mode === "columns") {
      void (async () => {
        try {
          await ensureSecondaryFile();
          setCanvasMode(mode);
        } catch (reason) {
          setError(toMessage(reason));
        }
      })();
      return;
    }
    setCanvasMode(mode);
  }, [ensureSecondaryFile]);

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
      const createdPath = await invoke<string>("create_project_entry", { path, kind });
      await refreshProject();
      await refreshHistory();
      if (kind === "file") {
        const content = await invoke<string>("read_project_file", { path: createdPath }).catch(() => "");
        if (collabSession) {
          pushLocalTextToCollab(collabSession.doc, createdPath, content);
          setCollabFileCount(collabSession.fileCount());
        }
        await loadFile(createdPath);
      }
    } catch (reason) {
      setError(toMessage(reason));
      throw reason;
    }
  }, [collabSession, loadFile, refreshHistory, refreshProject]);

  const importProjectAssets = useCallback(async (paths: string[], targetDirectory = "figures"): Promise<string[]> => {
    if (!paths.length || assetImporting) return [];
    setAssetImporting(true);
    try {
      const imported = await invoke<string[]>("import_project_assets", { paths, targetDirectory });
      await refreshProject();
      if (collabSession) {
        for (const path of imported) {
          try {
            await pushLocalBlobToCollab(collabSession.doc, path);
          } catch (reason) {
            setError(toMessage(reason));
          }
        }
        setCollabFileCount(collabSession.fileCount());
      }
      setMessages((items) => [
        ...items,
        {
          id: crypto.randomUUID(),
          role: "system",
          text: `Imported ${imported.length} figure${imported.length === 1 ? "" : "s"} into ${targetDirectory}.`,
          files: imported,
        },
      ]);
      setError(null);
      return imported;
    } catch (reason) {
      setError(toMessage(reason));
      return [];
    } finally {
      setAssetImporting(false);
      setAssetDropTarget(null);
    }
  }, [assetImporting, collabSession, refreshProject]);

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
          setAssetDropTarget(null);
          setNativeEditorDropActive(false);
          return;
        }
        const editorPosition = dropEditorAt(event.payload.position);
        const targetDirectory = dropDirectoryAt(event.payload.position);
        setAssetDropTarget(targetDirectory);
        setNativeEditorDropActive(Boolean(editorPosition));
        if (event.payload.type === "drop") {
          setAssetDropTarget(null);
          setNativeEditorDropActive(false);
          if (!event.payload.paths.length) return;
          if (editorPosition) {
            void importProjectAssets(event.payload.paths, "figures").then((paths) => {
              if (paths.length) {
                setFigureDropRequest({
                  id: crypto.randomUUID(),
                  paths,
                  clientX: editorPosition.x,
                  clientY: editorPosition.y,
                });
              }
            });
          } else if (targetDirectory) void importProjectAssets(event.payload.paths, targetDirectory);
          else setError("Drop image files onto a project folder or anywhere in the Project pane to add them to figures.");
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
  }, [importProjectAssets, project]);

  const prepareLatexFigure = useCallback(async (path: string): Promise<string | null> => {
    try {
      const prepared = await invoke<string>("prepare_latex_figure", { path });
      if (prepared !== path) await refreshProject();
      setError(null);
      return prepared;
    } catch (reason) {
      setError(toMessage(reason));
      return null;
    }
  }, [refreshProject]);

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
    if (!window.confirm(`Delete “${path}” from this project?`)) return;
    try {
      await invoke("delete_project_entry", { path });
      if (collabSession) {
        removeCollabPath(collabSession.doc, path);
        setCollabFileCount(collabSession.fileCount());
      }
      const snapshot = await refreshProject();
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
  }, [activeAsset, activeFile, collabSession, loadFile, refreshHistory, refreshProject]);

  const renameProjectEntry = useCallback((path: string, name: string) => {
    setRenameError(null);
    setRenameTarget({ kind: "entry", path, name });
  }, []);

  const renameImportedPaper = useCallback((paper: PaperSummary) => {
    setRenameError(null);
    setRenameTarget({ kind: "paper", paper });
  }, []);

  const submitRename = useCallback(async (name: string) => {
    if (!renameTarget) return;
    try {
      if (renameTarget.kind === "entry") {
        const renamedPath = await invoke<string>("rename_project_entry", {
          path: renameTarget.path,
          newName: name,
        });
        if (collabSession) {
          renameCollabPath(collabSession.doc, renameTarget.path, renamedPath);
        }
        await refreshProject();
        const renamedActiveFile = activeFile === renameTarget.path
          ? renamedPath
          : activeFile.startsWith(`${renameTarget.path}/`)
            ? `${renamedPath}${activeFile.slice(renameTarget.path.length)}`
            : null;
        const renamedActiveAsset = activeAsset?.path === renameTarget.path
          ? renamedPath
          : activeAsset?.path.startsWith(`${renameTarget.path}/`)
            ? `${renamedPath}${activeAsset.path.slice(renameTarget.path.length)}`
            : null;
        if (renamedActiveFile) await loadFile(renamedActiveFile);
        if (renamedActiveAsset) await openProjectAsset(renamedActiveAsset);
      } else if (renameTarget.kind === "paper") {
        const renamedPaper = await invoke<PaperSummary>("rename_paper", {
          arxivId: renameTarget.paper.arxivId,
          title: name,
        });
        await refreshProject();
        if (activePaper?.arxivId === renamedPaper.arxivId) setActivePaper(renamedPaper);
      } else if (renameTarget.kind === "label" || renameTarget.kind === "citation") {
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
  }, [activeAsset, activeFile, activePaper, loadFile, openProjectAsset, refreshHistory, refreshProject, refreshUnusedSymbols, renameTarget, collabSession]);

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

  const insertCitationFromPaper = useCallback(async (
    paper: PaperSummary,
    command: CiteCommand = "cite",
  ) => {
    if (!paper.citationKey) {
      setError(`“${paper.title}” has no citation key yet.`);
      return;
    }
    if (source !== savedSource) {
      const saved = await save();
      if (!saved) return;
    }
    if (activePaper || activeAsset || !activeFile.endsWith(".tex")) {
      const root = project?.manifest.rootDocuments.find((document) => document.isDefault)?.path
        ?? project?.manifest.rootDocuments[0]?.path
        ?? activeFile;
      if (root) await openProjectFile(root);
    }
    setCiteInsertRequest({ key: paper.citationKey, command, id: crypto.randomUUID() });
    setCanvasMode((mode) => (mode === "pdf" || mode === "paper" || mode === "asset" ? "split" : mode));
    setError(null);
  }, [activeAsset, activeFile, activePaper, openProjectFile, project, save, savedSource, source]);

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
      });
      await refreshProject();
      if (collabSession) {
        try {
          await pushLocalBlobToCollab(collabSession.doc, path);
          setCollabFileCount(collabSession.fileCount());
        } catch (reason) {
          setError(toMessage(reason));
        }
      }
      setError(null);
      return path;
    } catch (reason) {
      setError(toMessage(reason));
      return null;
    }
  }, [collabSession, refreshProject]);

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
      });
      await refreshProject();
      if (collabSession) {
        try {
          await pushLocalBlobToCollab(collabSession.doc, path);
          setCollabFileCount(collabSession.fileCount());
        } catch (reason) {
          setError(toMessage(reason));
        }
      }
      setCanvasMode((mode) => (mode === "pdf" || mode === "paper" || mode === "asset" ? "split" : mode));
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
  }, [activeFile, collabSession, project, refreshProject]);

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
        await invoke("write_project_file", { path: bibliography, content: appendBibEntry(existing, formatBibEntry(draft)) });
      }
      // Re-sync the editor buffer and collab peers with what's now on disk.
      const next = await invoke<string>("read_project_file", { path: bibliography });
      if (collabSession) pushLocalTextToCollab(collabSession.doc, bibliography, next);
      if (bibliography === activeFile) {
        setSource(next);
        setSavedSource(next);
      }
      await refreshProject();
      setBibEntryOpen(false);
      if (insertCite) {
        setCiteInsertRequest({ key: draft.key, command: "cite", id: crypto.randomUUID() });
        setCanvasMode((mode) => (mode === "pdf" || mode === "paper" || mode === "asset" ? "split" : mode));
      }
      setError(null);
    } catch (reason) {
      setBibEntryError(toMessage(reason));
    } finally {
      setBibEntryBusy(false);
    }
  }, [activeFile, bibEntryMode, collabSession, project, refreshProject, save, savedSource, source]);

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
    const prompt = paper.hasFullText
      ? `Remove “${paper.title}” and its bibliography entry?`
      : `Remove “${paper.title}” from the bibliography?`;
    if (!window.confirm(prompt)) return;
    try {
      // Either identifier is enough: a cited-only work may have no arXiv id, and
      // a paper fetched before its citation landed may have no key.
      await invoke("delete_paper", {
        arxivId: paper.arxivId || null,
        citationKey: paper.citationKey ?? null,
      });
      if (collabSession && paper.arxivId) {
        removeCollabPath(collabSession.doc, `.research/papers/${paper.arxivId}/paper.md`);
        removeCollabPath(collabSession.doc, `.research/papers/${paper.arxivId}/metadata.json`);
        setCollabFileCount(collabSession.fileCount());
      }
      if (activePaper && paperKey(activePaper) === paperKey(paper)) {
        setActivePaper(null);
        setPaperMarkdown("");
        setCanvasMode("split");
      }
      await refreshProject();
      await refreshHistory();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activePaper, collabSession, refreshHistory, refreshProject]);

  const changeProvider = useCallback((nextProvider: AgentProvider) => {
    setProvider(nextProvider);
    setAgentModel(defaultModel(nextProvider));
    setReasoningEffort("high");
  }, []);

  const refreshAgentSessions = useCallback(async () => {
    setAgentSessions(await invoke<AgentSessionSummary[]>("list_agent_sessions"));
  }, []);

  const newAgentSession = useCallback(async () => {
    if (agentRunning) return;
    try {
      const session = await invoke<AgentSession>("create_agent_session", {
        provider,
        model: agentModel,
        reasoningEffort,
      });
      setActiveSession(session);
      setMessages(session.messages);
      setBranchSource(null);
      setSessionMenuOpen(false);
      await refreshAgentSessions();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [agentModel, agentRunning, provider, reasoningEffort, refreshAgentSessions]);

  const openAgentSession = useCallback(async (id: string) => {
    if (agentRunning || id === activeSession?.id) {
      setSessionMenuOpen(false);
      return;
    }
    try {
      const session = await invoke<AgentSession>("read_agent_session", { sessionId: id });
      setActiveSession(session);
      setMessages(session.messages);
      setBranchSource(null);
      setProvider(session.provider);
      setAgentModel(normalizeModel(session.provider, session.model));
      setReasoningEffort(normalizeEffort(session.reasoningEffort));
      setSessionMenuOpen(false);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeSession?.id, agentRunning]);

  const deleteAgentSession = useCallback(async (id: string) => {
    if (agentRunning) return;
    if (!window.confirm("Delete this conversation? This cannot be undone.")) return;
    try {
      await invoke("delete_agent_session", { sessionId: id });
      let remaining = await invoke<AgentSessionSummary[]>("list_agent_sessions");
      if (id === activeSession?.id) {
        const next = remaining.length
          ? await invoke<AgentSession>("read_agent_session", { sessionId: remaining[0].id })
          : await invoke<AgentSession>("create_agent_session", { provider, model: agentModel, reasoningEffort });
        if (!remaining.length) remaining = await invoke<AgentSessionSummary[]>("list_agent_sessions");
        setActiveSession(next);
        setMessages(next.messages);
        setProvider(next.provider);
        setAgentModel(normalizeModel(next.provider, next.model));
        setReasoningEffort(normalizeEffort(next.reasoningEffort));
      }
      setAgentSessions(remaining);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [activeSession, agentModel, agentRunning, provider, reasoningEffort]);

  const refreshApiKeys = useCallback(async () => {
    const statuses = await invoke<[string, boolean][]>("api_key_status");
    setApiKeyStatus(Object.fromEntries(statuses));
  }, []);

  const refreshSubscriptions = useCallback(async () => {
    setSubscriptionsLoading(true);
    try {
      setSubscriptions(await invoke<SubscriptionStatus[]>("subscription_status"));
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setSubscriptionsLoading(false);
    }
  }, []);

  const refreshAgentSkills = useCallback(async () => {
    setAgentSkills(await invoke<AgentSkill[]>("list_agent_skills"));
  }, []);

  const openSettings = useCallback((tab: SettingsTab = "appearance") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
    setSubscriptionNotice("");
    if (tab === "api") void refreshApiKeys().catch((reason) => setError(toMessage(reason)));
    if (tab === "accounts") void refreshSubscriptions();
    if (tab === "agent") void refreshAgentSkills().catch((reason) => setError(toMessage(reason)));
  }, [refreshAgentSkills, refreshApiKeys, refreshSubscriptions]);

  const sendToAgent = useCallback(async () => {
    const message = agentInput.trim();
    if (!message || agentRunning) return;
    setAgentInput("");
    setAgentRunning(true);
    setAgentStreaming(false);
    setAgentStopping(false);
    setAgentCancellable(false);
    setAgentStatus(branchSource ? "Creating conversation branch…" : "Reading project context…");
    let session = activeSession;
    let currentMessages = messages;
    const streamedMessageId = crypto.randomUUID();
    try {
      if (!(await save())) throw new Error("Save the current file before running the agent.");
      if (branchSource) {
        session = await invoke<AgentSession>("fork_agent_session", {
          sourceSessionId: branchSource.sessionId,
          messageId: branchSource.messageId,
          systemPrompt,
        });
        setBranchSource(null);
        setProvider(session.provider);
        setAgentModel(normalizeModel(session.provider, session.model));
        setReasoningEffort(normalizeEffort(session.reasoningEffort));
        currentMessages = session.messages;
        setMessages(session.messages);
        setSelection("");
        setSelectionSource(null);
        await refreshProject();
        await refreshHistory();
        if (activeFile) await loadFile(activeFile);
        await compile();
      } else if (!session) session = await invoke<AgentSession>("create_agent_session", {
        provider,
        model: agentModel,
        reasoningEffort,
      });
      const userMessage: ChatMessage = { id: crypto.randomUUID(), role: "user", text: message };
      await invoke("save_agent_checkpoint", { sessionId: session.id, messageId: userMessage.id });
      const pendingMessages = [...session.messages, userMessage];
      currentMessages = pendingMessages;
      setMessages(pendingMessages);
      // The turn is assembled in order as it happens. Rust re-sends the whole
      // transcript on every delta, so the length already committed to closed
      // text parts is exactly where the next spoken run begins — that offset is
      // all the interleaving needs.
      let parts: ChatPart[] = [];
      let fullText = "";
      let committed = 0;
      const publish = () => {
        const streamedMessages: ChatMessage[] = [...pendingMessages, {
          id: streamedMessageId,
          role: "agent",
          text: fullText,
          parts: [...parts],
        }];
        currentMessages = streamedMessages;
        setMessages(streamedMessages);
      };
      const onEvent = new Channel<AgentStreamEvent>((event) => {
        if (event.type === "cancellable") {
          setAgentCancellable(event.enabled);
          return;
        }
        if (event.type === "status") {
          setAgentStatus(event.message);
          return;
        }
        if (event.type === "tool") {
          if (event.phase === "end") {
            for (let index = parts.length - 1; index >= 0; index -= 1) {
              const part = parts[index];
              if (part?.kind === "tool" && part.name === event.name && part.phase === "start") {
                parts[index] = { ...part, phase: "end", detail: event.detail || "done" };
                publish();
                return;
              }
            }
            parts = [...parts, {
              kind: "tool",
              id: crypto.randomUUID(),
              name: event.name,
              detail: event.detail || "done",
              phase: "end",
            }];
            publish();
            return;
          }
          // A blinking caret with no text arriving reads as "stuck". Hand the
          // floor back to the status row ("Editing main.tex…") for the duration
          // of the tool call; the next text delta re-raises the caret.
          setAgentStreaming(false);
          // Seal whatever has been said so far so the next run of text lands
          // after this tool rather than growing the paragraph above it.
          committed = fullText.length;
          parts = [...parts, {
            kind: "tool",
            id: crypto.randomUUID(),
            name: event.name,
            detail: event.detail,
            phase: "start",
          }];
          publish();
          return;
        }
        if (!event.text) return;
        fullText = event.text;
        const spoken = fullText.slice(committed);
        const last = parts[parts.length - 1];
        if (last?.kind === "text") {
          parts = [...parts.slice(0, -1), { kind: "text", text: spoken }];
        } else if (spoken) {
          parts = [...parts, { kind: "text", text: spoken }];
        }
        setAgentStreaming(true);
        setAgentStatus("");
        publish();
      });
      session = await invoke<AgentSession>("save_agent_session", {
        session: { ...session, provider, model: agentModel, reasoningEffort, messages: pendingMessages },
      });
      setActiveSession(session);
      await refreshAgentSessions();
      runningAgentSession.current = session.id;
      const result = await invoke<AgentResult>("run_agent", {
        onEvent,
        request: {
          settings: { provider, model: agentModel, reasoningEffort },
          message,
          activeFile: activeFile || null,
          selection: selection || null,
          sessionId: session.id,
          sessionTitle: session.title,
          systemPrompt,
        },
      });
      // Nothing streamed (a short non-streaming reply) leaves no parts to keep,
      // so fall back to the summary as a single spoken part.
      const completedParts: ChatPart[] = parts.length
        ? parts
        : [{ kind: "text", text: result.summary }];
      const completedMessages: ChatMessage[] = [...pendingMessages, {
        id: streamedMessageId,
        role: "agent",
        text: result.summary,
        files: result.changedFiles,
        skills: result.skillsUsed ?? [],
        parts: completedParts,
      }];
      currentMessages = completedMessages;
      setAgentStreaming(false);
      setAgentStatus("");
      setMessages(completedMessages);
      session = await invoke<AgentSession>("save_agent_session", {
        session: { ...session, provider, model: agentModel, reasoningEffort, messages: completedMessages },
      });
      setActiveSession(session);
      await refreshAgentSessions();
      if (activeFile && result.changedFiles.includes(activeFile)) await loadFile(activeFile);
      // The agent writes straight to disk, so nothing has told the shared doc.
      // Without this a collaborator sees none of the work it just did.
      if (collabSession && result.changedFiles.length) {
        for (const path of result.changedFiles) {
          const kind = classifySyncablePath(path);
          if (!kind) continue;
          try {
            if (kind === "text") {
              pushLocalTextToCollab(
                collabSession.doc,
                path,
                await invoke<string>("read_project_file", { path }),
              );
            } else {
              await pushLocalBlobToCollab(collabSession.doc, path);
            }
          } catch {
            // A file the agent deleted, or one too large to share; the rest
            // must still go out.
          }
        }
        setCollabFileCount(collabSession.fileCount());
      }
      await refreshProject();
      await refreshHistory();
      if (result.changedFiles.length) await compile();
    } catch (reason) {
      const { text, settingsTab } = agentErrorDetails(toMessage(reason));
      const failedMessages: ChatMessage[] = [
        ...currentMessages,
        { id: crypto.randomUUID(), role: "system", text },
      ];
      setMessages(failedMessages);
      if (settingsTab) openSettings(settingsTab);
      if (session) {
        try {
          const saved = await invoke<AgentSession>("save_agent_session", {
            session: { ...session, provider, model: agentModel, reasoningEffort, messages: failedMessages },
          });
          setActiveSession(saved);
          await refreshAgentSessions();
        } catch {
          // Keep the visible error when persistence also fails.
        }
      }
    } finally {
      runningAgentSession.current = null;
      setAgentRunning(false);
      setAgentStreaming(false);
      setAgentStopping(false);
      setAgentCancellable(false);
      setAgentStatus("");
    }
  }, [activeFile, activeSession, agentInput, agentModel, agentRunning, branchSource, compile, loadFile, messages, openSettings, provider, reasoningEffort, refreshAgentSessions, refreshHistory, refreshProject, save, selection, systemPrompt]);

  const stopAgent = useCallback(async () => {
    const sessionId = runningAgentSession.current;
    if (!sessionId || agentStopping) return;
    setAgentStopping(true);
    setAgentStatus("Stopping agent…");
    try {
      const stopped = await invoke<boolean>("abort_agent", { sessionId });
      if (!stopped) setAgentStatus("Agent is already finishing…");
    } catch (reason) {
      setAgentStopping(false);
      setError(toMessage(reason));
    }
  }, [agentStopping]);

  const editAndBranch = useCallback((message: ChatMessage) => {
    if (!activeSession || agentRunning || message.role !== "user") return;
    setBranchSource({ sessionId: activeSession.id, messageId: message.id });
    setAgentInput(message.text);
  }, [activeSession, agentRunning]);

  const revert = useCallback(
    async (id: string) => {
      if (!window.confirm("Restore the project to the state before this change?")) return;
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

  const saveAgentSkill = useCallback(async (draft: SkillDraft) => {
    try {
      await invoke("save_agent_skill", {
        request: { originalName: draft.originalName ?? null, scope: draft.scope, content: draft.content },
      });
      setSkillDraft(null);
      await refreshAgentSkills();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [refreshAgentSkills]);

  const setAgentSkillEnabled = useCallback(async (name: string, enabled: boolean) => {
    try {
      await invoke("set_agent_skill_enabled", { name, enabled });
      await refreshAgentSkills();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [refreshAgentSkills]);

  const deleteAgentSkill = useCallback(async (skill: AgentSkill) => {
    if (!window.confirm(`Delete ${skill.name}?`)) return;
    try {
      await invoke("delete_agent_skill", { name: skill.name, scope: skill.scope });
      await refreshAgentSkills();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [refreshAgentSkills]);

  const beginSubscriptionLogin = useCallback(async (providerName: "codex" | "claude") => {
    setSubscriptionsLoading(true);
    setSubscriptionNotice(`Starting ${providerName === "codex" ? "Codex" : "Claude"} sign-in through OMP…`);
    try {
      const onEvent = new Channel<{ message: string }>();
      onEvent.onmessage = (event) => setSubscriptionNotice(event.message);
      await invoke("begin_subscription_login", { provider: providerName, onEvent });
      setSubscriptionNotice(`${providerName === "codex" ? "Codex" : "Claude"} is connected through OMP.`);
      setSubscriptions(await invoke<SubscriptionStatus[]>("subscription_status"));
    } catch (reason) {
      setError(toMessage(reason));
    } finally {
      setSubscriptionsLoading(false);
    }
  }, []);

  const saveApiKey = useCallback(async () => {
    try {
      await invoke("save_api_key", { provider: apiProvider, key: apiKey });
      setApiKey("");
      await refreshApiKeys();
      changeProvider(apiProvider === "openai" ? "openai-api" : "anthropic-api");
      setSettingsOpen(false);
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [apiKey, apiProvider, changeProvider, refreshApiKeys]);

  const deleteApiKey = useCallback(async () => {
    try {
      await invoke("delete_api_key", { provider: apiProvider });
      setApiKey("");
      await refreshApiKeys();
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [apiProvider, refreshApiKeys]);

  const deleteHistory = useCallback(async (id: string) => {
    if (!window.confirm("Delete this history entry? This cannot be undone.")) return;
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
      if (collabSession) {
        pushLocalTextToCollab(collabSession.doc, COLLAB_EDITOR_COMMENTS_PATH, payload);
      }
    } catch (reason) {
      setError(toMessage(reason));
    }
  }, [collabSession]);

  const toggleEditorCommentResolved = useCallback((id: string) => {
    void persistEditorComments(editorComments.map((item) => (
      item.id === id
        ? { ...item, resolved: !item.resolved, updatedAt: new Date().toISOString() }
        : item
    )));
  }, [editorComments, persistEditorComments]);

  const replyToEditorComment = useCallback((commentId: string, body: string) => {
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
  }, [collabName, editorCommentAuthorId, editorComments, persistEditorComments]);

  const openEditorCommentReply = useCallback((commentId: string) => {
    setCommentPanelFocusId(commentId);
    setEditorCommentsOpen(true);
  }, []);

  const beginPanelResize = useCallback((panel: PanelKind, event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidths = panelWidths;
    let latest = panelWidths;
    document.body.classList.add("resizing-panels");
    const handleMove = (moveEvent: PointerEvent) => {
      latest = resizePanelWidths(panel, startWidths, moveEvent.clientX - startX, navigatorOpen, agentOpen);
      setPanelWidths(latest);
    };
    const handleUp = () => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      persistPanelWidths(latest);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  }, [agentOpen, navigatorOpen, panelWidths]);

  const nudgePanel = useCallback((panel: PanelKind, delta: number) => {
    setPanelWidths((current) => {
      const next = resizePanelWidths(panel, current, delta, navigatorOpen, agentOpen);
      persistPanelWidths(next);
      return next;
    });
  }, [agentOpen, navigatorOpen]);

  const settingsDialog = settingsOpen ? (
    <SettingsDialog
      tab={settingsTab}
      setTab={(tab) => {
        setSettingsTab(tab);
        if (tab === "api") void refreshApiKeys().catch((reason) => setError(toMessage(reason)));
        if (tab === "accounts") void refreshSubscriptions();
        if (tab === "agent") void refreshAgentSkills().catch((reason) => setError(toMessage(reason)));
        if (tab === "doctor") void runDoctor();
      }}
      doctorReport={doctorReport}
      doctorBusy={doctorBusy}
      doctorNotice={doctorNotice}
      onRunDoctor={() => { void runDoctor(); }}
      onOpenTexSetup={() => openTexSetupWizard()}
      onCopyDoctorSummary={() => { void copyDoctorSummary(); }}
      appearance={appearance}
      setAppearance={setAppearance}
      theme={theme}
      setTheme={setTheme}
      buildPreferences={buildPreferences}
      setBuildPreferences={setBuildPreferences}
      systemPrompt={systemPrompt}
      setSystemPrompt={setSystemPrompt}
      hasProject={Boolean(project)}
      project={project}
      onUpdateManifest={async (patch) => {
        try {
          const manifest = await invoke<ProjectManifest>("update_project_manifest", patch);
          setProject((current) => current ? { ...current, manifest } : current);
          setError(null);
        } catch (reason) {
          setError(toMessage(reason));
        }
      }}
      activeFile={activeFile}
      onAddRootDocument={async (path, makeDefault) => {
        try {
          const manifest = await invoke<ProjectManifest>("add_root_document", {
            path,
            name: null,
            makeDefault,
          });
          setProject((current) => current ? { ...current, manifest } : current);
          setError(null);
        } catch (reason) {
          setError(toMessage(reason));
        }
      }}
      onRemoveRootDocument={async (path) => {
        try {
          const manifest = await invoke<ProjectManifest>("remove_root_document", { path });
          setProject((current) => current ? { ...current, manifest } : current);
          setError(null);
        } catch (reason) {
          setError(toMessage(reason));
        }
      }}
      skills={agentSkills}
      skillDraft={skillDraft}
      setSkillDraft={setSkillDraft}
      onSaveSkill={saveAgentSkill}
      onSetSkillEnabled={setAgentSkillEnabled}
      onDeleteSkill={deleteAgentSkill}
      subscriptions={subscriptions}
      subscriptionsLoading={subscriptionsLoading}
      subscriptionNotice={subscriptionNotice}
      onRefreshSubscriptions={refreshSubscriptions}
      onSubscriptionLogin={beginSubscriptionLogin}
      apiProvider={apiProvider}
      setApiProvider={setApiProvider}
      apiKey={apiKey}
      setApiKey={setApiKey}
      apiConfigured={Boolean(apiKeyStatus[apiProvider])}
      onSaveApiKey={saveApiKey}
      onDeleteApiKey={deleteApiKey}
      onClose={() => {
        setSettingsOpen(false);
        setApiKey("");
      }}
    />
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
        // Papers are read-only, so never dirty and never a split "beside" pane.
        return { path, kind: "paper" as const, label: papers.find((paper) => paper.arxivId === id)?.title ?? "Paper" };
      }
      return {
        path,
        kind: "file" as const,
        dirty: (path === activeFile && source !== savedSource)
          || (path === secondaryFile && secondarySource !== secondarySavedSource),
        beside: path === secondaryFile && (canvasMode === "dual" || canvasMode === "columns"),
      };
    }),
    [activeFile, canvasMode, openTabs, papers, savedSource, secondaryFile, secondarySavedSource, secondarySource, source],
  );
  // The tab that reads as active: the open paper in paper mode, else the focused
  // editor pane. Also the key eviction must never close.
  const activeTabKey = canvasMode === "paper" && activePaper
    ? paperTabKey(activePaper.arxivId)
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
  const collabEditorExtensionsMemo = useMemo(() => {
    // Do not bind until the shared doc is ready (see collabReady). Binding before
    // the host's Y.Texts have synced makes ensureCollabText create a competing
    // main.tex that loses the map key and strands the editor on the placeholder.
    if (!collabSession || !activeFile || !collabReady) return [];
    // Bind the open path's Y.Text before yCollab is constructed. Only depends on
    // session/path/readiness — not on keystrokes — so awareness listeners stay alive.
    // eslint-disable-next-line react-hooks/refs -- intentional path bind with loaded buffer
    collabSession.setActivePath(activeFile, sourceRef.current);
    return collabEditorExtensions(collabSession);
  }, [collabSession, activeFile, collabReady]);
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
    void invoke<{ page: number }>("synctex_view", {
      path: marker.path,
      line: marker.line,
      column: 0,
    })
      .then((target) => {
        if (!cancelled) setMainBodyPages(Math.max(0, target.page - 1));
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
  }, [cycleCompileDiagnostic, navigateHistory, reopenClosedTab, revealSourceInPdf]);

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
          onSettings={() => openSettings("appearance")}
          onInstallTex={openTexSetupWizard}
        />
        <CollabDialog
          open={collabOpen}
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
          onHostChange={setCollabHost}
          onRoomChange={setCollabRoom}
          onDisplayNameChange={setCollabName}
          onInviteChange={setCollabInvite}
          onStartShare={startCollabShare}
          onJoinShare={joinCollabShare}
          onDisconnect={disconnectCollab}
          onCopyInvite={copyCollabInvite}
          onInstallTex={openTexSetupWizard}
        />
        {settingsDialog}
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
        <div className="titlebar-navigator">
          <div className="traffic-space" />
          <Tip label={navigatorOpen ? "Hide navigator" : "Show navigator"}>
            <button className="icon-button" onClick={() => setNavigatorOpen((value) => !value)}>
              <span key={navigatorOpen ? "open" : "closed"} className="toggle-icon">
                {navigatorOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
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
                disabled={agentRunning || building || importing}
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
              onExportZip={() => void exportProjectZip()}
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
            <div className="collab-peer-avatars" aria-label="People in this session">
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
            </div>
          )}
          <div className="titlebar-drag-area" aria-hidden="true" />
        </div>
        <div className="title-actions">
          <Tip label={agentOpen ? "Hide writing agent" : "Show writing agent"}>
            <button
              className={`icon-button ${agentOpen ? "active" : ""}`}
              onClick={() => setAgentOpen((value) => !value)}
              aria-pressed={agentOpen}
            >
              <Bot size={16} />
            </button>
          </Tip>
          <Tip label="Settings">
            <button className="icon-button" onClick={() => openSettings("appearance")}>
              <Settings2 size={16} />
            </button>
          </Tip>
          <Tip label="Clean aux files">
            <button
              className="icon-button"
              disabled={building || cleaning}
              onClick={() => void cleanProject()}
            >
              {cleaning ? <LoaderCircle className="spin" size={15} /> : <Eraser size={15} />}
            </button>
          </Tip>
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
      </header>

      {error && (
        <div className="error-banner">
          <CircleAlert size={15} />
          <span>{error}</span>
          <button onClick={() => setError(null)}><X size={14} /></button>
        </div>
      )}
      {notice && !error && (
        <div className="notice-banner">
          <Check size={15} />
          <span>{notice}</span>
          <button onClick={() => setNotice(null)}><X size={14} /></button>
        </div>
      )}
      {!diagnosticsDismissed && build && (!build.success || build.diagnostics.length > 0) ? (
        <CompileDiagnosticsPanel
          diagnostics={build.diagnostics}
          log={build.log}
          success={build.success}
          expanded={diagnosticsExpanded}
          onExpandedChange={setDiagnosticsExpanded}
          onSelect={(diagnostic) => void openCompileDiagnostic(diagnostic)}
          onDismiss={() => setDiagnosticsDismissed(true)}
        />
      ) : null}
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
        className={`workspace ${navigatorOpen ? "" : "navigator-hidden"} ${agentOpen ? "" : "agent-hidden"}`}
        style={{
          gridTemplateColumns: [
            navigatorOpen ? `${panelWidths.navigator}px 5px` : "",
            agentOpen ? `${panelWidths.agent}px 5px` : "",
            "minmax(360px, 1fr)",
          ].filter(Boolean).join(" "),
        }}
      >
        {navigatorOpen && (
          <>
            <Navigator
              files={project.files}
              activeFile={activeAsset || activePaper ? "" : activeFile}
              activeAssetPath={activeAsset?.path ?? ""}
              protectedPaths={[
                ...project.manifest.rootDocuments.map((document) => document.path),
                project.manifest.primaryBibliography,
              ]}
              papers={papers}
              activePaper={activePaper}
              onFile={(path, line) => { void openProjectFile(path, line); }}
              onAsset={openProjectAssetFromClick}
              onBeginFigureDrag={beginProjectFigureDrag}
              onCreateEntry={createProjectEntry}
              onDeleteEntry={deleteProjectEntry}
              onRenameEntry={renameProjectEntry}
              onReveal={revealProjectItem}
              onRefresh={() => void refreshProject()}
              onImportAssets={chooseProjectAssets}
              assetDropTarget={assetDropTarget}
              assetImporting={assetImporting}
              onPaper={openPaper}
              onCitePaper={(paper, command) => void insertCitationFromPaper(paper, command)}
              onFetchFullText={(paper) => void importArxivInput(paper.arxivId)}
              onAddBibEntry={() => openBibEntryDialog()}
              onDiscoverLiterature={() => setLiteratureOpen(true)}
              onDeletePaper={deletePaper}
              onRenamePaper={renameImportedPaper}
              onEditBibEntry={(paper) => void openEditBibEntry(paper)}
              importInput={importInput}
              setImportInput={setImportInput}
              onImport={importPaper}
              importing={importing}
            />
            <PanelResizer
              label="Resize project navigator"
              value={panelWidths.navigator}
              onPointerDown={(event) => beginPanelResize("navigator", event)}
              onNudge={(delta) => nudgePanel("navigator", delta)}
            />
          </>
        )}

        {agentOpen && (
        <>
        <AgentPanel
          agentCommands={agentCommands}
          katexMacros={katexMacros}
          messages={messages}
          sessions={agentSessions}
          activeSession={activeSession}
          sessionMenuOpen={sessionMenuOpen}
          setSessionMenuOpen={setSessionMenuOpen}
          onNewSession={newAgentSession}
          onOpenSession={openAgentSession}
          onDeleteSession={deleteAgentSession}
          onEditMessage={editAndBranch}
          input={agentInput}
          setInput={setAgentInput}
          provider={provider}
          setProvider={changeProvider}
          model={agentModel}
          setModel={setAgentModel}
          reasoningEffort={reasoningEffort}
          setReasoningEffort={setReasoningEffort}
          running={agentRunning}
          streaming={agentStreaming}
          status={agentStatus}
          cancellable={agentCancellable}
          stopping={agentStopping}
          onSend={sendToAgent}
          onStop={stopAgent}
          onApiSettings={() => openSettings("api")}
          selection={selection}
          selectionSource={selectionSource}
          onClearSelection={() => {
            dismissedSelectionRef.current = selection;
            setSelection("");
            setSelectionSource(null);
          }}
          branchSource={branchSource}
          onCancelBranch={() => setBranchSource(null)}
          mentions={agentMentions}
          chatEnd={chatEnd}
        />

        <PanelResizer
          label="Resize writing agent"
          value={panelWidths.agent}
          onPointerDown={(event) => beginPanelResize("agent", event)}
          onNudge={(delta) => nudgePanel("agent", delta)}
        />
        </>
        )}

        <section className="canvas-panel">
          <CanvasToolbar
            mode={canvasMode}
            setMode={openDocumentMode}
            activePath={activeAsset?.path ?? activePaper?.title ?? (
              focusedPane === "secondary" && secondaryFile ? secondaryFile : activeFile
            )}
            activeKind={activeAsset ? "asset" : activePaper ? "paper" : "document"}
            dirty={
              source !== savedSource
              || (Boolean(secondaryFile) && secondarySource !== secondarySavedSource)
            }
            canForwardSync={Boolean(editorPosition && (pdfUrl || build?.pdfBase64))}
            locatingPdf={locatingPdf}
            canNavigateBack={navIndex > 0}
            canNavigateForward={navIndex >= 0 && navIndex < navStack.length - 1}
            onNavigateBack={() => void navigateHistory(-1)}
            onNavigateForward={() => void navigateHistory(1)}
            onInsert={() => setInsertOpen(true)}
            onCollab={openCollabDialog}
            collabLive={collabStatus === "synced" || collabStatus === "connecting"}
            collabPeers={collabPeers}
            onForwardSync={() => void revealSourceInPdf()}
            onHistory={() => setHistoryOpen(true)}
            onGit={() => setGitOpen(true)}
            commentCount={editorComments.filter((comment) => !comment.resolved).length}
            onComments={() => setEditorCommentsOpen(true)}
          />
          <div className="canvas-body">
          <EditorTabs
            tabs={editorTabItems}
            activePath={activeTabKey}
            onSelect={(path) => {
              if (isPaperTabKey(path)) {
                const paper = papers.find((item) => item.arxivId === arxivIdFromTabKey(path));
                if (paper) void openPaper(paper);
                else void closeEditorTab(path);
              } else {
                void openProjectFile(path);
              }
            }}
            onClose={(path) => { void closeEditorTab(path); }}
            onReorder={(next) => setOpenTabs(next)}
          />
          <DocumentCanvas
            mode={canvasMode}
            source={source}
            activeFile={activeFile}
            secondaryFile={secondaryFile}
            secondarySource={secondarySource}
            setSecondarySource={setSecondarySource}
            focusedPane={focusedPane}
            onFocusPane={setFocusedPane}
            setSource={setSource}
            setSelection={(value) => {
              // The editor keeps re-reporting a dismissed selection; ignore it
              // until the selection changes to something else (or collapses).
              if (value && value === dismissedSelectionRef.current) return;
              dismissedSelectionRef.current = "";
              setSelection(value);
              setSelectionSource(value ? "editor" : null);
            }}
            onPdfTextSelect={(value) => {
              dismissedSelectionRef.current = "";
              setSelection(value);
              setSelectionSource(value ? "pdf" : null);
            }}
            pdfUrl={pdfUrl}
            pdfBase64={previewPdfBase64}
            paperMarkdown={paperMarkdown}
            paperBlog={paperBlog}
            paperView={paperView}
            onSetPaperView={setPaperView}
            activePaper={activePaper}
            activeAsset={activeAsset}
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
            figurePointerPosition={figurePointerDrag?.overEditor ? {
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
            onOutlineNavigate={(path, line) => { void openProjectFile(path, line); }}
            insertOpen={insertOpen}
            onInsertOpenChange={setInsertOpen}
            tableGeneratorOpen={tableGeneratorOpen}
            onTableGeneratorOpenChange={setTableGeneratorOpen}
            editorKeymap={appearance.editorKeymap}
            editorSpellcheck={appearance.editorSpellcheck}
            citeInsertRequest={citeInsertRequest}
            onCiteInsertHandled={(id) => setCiteInsertRequest((current) => current?.id === id ? null : current)}
            projectPaths={projectPaths}
            graphicsRoots={graphicsRoots}
            buildDiagnostics={build?.diagnostics ?? []}
            texlabDiagnostics={texlabDiagnostics}
            pdfSyncTarget={pdfSyncTarget}
            onPdfSource={revealPdfSource}
            pdfMarks={[]}
            activePdfMarkId={null}
            onCreatePdfMark={undefined}
            onSelectPdfMark={undefined}
            onOpenPdfMarks={undefined}
            editorComments={editorComments}
            activeEditorCommentId={activeEditorCommentId}
            commentAuthorName={collabName.trim() || "Anonymous"}
            commentAuthorId={editorCommentAuthorId}
            onCreateEditorComment={(comment) => {
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
            onCreateMissingFile={(path) => {
              void createProjectEntry(path, "file");
            }}
            collabExtensions={collabEditorExtensionsMemo}
            collabEditorKey={collabSession
              ? `collab:${collabSession.room}:${activeFile}:${collabReady ? "live" : "wait"}`
              : `local:${activeFile}`}
          />
          </div>
        </section>
      </main>

      <CollabDialog
        open={collabOpen}
        mode={collabMode}
        role={collabRole}
        joinOnly={false}
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
        onHostChange={setCollabHost}
        onRoomChange={setCollabRoom}
        onDisplayNameChange={setCollabName}
        onInviteChange={setCollabInvite}
        onStartShare={startCollabShare}
        onJoinShare={joinCollabShare}
        onDisconnect={disconnectCollab}
        onCopyInvite={copyCollabInvite}
        onInstallTex={openTexSetupWizard}
      />

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
          className={`figure-drag-ghost ${figurePointerDrag.overEditor ? "ready" : ""}`}
          style={{ left: figurePointerDrag.clientX + 12, top: figurePointerDrag.clientY + 12 }}
        >
          <Image size={13} />
          <span>{figurePointerDrag.label}</span>
        </div>
      )}

      {historyOpen && (
        <HistoryDrawer
          history={history}
          onClose={() => setHistoryOpen(false)}
          onRevert={revert}
          onRevertFile={async (id, path) => {
            if (!window.confirm(`Restore only “${path}” to the state before this change?`)) return;
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
        />
      )}
      {gitOpen && (
        <GitPanel
          onClose={() => setGitOpen(false)}
          onOpenFile={(path, line) => { void openProjectFile(path, line); }}
        />
      )}
      {editorCommentsOpen && (
        <EditorCommentsPanel
          comments={editorComments}
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
            void persistEditorComments(editorComments.filter((comment) => comment.id !== id));
            setActiveEditorCommentId((current) => (current === id ? null : current));
          }}
          onToggleResolved={(comment) => toggleEditorCommentResolved(comment.id)}
          onUpdateBody={(comment, body) => {
            const trimmed = body.trim();
            if (!trimmed) return;
            void persistEditorComments(editorComments.map((item) => (
              item.id === comment.id
                ? { ...item, body: trimmed, updatedAt: new Date().toISOString() }
                : item
            )));
          }}
          onReply={(comment, body) => replyToEditorComment(comment.id, body)}
        />
      )}
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
          setCanvasMode((mode) => (mode === "pdf" || mode === "paper" || mode === "asset" ? "split" : mode));
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
          setCanvasMode((mode) => (mode === "pdf" || mode === "paper" || mode === "asset" ? "split" : mode));
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
        <LiteratureDiscoveryPanel
          onClose={() => setLiteratureOpen(false)}
          importedIds={importedArxivIds}
          onImportArxiv={(arxivId) => importArxivInput(arxivId)}
          onAddBib={(query) => {
            setLiteratureOpen(false);
            openBibEntryDialog(query);
          }}
        />
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
          { id: "insert", label: "Insert snippet", detail: "⌘⇧I", group: "Edit" },
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
              void formatLatexDocument(path, text)
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
            case "doctor": openSettings("doctor"); break;
            case "settings": openSettings("appearance"); break;
            default: break;
          }
        }}
      />
      {settingsDialog}
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

function Welcome(props: {
  busyLabel: string | null;
  createOpen: boolean;
  error: string | null;
  createError: string | null;
  projectName: string;
  projectVenue: ProjectVenue;
  onOpenCreate: () => void;
  onCloseCreate: () => void;
  setProjectName: (value: string) => void;
  setProjectVenue: (value: ProjectVenue) => void;
  onCreate: () => void;
  onOpen: () => void;
  onImportZip: () => void;
  onJoinCollab: () => void;
  onSettings: () => void;
  onInstallTex: () => void;
}) {
  return (
    <div className="welcome-screen">
      <div className="welcome-titlebar" onMouseDown={beginWindowDrag} onDoubleClick={toggleWindowFullscreen}>
        <button className="icon-button" onClick={props.onSettings} title="Settings"><Settings2 size={16} /></button>
      </div>
      <div className="welcome-glow" />
      <div className="welcome-content">
        <div className="brand-mark"><Sparkles size={24} /></div>
        <p className="eyebrow">LATTICE</p>
        <h1>Research, written with evidence.</h1>
        <p className="welcome-copy">
          A local-first LaTeX workspace where your writing agent, sources, manuscript, and rendered paper stay connected.
        </p>
        <div className="welcome-actions">
          <button className="primary-button" onClick={props.onOpenCreate}>
            <Plus size={17} /> New project
          </button>
          <button className="secondary-button" onClick={props.onOpen}>
            <FolderOpen size={17} /> Open folder
          </button>
          <button className="secondary-button" onClick={props.onImportZip}>
            <FileArchive size={17} /> Import ZIP
          </button>
          <button className="secondary-button" onClick={props.onJoinCollab}>
            <Radio size={17} /> Join share
          </button>
        </div>
        <button type="button" className="text-button welcome-tex-setup" onClick={props.onInstallTex}>
          Install LaTeX tools (needed to compile PDFs)
        </button>
        {props.busyLabel && <p className="busy-label"><LoaderCircle className="spin" size={15} /> {props.busyLabel}</p>}
        {props.error && <p className="welcome-error">{props.error}</p>}
      </div>
      {props.createOpen && (
        <CreateProjectDialog
          projectName={props.projectName}
          setProjectName={props.setProjectName}
          projectVenue={props.projectVenue}
          setProjectVenue={props.setProjectVenue}
          error={props.createError}
          onCreate={props.onCreate}
          onClose={props.onCloseCreate}
        />
      )}
    </div>
  );
}

const PROJECT_VENUES: { id: ProjectVenue; label: string; detail: string }[] = [
  { id: "neurips", label: "NeurIPS", detail: "Official 2026 style, preprint option" },
  { id: "icml", label: "ICML", detail: "Official 2026 style, preprint option" },
  { id: "iclr", label: "ICLR", detail: "Official 2026 conference style" },
];

function CreateProjectDialog(props: {
  projectName: string;
  setProjectName: (value: string) => void;
  projectVenue: ProjectVenue;
  setProjectVenue: (value: ProjectVenue) => void;
  error: string | null;
  onCreate: () => void;
  onClose: () => void;
}) {
  const venue = PROJECT_VENUES.find((item) => item.id === props.projectVenue) ?? PROJECT_VENUES[0];
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="modal create-project-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><FileText size={20} /></div>
        <h2>Create a research project</h2>
        <p>
          Lattice will create a {venue.label} preprint template, bibliography, project brief, and private conversation history.
        </p>
        <label>
          Project name
          <input autoFocus value={props.projectName} onChange={(event) => props.setProjectName(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.onCreate()} />
        </label>
        <fieldset className="venue-picker" aria-label="Venue template">
          <legend>Venue template</legend>
          {PROJECT_VENUES.map((item) => (
            <label key={item.id} className={`venue-option ${props.projectVenue === item.id ? "active" : ""}`}>
              <input
                type="radio"
                name="project-venue"
                value={item.id}
                checked={props.projectVenue === item.id}
                onChange={() => props.setProjectVenue(item.id)}
              />
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail}</small>
              </span>
            </label>
          ))}
        </fieldset>
        {props.error && <p className="field-error" role="alert">{props.error}</p>}
        <div className="modal-actions">
          <button className="text-button" onClick={props.onClose}>Cancel</button>
          <button className="primary-button" onClick={props.onCreate}>Choose location</button>
        </div>
      </div>
    </div>
  );
}

function RenameDialog(props: {
  target: RenameTarget;
  error: string | null;
  onRename: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const initialName = props.target.kind === "entry"
    ? props.target.name
    : props.target.kind === "paper"
      ? props.target.paper.title
      : props.target.kind === "label"
        ? props.target.label
        : props.target.kind === "environment"
          ? props.target.name
          : props.target.kind === "wrap-environment"
            ? "equation"
            : props.target.key;
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const title = props.target.kind === "paper"
    ? "Rename paper"
    : props.target.kind === "label"
      ? "Rename label"
      : props.target.kind === "citation"
        ? "Rename citation key"
        : props.target.kind === "environment"
          ? "Rename environment"
          : props.target.kind === "wrap-environment"
            ? "Wrap in environment"
            : "Rename project item";
  const copy = props.target.kind === "paper"
    ? "This changes the title shown in Papers. The citation key stays unchanged."
    : props.target.kind === "label"
      ? "Updates every \\label and \\ref/\\cref occurrence across the project."
      : props.target.kind === "citation"
        ? "Updates the bibliography entry and every \\cite occurrence across the project."
        : props.target.kind === "environment"
          ? "Renames the matching \\begin and \\end pair under the cursor."
          : props.target.kind === "wrap-environment"
            ? "Wraps the current selection (or empty cursor) in \\begin{…}/\\end{…}."
            : "Use a simple name. Existing file extensions are kept when omitted.";
  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    await props.onRename(name.trim());
    setBusy(false);
  };
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="modal rename-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><Pencil size={19} /></div>
        <h2>{title}</h2>
        <p>{copy}</p>
        <label>
          Name
          <input
            autoFocus
            aria-label="New name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
              if (event.key === "Escape") props.onClose();
            }}
          />
        </label>
        {props.error && <p className="field-error" role="alert">{props.error}</p>}
        <div className="modal-actions">
          <button className="text-button" onClick={props.onClose}>Cancel</button>
          <button className="primary-button" disabled={busy || !name.trim()} onClick={() => void submit()}>{busy ? "Renaming…" : "Rename"}</button>
        </div>
      </div>
    </div>
  );
}

function ProjectMenu(props: {
  currentPath: string;
  recentProjects: RecentProject[];
  busyLabel: string | null;
  onRecent: (path: string) => void;
  onOpen: () => void;
  onNew: () => void;
  onExportZip: () => void;
}) {
  const alternatives = props.recentProjects.filter((item) => item.path !== props.currentPath);
  const busy = Boolean(props.busyLabel);
  return (
    <DropdownMenuContent align="start" sideOffset={6} className="w-72">
      <DropdownMenuLabel>Recent projects</DropdownMenuLabel>
      {alternatives.map((item) => (
        <DropdownMenuItem key={item.path} disabled={busy} onSelect={() => props.onRecent(item.path)}>
          <Folder />
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{item.name}</span>
            <span className="truncate text-xs text-muted-foreground">{item.path}</span>
          </span>
        </DropdownMenuItem>
      ))}
      {!alternatives.length && (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">No other recent projects yet.</p>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={props.onOpen}>
        <FolderOpen /> Open another folder <DropdownMenuShortcut>⌘O</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={props.onNew}><Plus /> New project</DropdownMenuItem>
      <DropdownMenuItem onSelect={props.onExportZip}><FileArchive /> Export ZIP</DropdownMenuItem>
      {props.busyLabel && (
        <p className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3 animate-spin" /> {props.busyLabel}
        </p>
      )}
    </DropdownMenuContent>
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
      className="panel-resizer"
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

function Navigator(props: {
  files: FileNode[];
  activeFile: string;
  activeAssetPath: string;
  protectedPaths: string[];
  papers: PaperSummary[];
  activePaper: PaperSummary | null;
  onFile: (path: string, line?: number) => void;
  onAsset: (path: string) => void;
  onBeginFigureDrag: (path: string, label: string, event: React.PointerEvent) => void;
  onCreateEntry: (path: string, kind: "file" | "folder") => Promise<void>;
  onDeleteEntry: (path: string) => void;
  onRenameEntry: (path: string, name: string) => void;
  onReveal: (path: string) => void;
  onRefresh: () => void;
  onImportAssets: (targetDirectory?: string) => void;
  assetDropTarget: string | null;
  assetImporting: boolean;
  onPaper: (paper: PaperSummary) => void;
  onCitePaper: (paper: PaperSummary, command: CiteCommand) => void;
  onFetchFullText: (paper: PaperSummary) => void;
  onAddBibEntry: () => void;
  onDiscoverLiterature: () => void;
  onDeletePaper: (paper: PaperSummary) => void;
  onRenamePaper: (paper: PaperSummary) => void;
  onEditBibEntry: (paper: PaperSummary) => void;
  importInput: string;
  setImportInput: (value: string) => void;
  onImport: () => void;
  importing: boolean;
}) {
  const navigatorRef = useRef<HTMLElement | null>(null);
  const [navigatorSplit, setNavigatorSplit] = useState(loadNavigatorSplit);
  const [entryFormOpen, setEntryFormOpen] = useState(false);
  const [entryPath, setEntryPath] = useState("");
  const [entryKind, setEntryKind] = useState<"file" | "folder">("file");
  const [entryBusy, setEntryBusy] = useState(false);
  const [citeMenuId, setCiteMenuId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ProjectSearchResult[]>([]);
  const [searchResultQuery, setSearchResultQuery] = useState("");
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    const query = searchQuery.trim();
    if (!query) return;
    let active = true;
    const timer = window.setTimeout(() => {
      if (!active) return;
      setSearching(true);
      void invoke<ProjectSearchResult[]>("search_project", { query })
        .then((results) => {
          if (active) {
            setSearchResults(results);
            setSearchResultQuery(query);
          }
        })
        .catch(() => {
          if (active) {
            setSearchResults([]);
            setSearchResultQuery(query);
          }
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [searchQuery]);
  const searchActive = Boolean(searchQuery.trim());
  const searchPending = searchActive && searchResultQuery !== searchQuery.trim();
  const visibleSearchResults = searchActive && searchResultQuery === searchQuery.trim() ? searchResults : [];
  const fileSearchResults = visibleSearchResults.filter((result) => result.kind === "file");
  const paperSearchResults = visibleSearchResults.filter((result) => result.kind === "paper");
  const paperResultCount = searchPending ? "…" : paperSearchResults.length;
  useEffect(() => {
    if (!citeMenuId) return;
    const close = () => setCiteMenuId(null);
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [citeMenuId]);
  const directoryForCreate = (path: string, kind: "project" | "directory" | "file") => {
    if (!path || kind === "project") return "";
    if (kind === "directory") return path;
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(0, slash) : "";
  };
  const openCreateForm = (kind: "file" | "folder", basePath = "", baseKind: "project" | "directory" | "file" = "project") => {
    const directory = directoryForCreate(basePath, baseKind);
    setEntryKind(kind);
    setEntryPath(directory ? `${directory}/` : "");
    setEntryFormOpen(true);
  };
  const closeEntryForm = () => {
    if (entryBusy) return;
    setEntryFormOpen(false);
    setEntryPath("");
  };
  const submitEntry = async () => {
    if (!entryPath.trim() || entryBusy) return;
    setEntryBusy(true);
    try {
      await props.onCreateEntry(entryPath.trim(), entryKind);
      setEntryPath("");
      setEntryFormOpen(false);
    } catch {
      // The workspace error banner explains why creation failed.
    } finally {
      setEntryBusy(false);
    }
  };
  // Wrap a tree/paper row with a Radix ContextMenu (right-click). The items are
  // computed from the row's target, matching the old hand-rolled menu.
  const renderItemContextMenu = (
    target: { path: string; label: string; kind: "project" | "directory" | "file"; paper?: PaperSummary },
    children: React.ReactElement,
  ) => {
    const { path, label, kind, paper } = target;
    const isProtected = props.protectedPaths.some((entry) => entry === path || path.startsWith(`${entry}/`));
    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent>
          {!paper && (
            <>
              <ContextMenuItem onSelect={() => openCreateForm("file", path, kind)}><FilePlus size={14} />New file</ContextMenuItem>
              <ContextMenuItem onSelect={() => openCreateForm("folder", path, kind)}><FolderPlus size={14} />New folder</ContextMenuItem>
            </>
          )}
          {(paper || path) && (
            <ContextMenuItem onSelect={() => (paper ? props.onRenamePaper(paper) : props.onRenameEntry(path, label))}>
              <Pencil size={14} />Rename
            </ContextMenuItem>
          )}
          {path && !paper && (
            <ContextMenuItem onSelect={() => void writeText(path)}><Copy size={14} />Copy path</ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => props.onReveal(path)}><FolderOpen size={14} />Show in Finder</ContextMenuItem>
          {path && !paper && !isProtected && (
            <ContextMenuItem variant="destructive" onSelect={() => props.onDeleteEntry(path)}><Trash2 size={14} />Delete</ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>
    );
  };
  const setSplitFromPointer = (clientY: number) => {
    const bounds = navigatorRef.current?.getBoundingClientRect();
    if (!bounds?.height) return navigatorSplit;
    const next = clamp((clientY - bounds.top) / bounds.height, 0.2, 0.78);
    setNavigatorSplit(next);
    return next;
  };
  const beginNavigatorSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    let latest = navigatorSplit;
    document.body.classList.add("resizing-navigator-split");
    const handleMove = (moveEvent: PointerEvent) => {
      latest = setSplitFromPointer(moveEvent.clientY);
    };
    const handleUp = () => {
      document.body.classList.remove("resizing-navigator-split");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      persistNavigatorSplit(latest);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };
  const nudgeNavigatorSplit = (delta: number) => {
    const next = clamp(navigatorSplit + delta, 0.2, 0.78);
    setNavigatorSplit(next);
    persistNavigatorSplit(next);
  };
  return (
    <aside
      ref={navigatorRef}
      className={`navigator ${props.assetDropTarget ? "asset-drag-active" : ""}`}
      style={{ gridTemplateRows: `minmax(100px, ${navigatorSplit}fr) 5px minmax(140px, ${1 - navigatorSplit}fr)` }}
    >
      <div className="navigator-section project-section" onPointerDown={(event) => {
        const target = event.target as Element;
        if (!target.closest(".project-entry-form") && !target.closest(".section-action")) closeEntryForm();
      }}>
        {renderItemContextMenu({ path: "", label: "Project folder", kind: "project" }, (
          <div className="section-heading">
            <span>Project</span>
            <div className="section-heading-actions">
              <Tip label="Refresh files">
                <button className="section-action" onClick={props.onRefresh}><RefreshCw size={13} strokeWidth={1.8} /></button>
              </Tip>
              <Tip label="Add file or folder">
                <button className="section-action" onClick={() => {
                  if (entryFormOpen) closeEntryForm();
                  else openCreateForm("file");
                }}><FolderPlus size={14} strokeWidth={1.8} /></button>
              </Tip>
            </div>
          </div>
        ))}
        <label className="navigator-search">
          <Search size={13} />
          <input aria-label="Filter project files and papers" placeholder="Filter files and papers" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} />
          {searchPending || searching ? <LoaderCircle className="spin" size={12} /> : searchActive && <button title="Clear search" onClick={() => setSearchQuery("")}><X size={12} /></button>}
        </label>
        {entryFormOpen && (
          <div className="project-entry-form" onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) closeEntryForm();
          }}>
            <select aria-label="Entry type" value={entryKind} onChange={(event) => setEntryKind(event.target.value as "file" | "folder")}>
              <option value="file">File</option>
              <option value="folder">Folder</option>
            </select>
            <input
              autoFocus
              aria-label="Project-relative path"
              placeholder={entryKind === "file" ? "sections/method.tex or notes.md" : "figures/results"}
              value={entryPath}
              onChange={(event) => setEntryPath(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitEntry();
                if (event.key === "Escape") closeEntryForm();
              }}
            />
            <button title="Create" disabled={entryBusy || !entryPath.trim()} onClick={() => void submitEntry()}>
              {entryBusy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
            </button>
          </div>
        )}
        <div className="file-tree">
          {searchActive ? fileSearchResults.map((result, index) => (
            <button
              key={`${result.path}:${result.line ?? 0}:${index}`}
              className="navigator-search-result"
              onClick={() => result.fileKind === "figure"
                ? props.onAsset(result.path)
                : props.onFile(result.path, result.line ?? undefined)}
            >
              {result.fileKind === "figure" ? <Image size={13} /> : <FileText size={13} />}
              <span>
                <strong>{result.title}</strong>
                <small>
                  {result.line ? `L${result.line} · ` : ""}
                  {result.snippet || result.path}
                </small>
              </span>
            </button>
          )) : props.files.map((node) => <TreeNode key={node.path} node={node} activeFile={props.activeFile} activeAssetPath={props.activeAssetPath} protectedPaths={props.protectedPaths} onFile={props.onFile} onAsset={props.onAsset} onBeginFigureDrag={props.onBeginFigureDrag} onDelete={props.onDeleteEntry} onImportAssets={props.onImportAssets} assetDropTarget={props.assetDropTarget} assetImporting={props.assetImporting} renderContextMenu={renderItemContextMenu} />)}
          {searchActive && !searchPending && !searching && !fileSearchResults.length && <p className="search-empty">No matching project files.</p>}
        </div>
      </div>
      <div
        className="navigator-split-resizer"
        role="separator"
        aria-label="Resize Project and Papers"
        aria-orientation="horizontal"
        aria-valuemin={20}
        aria-valuemax={78}
        aria-valuenow={Math.round(navigatorSplit * 100)}
        tabIndex={0}
        onPointerDown={beginNavigatorSplitResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") {
            event.preventDefault();
            nudgeNavigatorSplit(-0.03);
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            nudgeNavigatorSplit(0.03);
          }
        }}
      />
      <div className="navigator-section papers-section">
        <div className="section-heading">
          <span>Papers</span>
          <div className="section-heading-actions">
            <button className="section-action" title="Discover literature (OpenAlex)" aria-label="Discover literature" onClick={props.onDiscoverLiterature}>
              <Search size={14} strokeWidth={1.8} />
            </button>
            <button className="section-action" title="Add bibliography entry" aria-label="Add bibliography entry" onClick={props.onAddBibEntry}>
              <BookMarked size={14} strokeWidth={1.8} />
            </button>
            <span className="count-badge">{searchActive ? paperResultCount : props.papers.length}</span>
          </div>
        </div>
        <div className="paper-list" role="list" aria-label="Papers">
          {(searchActive ? paperSearchResults.map((result) => props.papers.find((paper) => paper.arxivId === result.arxivId)).filter((paper): paper is PaperSummary => Boolean(paper)) : props.papers).map((paper) => {
            const row = (
              <div className={`paper-row ${paper.hasFullText ? "" : "cited-only "}${props.activePaper && paperKey(props.activePaper) === paperKey(paper) ? "active" : ""}`}>
              <button
                title={paper.hasFullText
                  ? paper.title
                  : paper.arxivId
                    ? `Fetch the full text of arXiv ${paper.arxivId}`
                    : `${paper.title} — cited only, no full text available`}
                className="paper-open"
                // Knowing the preprint is as good as having it: clicking fetches.
                disabled={!paper.hasFullText && !paper.arxivId}
                onClick={() => paper.hasFullText ? props.onPaper(paper) : props.onFetchFullText(paper)}
              >
                {paper.hasFullText ? <BookOpen size={14} /> : paper.arxivId ? <Download size={14} /> : <BookMarked size={14} />}
                <span><strong>{paper.title}</strong><small>{paperSubtitle(paper, searchActive ? paperSearchResults.find((result) => result.arxivId === paper.arxivId)?.snippet : undefined)}</small></span>
              </button>
              {paper.citationKey && (
                <div className="cite-menu-wrap">
                  <button
                    className="row-cite"
                    title={`Insert citation for ${paper.citationKey}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      setCiteMenuId((current) => current === paperKey(paper) ? null : paperKey(paper));
                    }}
                  >
                    <Quote size={12} />
                  </button>
                  {citeMenuId === paperKey(paper) && (
                    <div className="cite-command-menu" onPointerDown={(event) => event.stopPropagation()}>
                      {CITE_COMMANDS.map((command) => (
                        <button
                          key={command}
                          type="button"
                          onClick={() => {
                            props.onCitePaper(paper, command);
                            setCiteMenuId(null);
                          }}
                        >
                          \{command}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {paper.citationKey && (
                <button className="row-edit-bib" title="Edit bibliography entry" onClick={() => props.onEditBibEntry(paper)}><Pencil size={12} /></button>
              )}
              <button className="row-delete" title={`Remove ${paper.title}`} onClick={() => props.onDeletePaper(paper)}><Trash2 size={12} /></button>
              </div>
            );
            // A cited-only paper has no local file to act on, so it stays bare;
            // one with full text gets the same right-click menu as a tree file.
            return (
              <Fragment key={paperKey(paper)}>
                {paper.hasFullText
                  ? renderItemContextMenu({ path: `.research/papers/${paper.arxivId}/paper.md`, label: paper.title, kind: "file", paper }, row)
                  : row}
              </Fragment>
            );
          })}
          {!searchActive && !props.papers.length && <p className="empty-note">Add an arXiv paper to ground the agent in project evidence.</p>}
          {searchActive && !searchPending && !searching && !paperSearchResults.length && <p className="search-empty">No matching papers.</p>}
        </div>
        <div className="import-box">
          <input
            placeholder="arXiv URL or id"
            value={props.importInput}
            onChange={(event) => props.setImportInput(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && props.onImport()}
          />
          <button onClick={props.onImport} disabled={props.importing || !props.importInput.trim()} title="Import paper">
            {props.importing ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}
          </button>
        </div>
      </div>
    </aside>
  );
}

function TreeNode({ node, activeFile, activeAssetPath, protectedPaths, onFile, onAsset, onBeginFigureDrag, onDelete, onImportAssets, assetDropTarget, assetImporting, renderContextMenu }: { node: FileNode; activeFile: string; activeAssetPath: string; protectedPaths: string[]; onFile: (path: string) => void; onAsset: (path: string) => void; onBeginFigureDrag: (path: string, label: string, event: React.PointerEvent) => void; onDelete: (path: string) => void; onImportAssets: (targetDirectory?: string) => void; assetDropTarget: string | null; assetImporting: boolean; renderContextMenu: (target: { path: string; label: string; kind: "project" | "directory" | "file" }, children: React.ReactElement) => React.ReactElement }) {
  const [open, setOpen] = useState(true);
  const protectedEntry = protectedPaths.some((path) => path === node.path || path.startsWith(`${node.path}/`));
  if (node.kind === "directory") {
    return (
      <div className={`tree-directory ${assetDropTarget === node.path ? "drop-target" : ""}`} data-drop-directory={node.path}>
        {renderContextMenu({ path: node.path, label: node.name, kind: "directory" }, (
          <div className="tree-row">
            <button className="tree-main" onClick={() => setOpen((value) => !value)}>
              <ChevronRight className={`tree-chevron ${open ? "open" : ""}`} size={13} />
              <Folder size={14} /> <span>{node.name}</span>
            </button>
            {node.path === "figures" && <button className="row-import" title="Import images into figures" disabled={assetImporting} onClick={() => onImportAssets(node.path)}>{assetImporting ? <LoaderCircle className="spin" size={12} /> : <ImagePlus size={12} />}</button>}
            {!protectedEntry && <button className="row-delete" title={`Delete ${node.path}`} onClick={() => onDelete(node.path)}><Trash2 size={12} /></button>}
          </div>
        ))}
        {assetDropTarget === node.path && <div className="asset-drop-hint">Drop images into {node.path}</div>}
        {open && <div className="tree-children">{node.children.map((child) => <TreeNode key={child.path} node={child} activeFile={activeFile} activeAssetPath={activeAssetPath} protectedPaths={protectedPaths} onFile={onFile} onAsset={onAsset} onBeginFigureDrag={onBeginFigureDrag} onDelete={onDelete} onImportAssets={onImportAssets} assetDropTarget={assetDropTarget} assetImporting={assetImporting} renderContextMenu={renderContextMenu} />)}</div>}
      </div>
    );
  }
  const Icon = node.kind === "tex" ? FileCode2 : node.kind === "bib" ? Library : File;
  if (node.kind === "figure") {
    return renderContextMenu({ path: node.path, label: node.name, kind: "file" }, (
      <div className={`tree-row asset-row ${activeAssetPath === node.path ? "active" : ""}`}>
        <button
          className="tree-main"
          title={`Preview ${node.name}; drag into the LaTeX editor to insert`}
          onClick={() => onAsset(node.path)}
          onPointerDown={(event) => onBeginFigureDrag(node.path, node.name, event)}
        ><span className="tree-spacer" /><Image size={14} /><span>{node.name}</span></button>
        {!protectedEntry && <button className="row-delete" title={`Delete ${node.path}`} onClick={() => onDelete(node.path)}><Trash2 size={12} /></button>}
      </div>
    ));
  }
  return renderContextMenu({ path: node.path, label: node.name, kind: "file" }, (
    <div className={`tree-row ${activeFile === node.path ? "active" : ""}`}>
      <button className="tree-main" onClick={() => onFile(node.path)}><span className="tree-spacer" /><Icon size={14} /><span>{node.name}</span></button>
      {!protectedEntry && <button className="row-delete" title={`Delete ${node.path}`} onClick={() => onDelete(node.path)}><Trash2 size={12} /></button>}
    </div>
  ));
}

function AgentToolRow({ step }: { step: AgentToolStep }) {
  return (
    <div className={`agent-tool-step ${step.phase}`}>
      <i aria-hidden="true" />
      <strong>{step.name}</strong>
      <span>{step.detail || (step.phase === "start" ? "running…" : "done")}</span>
    </div>
  );
}

/**
 * Map the agent's current status line to a thinking-orb animation, so the
 * orb reflects what the agent is actually doing (reading, editing, running a
 * command, …) rather than one generic spinner. Driven entirely by the status
 * string the backend already emits, so it needs no extra event plumbing.
 * Order matters: a path like "Editing search-panel.ts…" must read as editing,
 * not searching, so the write/edit test runs before the read/search one.
 */
function statusToOrbState(status: string): OrbState {
  const s = status.toLowerCase();
  if (/edit|writ|compos/.test(s)) return "composing";
  if (/compress/.test(s)) return "shaping";
  if (/run|command|bash|compil|retry/.test(s)) return "solving";
  if (/read|search|find|review|discover|literatur|fetch|grep|look/.test(s)) return "searching";
  return "working";
}

function AgentPanel({
  agentCommands,
  katexMacros,
  messages,
  sessions,
  activeSession,
  sessionMenuOpen,
  setSessionMenuOpen,
  onNewSession,
  onOpenSession,
  onDeleteSession,
  onEditMessage,
  input,
  setInput,
  provider,
  setProvider,
  model,
  setModel,
  reasoningEffort,
  setReasoningEffort,
  running,
  streaming,
  status,
  cancellable,
  stopping,
  onSend,
  onStop,
  onApiSettings,
  selection,
  selectionSource,
  onClearSelection,
  branchSource,
  onCancelBranch,
  mentions,
  chatEnd,
}: {
  agentCommands: AgentCommand[];
  katexMacros: Record<string, string>;
  messages: ChatMessage[];
  sessions: AgentSessionSummary[];
  activeSession: AgentSession | null;
  sessionMenuOpen: boolean;
  setSessionMenuOpen: (value: boolean) => void;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onEditMessage: (message: ChatMessage) => void;
  input: string;
  setInput: (value: string) => void;
  provider: AgentProvider;
  setProvider: (value: AgentProvider) => void;
  model: string;
  setModel: (value: string) => void;
  reasoningEffort: ReasoningEffort;
  setReasoningEffort: (value: ReasoningEffort) => void;
  running: boolean;
  streaming: boolean;
  status: string;
  cancellable: boolean;
  stopping: boolean;
  onSend: () => void;
  onStop: () => void;
  onApiSettings: () => void;
  selection: string;
  selectionSource: "editor" | "pdf" | null;
  onClearSelection: () => void;
  branchSource: { sessionId: string; messageId: string } | null;
  onCancelBranch: () => void;
  mentions: AgentMention[];
  chatEnd: React.RefObject<HTMLDivElement | null>;
}) {
  const options = modelOptions(provider);
  const efforts = options.find((option) => option.value === model)?.efforts ?? ["high"];
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const [sessionSearch, setSessionSearch] = useState("");
  const [searchResults, setSearchResults] = useState<AgentSessionSearchResult[] | null>(null);
  const [mention, setMention] = useState<MentionState | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const copyResetTimer = useRef<number | null>(null);
  const copyMessage = async (message: ChatMessage) => {
    try {
      await writeText(message.text);
      setCopiedMessageId(message.id);
      if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
      copyResetTimer.current = window.setTimeout(() => setCopiedMessageId(null), 1400);
    } catch {
      setCopiedMessageId(null);
    }
  };
  useEffect(() => () => {
    if (copyResetTimer.current !== null) window.clearTimeout(copyResetTimer.current);
  }, []);
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = "0px";
    const height = clamp(composer.scrollHeight, 44, 160);
    composer.style.height = `${height}px`;
    composer.style.overflowY = composer.scrollHeight > 160 ? "auto" : "hidden";
  }, [input]);
  // The conversation history is a Radix Popover now, which handles outside-click
  // and Escape dismissal itself — no manual window listeners needed.
  useEffect(() => {
    const query = sessionSearch.trim();
    if (!sessionMenuOpen || !query) return;
    const timer = window.setTimeout(() => {
      void invoke<AgentSessionSearchResult[]>("search_agent_sessions", { query })
        .then(setSearchResults)
        .catch(() => setSearchResults([]));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [sessionMenuOpen, sessionSearch]);
  const visibleSessions: AgentSessionSearchResult[] = sessionSearch.trim() && searchResults
    ? searchResults
    : sessions.map((session) => ({ ...session, snippet: "" }));
  const mentionSuggestions = mention
    ? mentions
      .filter((item) => `${item.label} ${item.path}`.toLowerCase().includes(mention.query.toLowerCase()))
      .slice(0, 8)
    : [];
  const slashSuggestions = slash ? filterSlashCommands(agentCommands, slash.query).slice(0, 8) : [];
  const insertSlashCommand = (command: AgentCommand) => {
    if (!slash) return;
    const { value, caret } = applySlashCommand(input, slash, command);
    setInput(value);
    setSlash(null);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(caret, caret);
    });
  };
  const insertMention = (item: AgentMention) => {
    if (!mention) return;
    const inserted = `@${item.path}`;
    const next = `${input.slice(0, mention.start)}${inserted} ${input.slice(mention.end)}`;
    const caret = mention.start + inserted.length + 1;
    setInput(next);
    setMention(null);
    requestAnimationFrame(() => {
      composerRef.current?.focus();
      composerRef.current?.setSelectionRange(caret, caret);
    });
  };
  return (
    <section className="agent-panel">
      <div className="agent-header">
        <div className="agent-conversation-controls">
          <Popover open={sessionMenuOpen} onOpenChange={setSessionMenuOpen}>
            <PopoverTrigger asChild>
              <button className="agent-title" title="Conversation history">
                <Bot size={16} /><span>{compactConversationTitle(activeSession?.title ?? "Writing agent")}</span><ChevronDown size={12} />
              </button>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="session-popover">
              <div className="session-menu-heading"><span>Conversations</span><button onClick={onNewSession}><Plus size={13} /> New</button></div>
              <label className="session-search"><Search size={12} /><input aria-label="Search conversations" value={sessionSearch} onChange={(event) => { setSessionSearch(event.target.value); setSearchResults(null); }} placeholder="Search conversations…" /></label>
              <div className="session-list">
                {visibleSessions.map((session) => (
                  <div key={session.id} className={session.id === activeSession?.id ? "active" : ""}>
                    <button className="session-open" onClick={() => onOpenSession(session.id)}>
                      <strong>{compactConversationTitle(session.title)}</strong>
                      <small>{modelLabel(session.provider, session.model || defaultModel(session.provider))} · {session.messageCount} messages · {relativeTime(session.updatedAt)}</small>
                      {session.snippet && <small className="session-snippet">{session.snippet}</small>}
                    </button>
                    <button className="session-delete" title="Delete conversation" disabled={running} onClick={() => onDeleteSession(session.id)}><Trash2 size={12} /></button>
                  </div>
                ))}
                {!visibleSessions.length && <p className="session-empty">No conversations found.</p>}
              </div>
            </PopoverContent>
          </Popover>
          <Tip label="New conversation">
            <button className="new-conversation-button" disabled={running} onClick={onNewSession}><Plus size={14} /></button>
          </Tip>
        </div>
        <div className="provider-controls">
          <Select value={provider} disabled={running} onValueChange={(value) => setProvider(value as AgentProvider)}>
            <SelectTrigger aria-label="Agent provider" className="provider-select"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem value="codex">Codex subscription</SelectItem>
              <SelectItem value="claude">Claude subscription</SelectItem>
              <SelectItem value="openai-api">OpenAI API</SelectItem>
              <SelectItem value="anthropic-api">Anthropic API</SelectItem>
            </SelectContent>
          </Select>
          {(provider === "openai-api" || provider === "anthropic-api") && (
            <Tip label="API key settings">
              <button onClick={onApiSettings}><KeyRound size={14} /></button>
            </Tip>
          )}
        </div>
      </div>
      <div className="agent-config-bar">
        <div className="config-pill">
          <span>Model</span>
          <Select value={model} disabled={running} onValueChange={(nextModel) => {
            const nextEfforts = options.find((option) => option.value === nextModel)?.efforts ?? ["high"];
            setModel(nextModel);
            if (!nextEfforts.includes(reasoningEffort)) setReasoningEffort(nextEfforts.includes("high") ? "high" : nextEfforts[0]);
          }}>
            <SelectTrigger aria-label="Agent model" className="config-select"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" align="start">
              {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="config-pill">
          <span>Effort</span>
          <Select value={reasoningEffort} disabled={running} onValueChange={(value) => setReasoningEffort(value as ReasoningEffort)}>
            <SelectTrigger aria-label="Reasoning effort" className="config-select"><SelectValue /></SelectTrigger>
            <SelectContent position="popper" align="start">
              {efforts.map((effort) => <SelectItem key={effort} value={effort}>{effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="chat-list">
        {messages.map((message, index) => {
        // The turn in progress: its text may still grow and its tool calls may
        // still be running, so it is not copyable yet.
        const inFlight = running && message.role === "agent" && index === messages.length - 1;
        return (
          <div key={message.id} className={`chat-message ${message.role} ${streaming && index === messages.length - 1 && message.role === "agent" ? "streaming" : ""}`}>
            {message.role === "agent" && <div className="message-avatar"><Sparkles size={13} /></div>}
            <div className="message-column">
              <div className="message-body">
                {message.role !== "agent"
                  ? <p>{message.text}</p>
                  : (message.parts?.length
                    ? message.parts.map((part, partIndex) => (part.kind === "text"
                      ? <ChatMarkdown
                          key={partIndex}
                          text={part.text}
                          macros={katexMacros}
                          // Only the run being written now shows the caret.
                          className={streaming && index === messages.length - 1 && partIndex === message.parts!.length - 1 ? "streaming-tail" : undefined}
                        />
                      : <AgentToolRow key={part.id} step={part} />))
                    : <ChatMarkdown text={message.text} macros={katexMacros} />)}
                {!!message.skills?.length && <div className="skills-used"><small>Skills</small>{message.skills.map((skill) => <span key={skill}>{skill}</span>)}</div>}
                {message.role === "agent" && (!isConversationWelcome(message, index) || !!message.files?.length) && <div className="agent-message-meta">
                  {!!message.files?.length && <div className="changed-files">{message.files.map((file) => <span key={file}><FileCode2 size={11} />{file}</span>)}</div>}
                  {!isConversationWelcome(message, index) && !inFlight && <button className="agent-message-copy" title="Copy agent response" onClick={() => void copyMessage(message)}>
                    {copiedMessageId === message.id ? <Check size={11} /> : <Copy size={11} />}
                  </button>}
                </div>}
              </div>
              {message.role === "user" && <div className="message-actions user-message-actions">
                <button className="message-copy" title="Copy user message" onClick={() => void copyMessage(message)}>
                  {copiedMessageId === message.id ? <Check size={11} /> : <Copy size={11} />}
                </button>
                <button className="message-edit" title="Edit and branch from this message" disabled={running} onClick={() => onEditMessage(message)}><Pencil size={11} /> Edit</button>
              </div>}
            </div>
          </div>
        );
        })}
        {running && !streaming && (
          // Same turn as the reply above it, so no second avatar and no full
          // message gap — it reads as a continuation, not a new speaker.
          <div className="chat-message agent thinking-row">
            <div className="message-avatar-spacer" aria-hidden="true" />
            <div className="thinking"><ThinkingOrb state={statusToOrbState(status)} size={20} /><em>{status || (provider === "claude" ? "Claude is writing…" : "Agent is writing…")}</em></div>
          </div>
        )}
        <div ref={chatEnd} />
      </div>
      <div className="composer-wrap">
        {branchSource && <div className="context-chip branch-chip"><Pencil size={11} /> Editing an earlier message creates a new branch <button title="Cancel conversation branch" onClick={onCancelBranch}><X size={11} /></button></div>}
        {selection && (
          <div className="context-chip">
            {selectionSource === "pdf" ? <FileText size={12} /> : <Code2 size={12} />}
            {selectionSource === "pdf" ? "PDF selection" : "Selection"} · {selection.length} chars
            <button type="button" title="Clear selection context" onClick={onClearSelection}><X size={11} /></button>
          </div>
        )}
        {slash && (
          <div className="mention-menu" role="listbox" aria-label="Agent commands">
            <div className="mention-heading"><span>Agent commands</span><small>{slashSuggestions.length ? "↑↓ to navigate · Enter to insert" : "No matches"}</small></div>
            {slashSuggestions.map((command, index) => (
              <button
                key={command.name}
                role="option"
                aria-selected={index === slashIndex}
                className={index === slashIndex ? "active" : ""}
                onMouseDown={(event) => { event.preventDefault(); insertSlashCommand(command); }}
              >
                <TerminalSquare size={13} />
                <span><strong>/{command.name}{command.hint ? ` ${command.hint}` : ""}</strong><small>{command.description}</small></span>
              </button>
            ))}
          </div>
        )}
        {mention && (
          <div className="mention-menu" role="listbox" aria-label="Project references">
            <div className="mention-heading"><span>Reference project context</span><small>{mentionSuggestions.length ? "↑↓ to navigate · Enter to insert" : "No matches"}</small></div>
            {mentionSuggestions.map((item, index) => (
              <button
                key={item.key}
                role="option"
                aria-selected={index === mentionIndex}
                className={index === mentionIndex ? "active" : ""}
                onMouseDown={(event) => { event.preventDefault(); insertMention(item); }}
              >
                {item.kind === "paper" ? <BookOpen size={13} /> : <FileCode2 size={13} />}
                <span><strong>{item.label}</strong><small>{item.path}</small></span>
              </button>
            ))}
          </div>
        )}
        <div className="composer">
          <textarea
            ref={composerRef}
            rows={1}
            placeholder="Ask the agent to write, revise, or reason…"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setMention(mentionAtCaret(event.target.value, event.target.selectionStart));
              setMentionIndex(0);
              setSlash(slashAtCaret(event.target.value, event.target.selectionStart));
              setSlashIndex(0);
            }}
            onSelect={(event) => {
              setMention(mentionAtCaret(event.currentTarget.value, event.currentTarget.selectionStart));
              setSlash(slashAtCaret(event.currentTarget.value, event.currentTarget.selectionStart));
            }}
            onBlur={() => { setMention(null); setSlash(null); }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process") return;
              if (slash && slashSuggestions.length) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setSlashIndex((index) => (index + 1) % slashSuggestions.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setSlashIndex((index) => (index - 1 + slashSuggestions.length) % slashSuggestions.length);
                  return;
                }
                // Enter still sends: a fully typed command should not need a
                // second keystroke just because the menu is open.
                if (event.key === "Tab") {
                  event.preventDefault();
                  insertSlashCommand(slashSuggestions[Math.min(slashIndex, slashSuggestions.length - 1)]);
                  return;
                }
              }
              if (event.key === "Escape" && slash) {
                event.preventDefault();
                setSlash(null);
                return;
              }
              if (mention && mentionSuggestions.length) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionIndex((index) => (index + 1) % mentionSuggestions.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionIndex((index) => (index - 1 + mentionSuggestions.length) % mentionSuggestions.length);
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  insertMention(mentionSuggestions[Math.min(mentionIndex, mentionSuggestions.length - 1)]);
                  return;
                }
              }
              if (event.key === "Escape" && mention) {
                event.preventDefault();
                setMention(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                setMention(null);
                setSlash(null);
                onSend();
              }
            }}
          />
          <div className="composer-footer">
            <span>{running ? status || "Agent is working…" : "Enter sends · Shift+Enter adds a line"}</span>
            {running
              ? <button className="stop-agent-button" title={stopping ? "Stopping agent" : "Stop agent"} onClick={onStop} disabled={!cancellable || stopping}><Square size={12} fill="currentColor" /></button>
              : <button title="Send message" onClick={() => { setMention(null); setSlash(null); onSend(); }} disabled={!input.trim()}><Send size={14} /></button>}
          </div>
        </div>
      </div>
    </section>
  );
}

function buildAgentMentions(files: FileNode[], papers: PaperSummary[]): AgentMention[] {
  const mentions: AgentMention[] = [];
  const visit = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.kind === "directory") visit(node.children);
      else mentions.push({ key: `file:${node.path}`, label: node.name, path: node.path, kind: "file" });
    }
  };
  visit(files);
  for (const paper of papers) {
    mentions.push({
      key: `paper:${paper.arxivId}`,
      label: paper.title,
      path: `.research/papers/${paper.arxivId}/paper.md`,
      kind: "paper",
    });
  }
  return mentions;
}

function mentionAtCaret(value: string, caret: number): MentionState | null {
  const beforeCaret = value.slice(0, caret);
  const at = beforeCaret.lastIndexOf("@");
  if (at < 0 || /\s/.test(beforeCaret.slice(at + 1))) return null;
  if (at > 0 && !/\s|[([{"'`]/.test(beforeCaret[at - 1])) return null;
  return { start: at, end: caret, query: beforeCaret.slice(at + 1) };
}

function CanvasToolbar(props: {
  mode: CanvasMode;
  setMode: (mode: DocumentViewMode) => void;
  activePath: string;
  activeKind: "document" | "paper" | "asset";
  dirty: boolean;
  canForwardSync: boolean;
  locatingPdf: boolean;
  canNavigateBack: boolean;
  canNavigateForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  onInsert: () => void;
  onCollab: () => void;
  collabLive: boolean;
  collabPeers: number;
  onForwardSync: () => void;
  onHistory: () => void;
  onGit: () => void;
  commentCount: number;
  onComments: () => void;
}) {
  const ActiveIcon = props.activeKind === "asset" ? Image : props.activeKind === "paper" ? BookOpen : FileCode2;
  const switcherMode = props.mode === "dual" || props.mode === "columns" ? "split" : props.mode;
  return (
    <div className="canvas-toolbar">
      <div className="active-document"><ActiveIcon size={14} /><span>{props.activePath}</span>{props.activeKind === "document" && props.dirty && <i />}</div>
      <div className="view-switcher">
        {([
          { id: "source" as const, label: "source", title: "Source only" },
          { id: "split" as const, label: "split", title: "Source and PDF" },
          { id: "pdf" as const, label: "pdf", title: "PDF only" },
        ]).map((mode) => (
          <button
            key={mode.id}
            className={switcherMode === mode.id ? "active" : ""}
            title={mode.title}
            onClick={() => props.setMode(mode.id)}
          >
            {mode.label}
          </button>
        ))}
      </div>
      <div className="canvas-actions">
        {props.activeKind === "document" && (
          <>
            <Tip label="Go back (⌘[)">
              <button type="button" disabled={!props.canNavigateBack} onClick={props.onNavigateBack}>
                <Undo2 size={14} />
              </button>
            </Tip>
            <Tip label="Go forward (⌘])">
              <button type="button" disabled={!props.canNavigateForward} onClick={props.onNavigateForward}>
                <Redo2 size={14} />
              </button>
            </Tip>
            <Tip label="Insert snippet or symbol (⌘⇧I)">
              <button type="button" onClick={props.onInsert}>
                <Omega size={14} />
              </button>
            </Tip>
            <Tip label="Editor comments">
              <button
                type="button"
                className={props.commentCount ? "active" : ""}
                onClick={props.onComments}
              >
                <MessageSquareText size={14} />
                {props.commentCount > 0 ? <em className="collab-peer-badge">{props.commentCount}</em> : null}
              </button>
            </Tip>
            <Tip label={props.collabLive
              ? (props.collabPeers > 0
                ? `Live · ${props.collabPeers} other${props.collabPeers === 1 ? "" : "s"}`
                : "Live collaboration · just you")
              : "Live collaboration"}
            >
              <button
                type="button"
                className={props.collabLive ? "active collab-toolbar-button" : "collab-toolbar-button"}
                onClick={props.onCollab}
              >
                <Radio size={14} />
                {props.collabLive ? <em className="collab-peer-badge">{props.collabPeers}</em> : null}
              </button>
            </Tip>
            <Tip label="Reveal cursor in PDF (⌘⇧J)">
              <button disabled={!props.canForwardSync || props.locatingPdf} onClick={props.onForwardSync}>
                {props.locatingPdf ? <LoaderCircle className="spin" size={14} /> : <LocateFixed size={14} />}
              </button>
            </Tip>
          </>
        )}
        <Tip label="Git status and commit">
          <button className="history-button" onClick={props.onGit}>
            <GitBranch size={14} />
          </button>
        </Tip>
        <Tip label="Project history">
          <button className="history-button" onClick={props.onHistory}>
            <History size={14} />
          </button>
        </Tip>
      </div>
    </div>
  );
}

// Papers ride in the same `openTabs` string[] as files. A paper's tab key is
// its full-text path — unambiguous, since only papers live under this prefix.
const PAPER_TAB_PREFIX = ".research/papers/";
const PAPER_TAB_SUFFIX = "/paper.md";
function isPaperTabKey(key: string): boolean {
  return key.startsWith(PAPER_TAB_PREFIX) && key.endsWith(PAPER_TAB_SUFFIX);
}
function paperTabKey(arxivId: string): string {
  return `${PAPER_TAB_PREFIX}${arxivId}${PAPER_TAB_SUFFIX}`;
}
function arxivIdFromTabKey(key: string): string {
  return key.slice(PAPER_TAB_PREFIX.length, key.length - PAPER_TAB_SUFFIX.length);
}

/**
 * Full text imported with `arxiv2md --frontmatter` leads with a YAML block; the
 * reader shows the title from metadata, so drop the raw YAML rather than render
 * it as a stray `<hr>` + text. A no-op for older papers without frontmatter.
 */
function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---")) return markdown;
  const end = markdown.indexOf("\n---", 3);
  if (end === -1) return markdown;
  const after = markdown.indexOf("\n", end + 1);
  return after === -1 ? "" : markdown.slice(after + 1).replace(/^\s+/, "");
}

function DocumentCanvas(props: {
  mode: CanvasMode;
  source: string;
  activeFile: string;
  secondaryFile: string | null;
  secondarySource: string;
  setSecondarySource: (value: string) => void;
  focusedPane: EditorPaneId;
  onFocusPane: (pane: EditorPaneId) => void;
  setSource: (value: string) => void;
  setSelection: (value: string) => void;
  onPdfTextSelect: (value: string) => void;
  pdfUrl: string | null;
  pdfBase64: string | null;
  paperMarkdown: string;
  paperBlog: string | null;
  paperView: "blog" | "fulltext";
  onSetPaperView: (view: "blog" | "fulltext") => void;
  activePaper: PaperSummary | null;
  activeAsset: AssetPreview | null;
  citationKeys: string[];
  citations: CitationInfo[];
  references: ReferenceInfo[];
  unusedLabels: string[];
  unusedCitations: string[];
  onLoadReferenceImage: (path: string) => Promise<string | null>;
  onEditorLeave: () => void;
  onPrepareFigure: (path: string) => Promise<string | null>;
  onPasteImageFile: (file: File) => boolean | void;
  nativeFigureDropActive: boolean;
  figurePointerPosition: { x: number; y: number } | null;
  figureDropRequest: FigureDropRequest | null;
  onFigureDropHandled: (id: string) => void;
  editorNavigation: EditorNavigation | null;
  onEditorNavigationHandled: (id: string) => void;
  onEditorPosition: (position: EditorPosition) => void;
  onViewState: (path: string, state: EditorViewState) => void;
  viewRestore: { path: string; cursor: number; scrollTop: number; id: string } | null;
  onViewRestoreHandled: (id: string) => void;
  onGotoDefinition: (target: DefinitionTarget) => void;
  onTexlabGoto: (path: string, line: number, column?: number) => void;
  onFindReferences: (target: SymbolTarget) => void;
  onRenameSymbol: (target: SymbolTarget) => void;
  onRenameEnvironment: (name: string) => void;
  onWrapEnvironment: () => void;
  envRenameRequest: { newName: string; id: string } | null;
  onEnvRenameHandled: (id: string) => void;
  wrapEnvRequest: { name: string; id: string } | null;
  onWrapEnvHandled: (id: string) => void;
  localMacros: { label: string; detail: string; type: "keyword" | "type" }[];
  katexMacros: Record<string, string>;
  onGotoLineRequest: () => void;
  outlineOpen: boolean;
  onOutlineOpenChange: (open: boolean) => void;
  outlineNodes: OutlineNode[];
  activeOutlineId: string | null;
  onOutlineNavigate: (path: string, line: number) => void;
  insertOpen: boolean;
  onInsertOpenChange: (open: boolean) => void;
  tableGeneratorOpen: boolean;
  onTableGeneratorOpenChange: (open: boolean) => void;
  editorKeymap: EditorKeymap;
  editorSpellcheck: boolean;
  citeInsertRequest: { key: string; command: InsertSymbolCommand; id: string } | null;
  onCiteInsertHandled: (id: string) => void;
  projectPaths: string[];
  graphicsRoots: string[];
  buildDiagnostics: CompileDiagnostic[];
  texlabDiagnostics: CompileDiagnostic[];
  pdfSyncTarget: PdfSyncTarget | null;
  onPdfSource: (page: number, x: number, y: number) => void;
  pdfMarks: PdfMark[];
  activePdfMarkId: string | null;
  onCreatePdfMark?: (mark: PdfMark) => void;
  onSelectPdfMark?: (mark: PdfMark) => void;
  onOpenPdfMarks?: () => void;
  editorComments: EditorComment[];
  activeEditorCommentId: string | null;
  commentAuthorName: string;
  commentAuthorId: string;
  onCreateEditorComment: (comment: EditorComment) => void;
  onOpenEditorComments: () => void;
  onResolveEditorComment: (id: string) => void;
  onReplyEditorComment: (commentId: string) => void;
  commentFocusRequest: { id: string; nonce: string } | null;
  onCommentFocusHandled: (nonce: string) => void;
  todoCount: number;
  onOpenTodos: () => void;
  projectWordCount: WordCount | null;
  onPdfPageCount: (pages: number | null) => void;
  onCreateMissingFile: (path: string) => void;
  collabExtensions: Extension[];
  collabEditorKey: string;
}) {
  const {
    activeFile,
    secondaryFile,
    secondarySource,
    setSecondarySource,
    focusedPane,
    onFocusPane,
    buildDiagnostics,
    texlabDiagnostics,
    citeInsertRequest,
    collabEditorKey,
    collabExtensions,
    editorKeymap,
    editorNavigation,
    editorSpellcheck,
    envRenameRequest,
    figureDropRequest,
    insertOpen,
    localMacros,
    katexMacros,
    onCiteInsertHandled,
    onEditorNavigationHandled,
    onEditorPosition,
    onEnvRenameHandled,
    onFigureDropHandled,
    onFindReferences,
    onGotoDefinition,
    onTexlabGoto,
    onGotoLineRequest,
    onInsertOpenChange,
    onOutlineNavigate,
    onOutlineOpenChange,
    onPrepareFigure,
    onPasteImageFile,
    onCreateMissingFile,
    onRenameEnvironment,
    onRenameSymbol,
    onTableGeneratorOpenChange,
    onViewRestoreHandled,
    onViewState,
    onWrapEnvHandled,
    onWrapEnvironment,
    activeOutlineId,
    outlineNodes,
    outlineOpen,
    projectPaths,
    graphicsRoots,
    setSource,
    source: editorSource,
    tableGeneratorOpen,
    viewRestore,
    wrapEnvRequest,
    editorComments,
    commentAuthorName,
    commentAuthorId,
    onCreateEditorComment,
    onOpenEditorComments,
    commentFocusRequest,
    onCommentFocusHandled,
  } = props;
  const splitRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const primaryViewRef = useRef<EditorView | null>(null);
  const secondaryViewRef = useRef<EditorView | null>(null);
  const lastInsertionPositionRef = useRef(0);
  const pendingFigureCursorRef = useRef<number | null>(null);
  const [splitRatio, setSplitRatio] = useState(loadSplitRatio);
  const [columnsPdfRatio, setColumnsPdfRatio] = useState(loadColumnsPdfRatio);
  const [figureDropActive, setFigureDropActive] = useState(false);
  const [figureDropMarker, setFigureDropMarker] = useState<{ top: number; line: number } | null>(null);
  const [cursorOffset, setCursorOffset] = useState(0);
  const [statusPosition, setStatusPosition] = useState({ line: 1, column: 0 });
  const [snippetStops, setSnippetStops] = useState<{ base: number; stops: { from: number; to: number }[] } | null>(null);
  const [figureInsertPending, setFigureInsertPending] = useState<{
    paths: string[];
    position: number;
  } | null>(null);
  const [commentComposer, setCommentComposer] = useState<{
    from: number;
    to: number;
    quote: string;
    body: string;
  } | null>(null);
  const focusedPath = focusedPane === "secondary" && secondaryFile ? secondaryFile : activeFile;
  const focusedSource = focusedPane === "secondary" && secondaryFile ? secondarySource : editorSource;
  const wordCount = useMemo(() => countWords(focusedSource), [focusedSource]);
  const [selectedText, setSelectedText] = useState("");
  const selectionStats = useMemo(() => textStats(selectedText), [selectedText]);
  const commentsForActiveFile = useMemo(
    () => editorComments.filter((comment) => comment.path === activeFile),
    [activeFile, editorComments],
  );
  const commentsForActiveFileRef = useRef(commentsForActiveFile);
  commentsForActiveFileRef.current = commentsForActiveFile;
  const resolveEditorCommentRef = useRef(props.onResolveEditorComment);
  resolveEditorCommentRef.current = props.onResolveEditorComment;
  const replyEditorCommentRef = useRef(props.onReplyEditorComment);
  replyEditorCommentRef.current = props.onReplyEditorComment;

  const latexLiveRef = useRef({
    citationKeys: props.citationKeys,
    citations: props.citations,
    references: props.references,
    unusedLabels: props.unusedLabels,
    unusedCitations: props.unusedCitations,
    localMacros,
    graphicsRoots,
    projectPaths,
  });
  latexLiveRef.current = {
    citationKeys: props.citationKeys,
    citations: props.citations,
    references: props.references,
    unusedLabels: props.unusedLabels,
    unusedCitations: props.unusedCitations,
    localMacros,
    graphicsRoots,
    projectPaths,
  };

  const diagnosticsRef = useRef({ build: buildDiagnostics, texlab: texlabDiagnostics });
  diagnosticsRef.current = { build: buildDiagnostics, texlab: texlabDiagnostics };

  const focusedPaneRef = useRef(focusedPane);
  focusedPaneRef.current = focusedPane;
  const activeFileRefEditor = useRef(activeFile);
  activeFileRefEditor.current = activeFile;
  const secondaryFileRefEditor = useRef(secondaryFile);
  secondaryFileRefEditor.current = secondaryFile;
  const setSourceRef = useRef(props.setSource);
  setSourceRef.current = props.setSource;
  const setSelectionRef = useRef(props.setSelection);
  setSelectionRef.current = props.setSelection;
  const setSecondarySourceRef = useRef(setSecondarySource);
  setSecondarySourceRef.current = setSecondarySource;
  const reportEditorPositionRef = useRef<(view: EditorView, path: string) => void>(() => {});
  // reportEditorPosition is assigned below after its useCallback.

  const collabLive = collabExtensions.length > 0;
  const mountSourceRef = useRef(props.source);
  const prevCollabEditorKeyRef = useRef(collabEditorKey);
  if (prevCollabEditorKeyRef.current !== collabEditorKey) {
    prevCollabEditorKeyRef.current = collabEditorKey;
    mountSourceRef.current = props.source;
  }

  // Stable callbacks — @uiw/react-codemirror reconfigures (destroying yCollab +
  // comment fields) whenever onUpdate/onChange identity changes.
  const onPrimaryChange = useCallback((value: string) => {
    setSourceRef.current(value);
  }, []);
  const onPrimaryUpdate = useCallback((viewUpdate: { state: EditorView["state"]; view: EditorView }) => {
    if (focusedPaneRef.current !== "primary") return;
    const range = viewUpdate.state.selection.main;
    lastInsertionPositionRef.current = range.head;
    const nextSelection = range.empty ? "" : viewUpdate.state.sliceDoc(range.from, range.to);
    setSelectionRef.current(nextSelection);
    setSelectedText(nextSelection);
    if (range.empty) setCommentComposer(null);
    reportEditorPositionRef.current?.(viewUpdate.view, activeFileRefEditor.current);
  }, []);
  const onSecondaryChange = useCallback((value: string) => {
    setSecondarySourceRef.current(value);
  }, []);
  const onSecondaryUpdate = useCallback((viewUpdate: { state: EditorView["state"]; view: EditorView }) => {
    if (focusedPaneRef.current !== "secondary") return;
    const range = viewUpdate.state.selection.main;
    lastInsertionPositionRef.current = range.head;
    const nextSelection = range.empty ? "" : viewUpdate.state.sliceDoc(range.from, range.to);
    setSelectionRef.current(nextSelection);
    setSelectedText(nextSelection);
    const path = secondaryFileRefEditor.current;
    if (path) reportEditorPositionRef.current?.(viewUpdate.view, path);
  }, []);

  useEffect(() => {
    const view = primaryViewRef.current;
    if (!view) return;
    view.dispatch({ effects: setEditorCommentsEffect.of(commentsForActiveFile) });
  }, [commentsForActiveFile, collabEditorKey]);

  useEffect(() => {
    if (!commentFocusRequest) return;
    const comment = editorComments.find((item) => item.id === commentFocusRequest.id);
    if (!comment || comment.path !== activeFile) return;
    const view = primaryViewRef.current;
    if (!view) return;
    const range = resolveCommentRange(view.state.doc.toString(), comment);
    if (!range) {
      onCommentFocusHandled(commentFocusRequest.nonce);
      return;
    }
    view.dispatch({
      selection: { anchor: range.from, head: range.to },
      effects: EditorView.scrollIntoView(range.from, { y: "center" }),
    });
    view.focus();
    onCommentFocusHandled(commentFocusRequest.nonce);
  }, [activeFile, commentFocusRequest, editorComments, onCommentFocusHandled]);

  const openCommentComposer = useCallback(() => {
    const view = editorViewRef.current;
    if (!view || !activeFile) return;
    const range = view.state.selection.main;
    if (range.empty) return;
    const quote = view.state.sliceDoc(range.from, range.to);
    if (!quote.trim()) return;
    setCommentComposer({
      from: range.from,
      to: range.to,
      quote,
      body: "",
    });
  }, [activeFile]);

  const saveCommentComposer = useCallback(() => {
    if (!commentComposer || !activeFile) return;
    const comment = createEditorComment({
      path: activeFile,
      source: editorSource,
      from: commentComposer.from,
      to: commentComposer.to,
      body: commentComposer.body,
      authorId: commentAuthorId,
      authorName: commentAuthorName,
    });
    if (!comment) return;
    onCreateEditorComment(comment);
    setCommentComposer(null);
  }, [activeFile, commentAuthorId, commentAuthorName, commentComposer, editorSource, onCreateEditorComment]);
  const breadcrumb = useMemo(
    () => (focusedPath.endsWith(".tex")
      ? sectionBreadcrumbNodes(focusedSource, statusPosition.line, focusedPath)
      : []),
    [focusedPath, focusedSource, statusPosition.line],
  );
  const reportEditorPosition = useCallback((view: EditorView, path: string) => {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const column = head - line.from;
    setCursorOffset((current) => (current === head ? current : head));
    setStatusPosition((current) => (
      current.line === line.number && current.column === column
        ? current
        : { line: line.number, column }
    ));
    onEditorPosition({
      path,
      line: line.number,
      column,
    });
    onViewState(path, {
      cursor: head,
      scrollTop: view.scrollDOM.scrollTop,
    });
  }, [onEditorPosition, onViewState]);
  reportEditorPositionRef.current = reportEditorPosition;
  const editorExtensions = useMemo(
    () => [
      ...(editorKeymap === "vim" ? [vim({ status: true })] : editorKeymap === "emacs" ? [emacs()] : []),
      latex(latexLanguageOptions),
      ...latexEditorExtensions(
        props.citationKeys,
        props.citations,
        props.references,
        props.onLoadReferenceImage,
        onGotoDefinition,
        projectPaths,
        onFindReferences,
        onRenameSymbol,
        editorSpellcheck,
        props.unusedLabels,
        props.unusedCitations,
        onRenameEnvironment,
        onWrapEnvironment,
        localMacros,
        activeFile,
        onPasteImageFile,
        graphicsRoots,
        onCreateMissingFile,
        true,
        onTexlabGoto,
        latexLiveRef,
      ),
      ...collabExtensions,
      editorCommentsExtension(activeFile, {
        getComments: () => commentsForActiveFileRef.current,
        currentAuthorId: commentAuthorId,
        onResolve: (id) => resolveEditorCommentRef.current(id),
        onReply: (comment) => replyEditorCommentRef.current(comment.id),
      }),
      lintGutter(),
      linter((view) => editorDiagnosticsForFile(diagnosticsRef.current.build, activeFile, view.state.doc), {
        delay: 150,
      }),
      linter((view) => editorTexlabDiagnosticsForFile(diagnosticsRef.current.texlab, activeFile, view.state.doc), {
        delay: 200,
      }),
    ],
    // Volatile macros/diagnostics/comments are read via refs so this array stays
    // stable across keystrokes — otherwise reconfigure kills yCollab carets.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional stability
    [activeFile, collabExtensions, editorKeymap, editorSpellcheck],
  );
  const secondaryEditorExtensions = useMemo(
    () => {
      if (!secondaryFile) return [];
      return [
        ...(editorKeymap === "vim" ? [vim({ status: true })] : editorKeymap === "emacs" ? [emacs()] : []),
        latex(latexLanguageOptions),
        ...latexEditorExtensions(
          props.citationKeys,
          props.citations,
          props.references,
          props.onLoadReferenceImage,
          onGotoDefinition,
          projectPaths,
          onFindReferences,
          onRenameSymbol,
          editorSpellcheck,
          props.unusedLabels,
          props.unusedCitations,
          onRenameEnvironment,
          onWrapEnvironment,
          localMacros,
          secondaryFile,
          onPasteImageFile,
          graphicsRoots,
          onCreateMissingFile,
          true,
          onTexlabGoto,
        ),
        lintGutter(),
        linter((view) => editorDiagnosticsForFile(buildDiagnostics, secondaryFile, view.state.doc), {
          delay: 150,
        }),
        linter((view) => editorTexlabDiagnosticsForFile(texlabDiagnostics, secondaryFile, view.state.doc), {
          delay: 200,
        }),
      ];
    },
    [buildDiagnostics, editorKeymap, editorSpellcheck, graphicsRoots, localMacros, onCreateMissingFile, onFindReferences, onGotoDefinition, onPasteImageFile, onRenameEnvironment, onRenameSymbol, onTexlabGoto, onWrapEnvironment, projectPaths, props.citationKeys, props.citations, props.onLoadReferenceImage, props.references, props.unusedCitations, props.unusedLabels, secondaryFile, texlabDiagnostics],
  );
  const insertTextAtCursor = useCallback((insert: string, cursorOffset = insert.length) => {
    const view = editorViewRef.current;
    if (!view) return;
    const from = view.state.selection.main.head;
    const expanded = expandSnippetPlaceholders(insert);
    const text = expanded.text;
    const anchor = expanded.stops[0]
      ? from + expanded.stops[0].from
      : from + Math.min(cursorOffset, text.length);
    const head = expanded.stops[0]
      ? from + expanded.stops[0].to
      : anchor;
    view.dispatch({
      changes: { from, insert: text },
      selection: { anchor, head },
      scrollIntoView: true,
    });
    setSnippetStops(expanded.stops.length > 1 ? { base: from, stops: expanded.stops } : null);
    view.focus();
  }, [setSnippetStops]);
  const insertSnippet = useCallback((snippet: InsertSnippet) => {
    insertTextAtCursor(snippet.insert, snippet.cursorOffset ?? snippet.insert.length);
  }, [insertTextAtCursor]);
  const insertFigures = useCallback(async (paths: string[], coordinates?: { x: number; y: number }) => {
    const view = editorViewRef.current;
    if (!view || !paths.length) return;
    const prepared: string[] = [];
    for (const path of paths) {
      const latexPath = await onPrepareFigure(path);
      if (latexPath) prepared.push(latexPath);
    }
    if (!prepared.length || !editorViewRef.current) return;
    const currentView = editorViewRef.current;
    let coordinatePosition: number | null = null;
    if (coordinates && coordinates.x >= 0 && coordinates.y >= 0) {
      try {
        coordinatePosition = currentView.posAtCoords(coordinates);
      } catch {
        // CodeMirror may not have layout coordinates yet; use the current cursor instead.
      }
    }
    const cursor = coordinatePosition ?? lastInsertionPositionRef.current;
    const position = currentView.state.doc.lineAt(clamp(cursor, 0, currentView.state.doc.length)).from;
    setFigureInsertPending({ paths: prepared, position });
  }, [onPrepareFigure, setFigureInsertPending]);
  const confirmFigureInsert = useCallback((options: FigureInsertOptions) => {
    const pending = figureInsertPending;
    if (!pending) return;
    const source = editorSource;
    const edit = latexFigureInsertion(source, pending.position, pending.paths, options);
    pendingFigureCursorRef.current = pending.position + edit.cursorOffset;
    setSource(`${source.slice(0, pending.position)}${edit.text}${source.slice(pending.position)}`);
    setFigureInsertPending(null);
  }, [editorSource, figureInsertPending, setFigureInsertPending, setSource]);
  useEffect(() => {
    const view = editorViewRef.current;
    const cursor = pendingFigureCursorRef.current;
    if (!view || cursor === null || view.state.doc.toString() !== editorSource) return;
    pendingFigureCursorRef.current = null;
    view.dispatch({ selection: { anchor: cursor }, scrollIntoView: true });
    view.focus();
  }, [editorSource]);
  useEffect(() => {
    const request = editorNavigation;
    if (!request) return;
    const view = request.path === secondaryFile
      ? secondaryViewRef.current
      : request.path === activeFile
        ? primaryViewRef.current ?? editorViewRef.current
        : null;
    if (!view) return;
    const frame = window.requestAnimationFrame(() => {
      const currentView = request.path === secondaryFile
        ? secondaryViewRef.current
        : primaryViewRef.current ?? editorViewRef.current;
      if (!currentView) return;
      const lineNumber = clamp(request.line, 1, currentView.state.doc.lines);
      const line = currentView.state.doc.line(lineNumber);
      currentView.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      editorViewRef.current = currentView;
      if (request.path === secondaryFile) onFocusPane("secondary");
      else onFocusPane("primary");
      currentView.focus();
      onEditorNavigationHandled(request.id);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFile, editorNavigation, editorSource, onEditorNavigationHandled, onFocusPane, secondaryFile, secondarySource]);
  useEffect(() => {
    const view = editorViewRef.current;
    const point = props.figurePointerPosition;
    if (!view || !point) {
      setFigureDropMarker(null);
      return;
    }
    let position: number | null = null;
    try {
      position = view.posAtCoords(point);
    } catch {
      // Fall back to the last cursor when layout coordinates are unavailable.
    }
    const line = view.state.doc.lineAt(clamp(position ?? lastInsertionPositionRef.current, 0, view.state.doc.length));
    const editorBounds = view.dom.closest(".source-editor")?.getBoundingClientRect();
    const lineCoordinates = view.coordsAtPos(line.from);
    const top = editorBounds
      ? clamp((lineCoordinates?.top ?? point.y) - editorBounds.top, 0, editorBounds.height)
      : 0;
    setFigureDropMarker({ top, line: line.number });
  }, [props.figurePointerPosition]);
  useEffect(() => {
    if (!figureDropRequest) return;
    const request = figureDropRequest;
    void insertFigures(request.paths, { x: request.clientX, y: request.clientY })
      .finally(() => onFigureDropHandled(request.id));
  }, [figureDropRequest, insertFigures, onFigureDropHandled]);
  useEffect(() => {
    const request = citeInsertRequest;
    const view = editorViewRef.current;
    if (!request || !view) return;
    const from = view.state.selection.main.head;
    const insert = `\\${request.command}{${request.key}}`;
    view.dispatch({
      changes: { from, insert },
      selection: { anchor: from + insert.length },
      scrollIntoView: true,
    });
    view.focus();
    onCiteInsertHandled(request.id);
  }, [citeInsertRequest, editorSource, onCiteInsertHandled]);
  useEffect(() => {
    const request = viewRestore;
    const view = editorViewRef.current;
    if (!request || !view || request.path !== activeFile) return;
    const frame = window.requestAnimationFrame(() => {
      const current = editorViewRef.current;
      if (!current) return;
      const cursor = clamp(request.cursor, 0, current.state.doc.length);
      current.dispatch({ selection: { anchor: cursor }, scrollIntoView: true });
      current.scrollDOM.scrollTop = request.scrollTop;
      onViewRestoreHandled(request.id);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFile, onViewRestoreHandled, viewRestore, editorSource]);
  useEffect(() => {
    const request = envRenameRequest;
    const view = editorViewRef.current;
    if (!request || !view) return;
    const edits = renameEnvironmentAt(view.state.doc.toString(), view.state.selection.main.head, request.newName);
    if (edits) {
      view.dispatch({
        changes: edits,
        scrollIntoView: true,
      });
      view.focus();
    }
    onEnvRenameHandled(request.id);
  }, [editorSource, envRenameRequest, onEnvRenameHandled]);
  useEffect(() => {
    const request = wrapEnvRequest;
    const view = editorViewRef.current;
    if (!request || !view) return;
    const range = view.state.selection.main;
    const edit = wrapEnvironment(view.state.doc.toString(), range.from, range.to, request.name);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: edit.cursorFrom === edit.cursorTo
        ? { anchor: edit.cursorFrom }
        : { anchor: edit.cursorFrom, head: edit.cursorTo },
      scrollIntoView: true,
    });
    view.focus();
    onWrapEnvHandled(request.id);
  }, [editorSource, onWrapEnvHandled, wrapEnvRequest]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || event.altKey || event.metaKey || event.ctrlKey) return;
      if (!snippetStops) return;
      const view = editorViewRef.current;
      if (!view) return;
      const cursor = view.state.selection.main.head;
      if (event.shiftKey) {
        const previous = previousSnippetStop(snippetStops.stops, cursor, snippetStops.base);
        if (!previous) return;
        event.preventDefault();
        view.dispatch({
          selection: { anchor: previous.from, head: previous.to },
          scrollIntoView: true,
        });
        return;
      }
      const absolute = snippetStops.stops.map((stop) => ({
        from: snippetStops.base + stop.from,
        to: snippetStops.base + stop.to,
      }));
      const next = nextSnippetStop(snippetStops.stops, cursor, snippetStops.base);
      if (!next) return;
      const last = absolute[absolute.length - 1];
      const atOrPastLast = Boolean(last && cursor >= last.to);
      if (atOrPastLast && next.from === absolute[0]?.from) {
        event.preventDefault();
        setSnippetStops(null);
        return;
      }
      event.preventDefault();
      view.dispatch({
        selection: { anchor: next.from, head: next.to },
        scrollIntoView: true,
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [snippetStops]);
  if (props.mode === "paper") {
    const showBlog = props.paperView === "blog" && props.paperBlog != null;
    const content = showBlog ? props.paperBlog! : stripFrontmatter(props.paperMarkdown);
    return (
      <article className="paper-reader">
        <div className="paper-reader-title">
          <BookOpen size={15} />
          <span>{props.activePaper?.title ?? "Imported paper"}</span>
          {props.paperBlog != null && (
            <div className="paper-view-toggle" role="group" aria-label="Reading view">
              <button type="button" className={showBlog ? "active" : ""} onClick={() => props.onSetPaperView("blog")}>Blog</button>
              <button type="button" className={!showBlog ? "active" : ""} onClick={() => props.onSetPaperView("fulltext")}>Paper</button>
            </div>
          )}
          {props.activePaper && <small>arXiv {props.activePaper.arxivId}</small>}
        </div>
        <ChatMarkdown text={content} macros={props.katexMacros} className="paper-content" breaks={false} />
      </article>
    );
  }
  if (props.mode === "asset" && props.activeAsset) {
    return <ProjectAssetPreview asset={props.activeAsset} />;
  }
  const showTexChrome = activeFile.endsWith(".tex");
  const editor = (
    <div className="source-workspace">
      <DocumentOutline
        nodes={outlineNodes}
        activeId={activeOutlineId}
        available={showTexChrome}
        open={outlineOpen}
        onSelect={onOutlineNavigate}
        onClose={() => onOutlineOpenChange(false)}
        onOpen={() => onOutlineOpenChange(true)}
      />
      <div className="source-main">
        <div
          className={`source-editor ${figureDropActive || props.nativeFigureDropActive ? "figure-drop-active" : ""}`}
          onPointerLeave={props.onEditorLeave}
          onFocusCapture={() => {
            onFocusPane("primary");
            if (primaryViewRef.current) editorViewRef.current = primaryViewRef.current;
          }}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) props.onEditorLeave();
          }}
          onDragEnterCapture={(event) => {
            if (Array.from(event.dataTransfer.types).includes(PROJECT_FIGURE_DRAG_TYPE)) setFigureDropActive(true);
          }}
          onDragOverCapture={(event) => {
            if (!Array.from(event.dataTransfer.types).includes(PROJECT_FIGURE_DRAG_TYPE)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
            setFigureDropActive(true);
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFigureDropActive(false);
          }}
          onDropCapture={(event) => {
            const path = event.dataTransfer.getData(PROJECT_FIGURE_DRAG_TYPE);
            if (!path) return;
            event.preventDefault();
            event.stopPropagation();
            setFigureDropActive(false);
            void insertFigures([path], { x: event.clientX, y: event.clientY });
          }}
        >
          <CodeMirror
            key={collabEditorKey}
            className="code-editor-root"
            value={collabLive ? mountSourceRef.current : props.source}
            height="100%"
            extensions={editorExtensions}
            onCreateEditor={(view) => {
              primaryViewRef.current = view;
              if (focusedPaneRef.current === "primary") editorViewRef.current = view;
              lastInsertionPositionRef.current = view.state.selection.main.head;
              reportEditorPositionRef.current(view, activeFile);
              view.dispatch({ effects: setEditorCommentsEffect.of(commentsForActiveFileRef.current) });
            }}
            onChange={onPrimaryChange}
            onUpdate={onPrimaryUpdate}
            basicSetup={{
              autocompletion: false,
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
            }}
          />
          {figureDropMarker && (
            <div className="figure-drop-line" style={{ top: figureDropMarker.top }}>
              <span>Insert above line {figureDropMarker.line}</span>
            </div>
          )}
          {selectedText.trim() && !commentComposer && focusedPane === "primary" && (
            <button
              type="button"
              className="editor-comment-chip"
              title="Add a comment on the selected text"
              onMouseDown={(event) => {
                event.preventDefault();
                openCommentComposer();
              }}
            >
              <MessageSquareText size={13} /> Comment
            </button>
          )}
          {commentComposer && (
            <div
              className="editor-comment-popover"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <p className="editor-comment-quote">{commentComposer.quote}</p>
              <textarea
                autoFocus
                rows={3}
                placeholder="Leave a comment for collaborators…"
                value={commentComposer.body}
                onChange={(event) => setCommentComposer((current) => (
                  current ? { ...current, body: event.target.value } : current
                ))}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    setCommentComposer(null);
                  }
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    saveCommentComposer();
                  }
                }}
              />
              <div className="editor-comment-popover-actions">
                <button type="button" onClick={() => setCommentComposer(null)}>Cancel</button>
                <button
                  type="button"
                  className="primary"
                  disabled={!commentComposer.body.trim()}
                  onClick={saveCommentComposer}
                >
                  Add comment
                </button>
              </div>
            </div>
          )}
        </div>
        {showTexChrome && focusedPane === "primary" && (
          <MathPreview source={focusedSource} cursor={cursorOffset} macros={katexMacros} />
        )}
        <div className="editor-status-bar" aria-label="Editor status">
          <button type="button" className="status-goto" title="Go to line (⌘G)" onClick={onGotoLineRequest}>
            Ln {statusPosition.line}, Col {statusPosition.column + 1}
          </button>
          {breadcrumb.length > 0 && (
            <span className="editor-breadcrumb" title={breadcrumb.map((node) => node.title).join(" › ")}>
              {breadcrumb.map((node, index) => (
                <span key={node.id}>
                  {index > 0 && <i aria-hidden="true">›</i>}
                  <button
                    type="button"
                    title={`Go to ${node.title}`}
                    onClick={() => onOutlineNavigate(node.path || focusedPath, node.line)}
                  >
                    {node.title}
                  </button>
                </span>
              ))}
            </span>
          )}
          <span className="status-hint" title="Editor shortcuts">
            {buildDiagnostics.length > 0
              ? <><kbd>F8</kbd> next · <kbd>⇧F8</kbd> prev</>
              : <><kbd>⌘F</kbd> find · <kbd>⌘/</kbd> comment · <kbd>⌘⇧I</kbd> insert</>}
          </span>
          <button
            type="button"
            className={`status-todos${commentsForActiveFile.some((comment) => !comment.resolved) ? " has-todos" : ""}`}
            title="Editor comments"
            onClick={onOpenEditorComments}
          >
            <MessageSquareText size={12} />
            {commentsForActiveFile.filter((comment) => !comment.resolved).length
              ? `${commentsForActiveFile.filter((comment) => !comment.resolved).length} comments`
              : "Comments"}
          </button>
          <button
            type="button"
            className={`status-todos${props.todoCount ? " has-todos" : ""}`}
            title="Manuscript TODOs"
            onClick={props.onOpenTodos}
          >
            <ListTodo size={12} />
            {props.todoCount ? `${props.todoCount} TODO` : "TODOs"}
          </button>
          <span
            className="status-body-words"
            title={props.projectWordCount
              ? `Body words (${props.projectWordCount.source === "texcount" ? "texcount" : "estimate"}): text ${props.projectWordCount.text}, headers ${props.projectWordCount.headers}, captions ${props.projectWordCount.captions}`
              : "Body word count unavailable"}
          >
            {selectedText
              ? `Sel ${selectionStats.words.toLocaleString()} words · ${selectionStats.chars.toLocaleString()} chars · ${selectionStats.lines.toLocaleString()} lines`
              : props.projectWordCount
                ? `Body ${props.projectWordCount.total.toLocaleString()} · raw ${wordCount.toLocaleString()} · ${focusedSource.length.toLocaleString()} chars`
                : `${wordCount.toLocaleString()} words · ${focusedSource.length.toLocaleString()} chars`}
          </span>
        </div>
      </div>
      <InsertPalette
        open={insertOpen}
        onClose={() => onInsertOpenChange(false)}
        onInsert={insertSnippet}
      />
      <TableGeneratorDialog
        open={tableGeneratorOpen}
        onClose={() => onTableGeneratorOpenChange(false)}
        onInsert={(insert, cursorOffset) => insertTextAtCursor(insert, cursorOffset)}
      />
      <FigureInsertDialog
        open={Boolean(figureInsertPending)}
        paths={figureInsertPending?.paths ?? []}
        onClose={() => setFigureInsertPending(null)}
        onInsert={confirmFigureInsert}
      />
    </div>
  );
  const preview = (
    <PdfPreview
      url={props.pdfUrl}
      pdfBase64={props.pdfBase64}
      syncTarget={props.pdfSyncTarget}
      marks={props.pdfMarks}
      activeMarkId={props.activePdfMarkId}
      onSource={props.onPdfSource}
      onTextSelect={props.onPdfTextSelect}
      onCreateMark={props.onCreatePdfMark}
      onSelectMark={props.onSelectPdfMark}
      onOpenMarks={props.onOpenPdfMarks}
      onNumPages={props.onPdfPageCount}
    />
  );
  if (props.mode === "source") return editor;
  if (props.mode === "pdf") return preview;
  if (props.mode === "dual" || props.mode === "columns") {
    const dualSecondary = secondaryFile ? (
      <div
        className={`source-main dual-pane ${focusedPane === "secondary" ? "focused" : ""}`}
        onFocusCapture={() => {
          onFocusPane("secondary");
          if (secondaryViewRef.current) editorViewRef.current = secondaryViewRef.current;
        }}
      >
        <div className="dual-pane-label"><FileCode2 size={12} /><span>{secondaryFile}</span></div>
        <div className="source-editor">
          <CodeMirror
            className="code-editor-root"
            value={secondarySource}
            height="100%"
            extensions={secondaryEditorExtensions}
            onCreateEditor={(view) => {
              secondaryViewRef.current = view;
              if (focusedPane === "secondary") editorViewRef.current = view;
            }}
            onChange={onSecondaryChange}
            onUpdate={onSecondaryUpdate}
            basicSetup={{
              autocompletion: false,
              lineNumbers: true,
              foldGutter: true,
              highlightActiveLine: true,
              highlightActiveLineGutter: true,
            }}
          />
        </div>
      </div>
    ) : (
      <div className="dual-empty">
        <Columns2 size={18} />
        <p>Use Dual source view from the command palette to open a second file here.</p>
      </div>
    );
    const editorsShare = 1 - columnsPdfRatio;
    const beginDualResize = (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      let latest = splitRatio;
      document.body.classList.add("resizing-split");
      const handleMove = (moveEvent: PointerEvent) => {
        const bounds = splitRef.current?.getBoundingClientRect();
        if (!bounds?.width) return;
        if (props.mode === "columns") {
          // Resize only across the two editor panes (everything left of the PDF).
          const editorsWidth = bounds.width * editorsShare;
          latest = clamp((moveEvent.clientX - bounds.left) / Math.max(editorsWidth, 1), 0.25, 0.75);
        } else {
          latest = clamp((moveEvent.clientX - bounds.left) / bounds.width, 0.2, 0.8);
        }
        setSplitRatio(latest);
      };
      const handleUp = () => {
        document.body.classList.remove("resizing-split");
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        persistSplitRatio(latest);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    };
    const beginColumnsPdfResize = (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      let latest = columnsPdfRatio;
      document.body.classList.add("resizing-split");
      const handleMove = (moveEvent: PointerEvent) => {
        const bounds = splitRef.current?.getBoundingClientRect();
        if (!bounds?.width) return;
        const fromRight = (bounds.right - moveEvent.clientX) / bounds.width;
        latest = clamp(fromRight, 0.22, 0.55);
        setColumnsPdfRatio(latest);
      };
      const handleUp = () => {
        document.body.classList.remove("resizing-split");
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        persistColumnsPdfRatio(latest);
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    };
    const primaryPane = (
      <div
        className={`dual-primary ${focusedPane === "primary" ? "focused" : ""}`}
        onFocusCapture={() => {
          onFocusPane("primary");
          if (primaryViewRef.current) editorViewRef.current = primaryViewRef.current;
        }}
      >
        {editor}
      </div>
    );
    const editorResizer = (
      <div
        className="split-resizer"
        role="separator"
        aria-label="Resize dual source panes"
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={beginDualResize}
      />
    );
    if (props.mode === "columns") {
      return (
        <div
          ref={splitRef}
          className="split-canvas dual-canvas columns-canvas"
          style={{
            gridTemplateColumns: `minmax(160px, ${splitRatio * editorsShare}fr) 1px minmax(160px, ${(1 - splitRatio) * editorsShare}fr) 1px minmax(220px, ${columnsPdfRatio}fr)`,
          }}
        >
          {primaryPane}
          {editorResizer}
          {dualSecondary}
          <div
            className="split-resizer"
            role="separator"
            aria-label="Resize PDF pane"
            aria-orientation="vertical"
            aria-valuenow={Math.round(columnsPdfRatio * 100)}
            tabIndex={0}
            onPointerDown={beginColumnsPdfResize}
          />
          {preview}
        </div>
      );
    }
    return (
      <div
        ref={splitRef}
        className="split-canvas dual-canvas"
        style={{ gridTemplateColumns: `minmax(220px, ${splitRatio}fr) 1px minmax(220px, ${1 - splitRatio}fr)` }}
      >
        {primaryPane}
        {editorResizer}
        {dualSecondary}
      </div>
    );
  }
  const resizeSplit = (clientX: number) => {
    const bounds = splitRef.current?.getBoundingClientRect();
    if (!bounds?.width) return splitRatio;
    const next = clamp((clientX - bounds.left) / bounds.width, 0.2, 0.8);
    setSplitRatio(next);
    return next;
  };
  const beginSplitResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    let latest = splitRatio;
    document.body.classList.add("resizing-split");
    const handleMove = (moveEvent: PointerEvent) => {
      latest = resizeSplit(moveEvent.clientX);
    };
    const handleUp = () => {
      document.body.classList.remove("resizing-split");
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      persistSplitRatio(latest);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };
  const nudgeSplit = (delta: number) => {
    const next = clamp(splitRatio + delta, 0.2, 0.8);
    setSplitRatio(next);
    persistSplitRatio(next);
  };
  return (
    <div
      ref={splitRef}
      className="split-canvas"
      style={{ gridTemplateColumns: `minmax(220px, ${splitRatio}fr) 1px minmax(260px, ${1 - splitRatio}fr)` }}
    >
      {editor}
      <div
        className="split-resizer"
        role="separator"
        aria-label="Resize source and PDF preview"
        aria-orientation="vertical"
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(splitRatio * 100)}
        tabIndex={0}
        onPointerDown={beginSplitResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            nudgeSplit(-0.03);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            nudgeSplit(0.03);
          }
        }}
      />
      {preview}
    </div>
  );
}

function ProjectAssetPreview({ asset }: { asset: AssetPreview }) {
  const url = `data:${asset.mimeType};base64,${asset.base64}`;
  if (asset.mimeType === "application/pdf") {
    return <PdfPreview key={url} url={url} pdfBase64={asset.base64} fileName={asset.path.split("/").pop() ?? "figure.pdf"} />;
  }
  return (
    <div className="asset-preview">
      <div className="asset-preview-heading">
        <Image size={14} />
        <span>{asset.path}</span>
        <small>Drag this file from Project into the LaTeX editor to insert it.</small>
      </div>
      <div className="asset-preview-stage">
        {asset.mimeType.startsWith("image/")
          ? <img src={url} alt={`Preview of ${asset.path}`} />
          : <div className="asset-preview-unsupported"><FileText size={28} /><p>This format cannot be rendered in the preview.</p></div>}
      </div>
    </div>
  );
}

function SettingsDialog(props: {
  tab: SettingsTab;
  setTab: (tab: SettingsTab) => void;
  appearance: AppearanceSettings;
  setAppearance: (appearance: AppearanceSettings) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  buildPreferences: BuildPreferences;
  setBuildPreferences: (preferences: BuildPreferences) => void;
  systemPrompt: string;
  setSystemPrompt: (prompt: string) => void;
  hasProject: boolean;
  project: ProjectSnapshot | null;
  activeFile: string | null;
  onUpdateManifest: (patch: {
    engine?: string | null;
    defaultRoot?: string | null;
    trusted?: boolean | null;
  }) => void;
  onAddRootDocument: (path: string, makeDefault: boolean) => void;
  onRemoveRootDocument: (path: string) => void;
  skills: AgentSkill[];
  skillDraft: SkillDraft | null;
  setSkillDraft: (draft: SkillDraft | null) => void;
  onSaveSkill: (draft: SkillDraft) => void;
  onSetSkillEnabled: (name: string, enabled: boolean) => void;
  onDeleteSkill: (skill: AgentSkill) => void;
  subscriptions: SubscriptionStatus[];
  subscriptionsLoading: boolean;
  subscriptionNotice: string;
  // (updater state is read from context via useUpdater, not passed as a prop)
  onRefreshSubscriptions: () => void;
  onSubscriptionLogin: (provider: "codex" | "claude") => void;
  apiProvider: "openai" | "anthropic";
  setApiProvider: (provider: "openai" | "anthropic") => void;
  apiKey: string;
  setApiKey: (key: string) => void;
  apiConfigured: boolean;
  onSaveApiKey: () => void;
  onDeleteApiKey: () => void;
  doctorReport: DoctorReport | null;
  doctorBusy: boolean;
  doctorNotice: string;
  onRunDoctor: () => void;
  onOpenTexSetup: () => void;
  onCopyDoctorSummary: () => void;
  onClose: () => void;
}) {
  const updater = useUpdater();
  const updateBusy = updater.phase === "checking"
    || updater.phase === "downloading"
    || updater.phase === "installing";
  const updateTitle = updater.phase === "available"
    ? `Version ${updater.version ?? ""} is ready to install`.trim()
    : updater.phase === "downloading"
      ? "Downloading update…"
      : updater.phase === "installing"
        ? "Installing update…"
        : updater.phase === "error"
          ? "Couldn’t check for updates"
          : updater.phase === "up-to-date"
            ? "You’re on the latest version"
            : updater.mode === "auto"
              ? "New versions install automatically"
              : "You’ll be notified when a new version is ready";
  const updateDetail = updater.phase === "error"
    ? (updater.error ?? "Check your connection and try again.")
    : updater.mode === "auto"
      ? "Lattice checks in the background and installs updates on its own."
      : "Lattice checks in the background; you decide when to install.";
  return (
    <div className="modal-backdrop" onMouseDown={props.onClose}>
      <div className="settings-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <div><Settings2 size={17} /><span>Settings</span></div>
          <button title="Close settings" onClick={props.onClose}><X size={16} /></button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            <button className={props.tab === "appearance" ? "active" : ""} onClick={() => props.setTab("appearance")}>Appearance</button>
            <button className={props.tab === "editor" ? "active" : ""} onClick={() => props.setTab("editor")}>Editor & builds</button>
            <button className={props.tab === "agent" ? "active" : ""} onClick={() => props.setTab("agent")}>Agent</button>
            <button className={props.tab === "accounts" ? "active" : ""} onClick={() => props.setTab("accounts")}>Subscriptions</button>
            <button className={props.tab === "api" ? "active" : ""} onClick={() => props.setTab("api")}>API keys</button>
            <button className={props.tab === "doctor" ? "active" : ""} onClick={() => props.setTab("doctor")}>TeX doctor</button>
          </nav>
          <div className="settings-content">
            {props.tab === "appearance" && (
              <div className="settings-section">
                <h2>Appearance</h2>
                <p>These preferences apply across every project on this Mac.</p>
                <label>Color theme
                  <select aria-label="Color theme" value={props.theme} onChange={(event) => props.setTheme(event.target.value as Theme)}>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </label>
                <label>Interface font
                  <select value={props.appearance.uiFont} onChange={(event) => props.setAppearance({ ...props.appearance, uiFont: event.target.value })}>
                    {availableFontOptions(UI_FONT_OPTIONS).map((option) => (
                      <option key={option.family} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className="settings-range">
                  <div><label htmlFor="interface-size">Interface size</label><output>{Math.round(props.appearance.interfaceScale * 100)}%</output></div>
                  <input id="interface-size" type="range" min="90" max="135" step="5" value={Math.round(props.appearance.interfaceScale * 100)} onChange={(event) => props.setAppearance({ ...props.appearance, interfaceScale: Number(event.target.value) / 100 })} />
                </div>
                <label>LaTeX editor font
                  <select
                    value={
                      availableFontOptions(EDITOR_FONT_OPTIONS).some((option) => option.value === props.appearance.editorFont)
                        ? props.appearance.editorFont
                        : DEFAULT_EDITOR_FONT
                    }
                    onChange={(event) => props.setAppearance({ ...props.appearance, editorFont: event.target.value })}
                  >
                    {availableFontOptions(EDITOR_FONT_OPTIONS).map((option) => (
                      <option key={option.family} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className="settings-range">
                  <div><label htmlFor="editor-font-size">Editor font size</label><output>{props.appearance.editorFontSize}px</output></div>
                  <input id="editor-font-size" type="range" min="10" max="24" step="1" value={props.appearance.editorFontSize} onChange={(event) => props.setAppearance({ ...props.appearance, editorFontSize: Number(event.target.value) })} />
                </div>
              </div>
            )}
            {props.tab === "editor" && (
              <div className="settings-section">
                <h2>Editor & builds</h2>
                <p>Choose keymap behavior and when Lattice recompiles after a source change.</p>
                <label>Editor keymap
                  <select
                    aria-label="Editor keymap"
                    value={props.appearance.editorKeymap}
                    onChange={(event) => props.setAppearance({
                      ...props.appearance,
                      editorKeymap: event.target.value === "vim"
                        ? "vim"
                        : event.target.value === "emacs"
                          ? "emacs"
                          : "default",
                    })}
                  >
                    <option value="default">Default</option>
                    <option value="vim">Vim</option>
                    <option value="emacs">Emacs</option>
                  </select>
                </label>
                <label className="settings-checkbox">
                  <input
                    type="checkbox"
                    checked={props.appearance.editorSpellcheck}
                    onChange={(event) => props.setAppearance({
                      ...props.appearance,
                      editorSpellcheck: event.target.checked,
                    })}
                  />
                  <span>Spellcheck prose in the editor</span>
                </label>
                <div className="settings-range">
                  <div><label htmlFor="max-open-tabs">Max open tabs</label><output>{props.appearance.maxOpenTabs}</output></div>
                  <input id="max-open-tabs" type="range" min="1" max="20" step="1" value={props.appearance.maxOpenTabs} onChange={(event) => props.setAppearance({ ...props.appearance, maxOpenTabs: Number(event.target.value) })} />
                </div>
                <label>Automatic build
                  <select aria-label="Automatic build" value={props.buildPreferences.autoBuildMode} onChange={(event) => props.setBuildPreferences({ autoBuildMode: event.target.value as AutoBuildMode })}>
                    <option value="manual">Manual only</option>
                    <option value="automatic">Automatic</option>
                  </select>
                </label>
                <div className="settings-detail">
                  <Play size={14} />
                  <div><strong>{autoBuildTitle(props.buildPreferences.autoBuildMode)}</strong><span>{autoBuildDetail(props.buildPreferences.autoBuildMode)}</span></div>
                </div>
                {props.project && (
                  <>
                    <label>Compile engine
                      <select
                        aria-label="Compile engine"
                        value={props.project.manifest.engine ?? "pdf"}
                        onChange={(event) => props.onUpdateManifest({ engine: event.target.value })}
                      >
                        <option value="pdf">pdfLaTeX</option>
                        <option value="xelatex">XeLaTeX</option>
                        <option value="lualatex">LuaLaTeX</option>
                      </select>
                    </label>
                    <label>Root document
                      <select
                        aria-label="Root document"
                        value={
                          props.project.manifest.rootDocuments.find((document) => document.isDefault)?.path
                          ?? props.project.manifest.rootDocuments[0]?.path
                          ?? ""
                        }
                        onChange={(event) => props.onUpdateManifest({ defaultRoot: event.target.value })}
                      >
                        {props.project.manifest.rootDocuments.map((document) => (
                          <option key={document.path} value={document.path}>{document.name} ({document.path})</option>
                        ))}
                      </select>
                    </label>
                    <div className="root-document-actions">
                      <button
                        type="button"
                        className="secondary"
                        disabled={!props.activeFile?.endsWith(".tex")}
                        title={props.activeFile?.endsWith(".tex") ? `Add ${props.activeFile} as a compile root` : "Open a .tex file first"}
                        onClick={() => {
                          if (props.activeFile?.endsWith(".tex")) {
                            props.onAddRootDocument(props.activeFile, false);
                          }
                        }}
                      >
                        Add open .tex
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={props.project.manifest.rootDocuments.length <= 1}
                        title="Remove the selected root document"
                        onClick={() => {
                          const selected =
                            props.project!.manifest.rootDocuments.find((document) => document.isDefault)?.path
                            ?? props.project!.manifest.rootDocuments[0]?.path;
                          if (selected) props.onRemoveRootDocument(selected);
                        }}
                      >
                        Remove selected
                      </button>
                    </div>
                    <label className="settings-checkbox">
                      <input
                        type="checkbox"
                        checked={props.project.manifest.trusted}
                        onChange={(event) => props.onUpdateManifest({ trusted: event.target.checked })}
                      />
                      <span>Allow shell escape when compiling</span>
                    </label>
                  </>
                )}
                <div className="settings-updates">
                  <h3>App updates</h3>
                  <p>Choose whether Lattice installs new versions automatically or just tells you.</p>
                  <label>Automatic updates
                    <select
                      aria-label="Automatic updates"
                      value={updater.mode}
                      onChange={(event) => updater.setMode(event.target.value as UpdateMode)}
                    >
                      <option value="manual">Notify me (manual)</option>
                      <option value="auto">Install automatically</option>
                    </select>
                  </label>
                  <div className="settings-detail">
                    <RefreshCw size={14} />
                    <div><strong>{updateTitle}</strong><span>{updateDetail}</span></div>
                  </div>
                  <div className="root-document-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={updateBusy}
                      onClick={() => void updater.check(false)}
                    >
                      {updater.phase === "checking" ? "Checking…" : "Check for updates"}
                    </button>
                  </div>
                </div>
              </div>
            )}
            {props.tab === "agent" && (
              <div className="settings-section">
                <h2>Agent</h2>
                <p>Lattice uses Oh My Pi as its agent backend. The prompt and skills below stay inside Lattice and never change your global agent setup.</p>
                <label htmlFor="agent-system-prompt">System prompt
                  <textarea
                    id="agent-system-prompt"
                    aria-label="Agent system prompt"
                    placeholder="Write the system prompt you want OMP to use…"
                    value={props.systemPrompt}
                    onChange={(event) => props.setSystemPrompt(event.target.value)}
                  />
                </label>
                <div className="skill-heading">
                  <div><strong>Skills</strong><span>Enabled skills are given to OMP on its next turn.</span></div>
                  <button onClick={() => props.setSkillDraft({ scope: "application", content: "---\nname: new-skill\ndescription: Describe when OMP should use this skill.\n---\n\n# New skill\n\nWrite the instructions here.\n" })}><Plus size={12} /> Add skill</button>
                </div>
                {props.skillDraft ? (
                  <div className="skill-editor">
                    <label>Availability
                      <select value={props.skillDraft.scope} onChange={(event) => props.setSkillDraft({ ...props.skillDraft!, scope: event.target.value as "application" | "project" })}>
                        <option value="application">All Lattice projects</option>
                        <option value="project" disabled={!props.hasProject}>This project only</option>
                      </select>
                    </label>
                    <label>SKILL.md
                      <textarea aria-label="Skill instructions" value={props.skillDraft.content} onChange={(event) => props.setSkillDraft({ ...props.skillDraft!, content: event.target.value })} />
                    </label>
                    <div className="skill-editor-actions"><button onClick={() => props.setSkillDraft(null)}>Cancel</button><button className="primary-button" onClick={() => props.onSaveSkill(props.skillDraft!)}>Save skill</button></div>
                  </div>
                ) : (
                  <div className="skill-list">
                    {props.skills.map((skill) => (
                      <div className="skill-card" key={skill.name}>
                        <button className={`skill-toggle ${skill.enabled ? "enabled" : ""}`} role="switch" aria-checked={skill.enabled} aria-label={`Enable ${skill.name}`} onClick={() => props.onSetSkillEnabled(skill.name, !skill.enabled)}><span /></button>
                        <div><strong>{skill.name}</strong><small>{skill.scope === "built-in" ? "Bundled" : skill.scope === "application" ? "All projects" : "This project"}{skill.overridden ? " · overrides bundled" : ""}</small><p>{skill.description}</p></div>
                        <div className="skill-actions">
                          <button title={`Edit ${skill.name}`} onClick={() => props.setSkillDraft({ originalName: skill.name, scope: skill.scope === "project" ? "project" : "application", content: skill.content })}><Pencil size={12} /></button>
                          {skill.scope !== "built-in" && <button title={skill.overridden ? `Restore bundled ${skill.name}` : `Delete ${skill.name}`} onClick={() => props.onDeleteSkill(skill)}>{skill.overridden ? <RotateCcw size={12} /> : <Trash2 size={12} />}</button>}
                        </div>
                      </div>
                    ))}
                    {!props.skills.length && <p className="settings-empty">No skills are installed in Lattice.</p>}
                  </div>
                )}
              </div>
            )}
            {props.tab === "accounts" && (
              <div className="settings-section">
                <div className="settings-section-title"><div><h2>Subscriptions</h2><p>OMP manages sign-in and token refresh for Lattice.</p></div><button title="Refresh subscription status" onClick={props.onRefreshSubscriptions} disabled={props.subscriptionsLoading}><RefreshCw className={props.subscriptionsLoading ? "spin" : ""} size={14} /></button></div>
                <div className="account-list">
                  {props.subscriptions.map((account) => (
                    <div className="account-card" key={account.provider}>
                      <div className={`account-mark ${account.loggedIn ? "connected" : ""}`}>{account.provider === "codex" ? "O" : "C"}</div>
                      <div><strong>{account.provider === "codex" ? "Codex subscription" : "Claude subscription"}</strong><small>{account.detail}</small></div>
                      {!account.loggedIn && <button disabled={!account.installed || props.subscriptionsLoading} onClick={() => props.onSubscriptionLogin(account.provider)}>Sign in with OMP</button>}
                      {account.loggedIn && <span className="connected-label"><Check size={12} /> Connected</span>}
                    </div>
                  ))}
                  {!props.subscriptions.length && <p className="settings-empty">{props.subscriptionsLoading ? "Checking local subscriptions…" : "Refresh to check local subscriptions."}</p>}
                </div>
                {props.subscriptionNotice && <p className="settings-notice">{props.subscriptionNotice}</p>}
              </div>
            )}
            {props.tab === "api" && (
              <div className="settings-section">
                <h2>API keys</h2>
                <p>API keys are optional and only used by the API providers. OMP authenticates subscription providers separately.</p>
                <label>Provider
                  <select value={props.apiProvider} onChange={(event) => props.setApiProvider(event.target.value as "openai" | "anthropic")}>
                    <option value="openai">OpenAI API</option>
                    <option value="anthropic">Anthropic API</option>
                  </select>
                </label>
                <label>
                  <span className="key-label">API key {props.apiConfigured && <span className="configured-label"><Check size={11} /> Configured</span>}</span>
                  <input type="password" autoComplete="off" placeholder={props.apiConfigured ? "Enter a replacement key" : "Paste API key"} value={props.apiKey} onChange={(event) => props.setApiKey(event.target.value)} onKeyDown={(event) => event.key === "Enter" && props.apiKey.trim() && props.onSaveApiKey()} />
                </label>
                <div className="settings-api-actions">
                  {props.apiConfigured && <button className="delete-key-button" onClick={props.onDeleteApiKey}><Trash2 size={13} /> Remove</button>}
                  <span />
                  <button className="primary-button" onClick={props.onSaveApiKey} disabled={!props.apiKey.trim()}>Save key</button>
                </div>
              </div>
            )}
            {props.tab === "doctor" && (
              <div className="settings-section">
                <div className="settings-section-title">
                  <div>
                    <h2>TeX doctor</h2>
                    <p>Checks local LaTeX tools, SyncTeX, bibliography processors, and the bundled agent runtime.</p>
                  </div>
                  <button title="Run TeX doctor" onClick={props.onRunDoctor} disabled={props.doctorBusy}>
                    <RefreshCw className={props.doctorBusy ? "spin" : ""} size={14} />
                  </button>
                </div>
                {props.doctorReport && (
                  <>
                    <div className={`doctor-status ${props.doctorReport.ok ? "ok" : "bad"}`}>
                      {props.doctorReport.ok ? "Ready to compile" : "Missing required tools"}
                    </div>
                    <ul className="doctor-checklist">
                      {props.doctorReport.checks.map((check) => (
                        <li key={check.name} className={check.ok ? "ok" : "bad"}>
                          <strong>{check.name}</strong>
                          <span>{check.detail}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="settings-api-actions">
                      <button className="secondary-button" type="button" onClick={props.onOpenTexSetup}>
                        Open install guide
                      </button>
                      <button className="secondary-button" type="button" onClick={props.onCopyDoctorSummary}>
                        <Copy size={13} /> Copy summary
                      </button>
                    </div>
                  </>
                )}
                {!props.doctorReport && !props.doctorBusy && (
                  <>
                    <p className="settings-empty">Run the doctor to inspect this Mac’s TeX toolchain.</p>
                    <div className="settings-api-actions">
                      <button className="secondary-button" type="button" onClick={props.onOpenTexSetup}>
                        Open install guide
                      </button>
                    </div>
                  </>
                )}
                {props.doctorBusy && <p className="settings-empty">Checking local tools…</p>}
                {props.doctorNotice && <p className="settings-notice">{props.doctorNotice}</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

let windowDragTimer: ReturnType<typeof setTimeout> | null = null;

function beginWindowDrag(event: React.MouseEvent<HTMLElement>) {
  if (event.buttons !== 1 || event.detail > 1 || (event.target as Element).closest("button, input, select, textarea, a")) return;
  event.preventDefault();
  if (windowDragTimer) clearTimeout(windowDragTimer);
  // Delay drag so a second click can still register as double-click → fullscreen.
  windowDragTimer = setTimeout(() => {
    windowDragTimer = null;
    void getCurrentWindow().startDragging();
  }, 180);
}

function toggleWindowFullscreen(event: React.MouseEvent<HTMLElement>) {
  if ((event.target as Element).closest("button, input, select, textarea, a")) return;
  event.preventDefault();
  if (windowDragTimer) {
    clearTimeout(windowDragTimer);
    windowDragTimer = null;
  }
  const appWindow = getCurrentWindow();
  if (typeof appWindow.isFullscreen !== "function" || typeof appWindow.setFullscreen !== "function") return;
  void appWindow.isFullscreen()
    .then((value) => appWindow.setFullscreen(!value))
    .catch(() => undefined);
}

function toMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function agentErrorDetails(message: string): { text: string; settingsTab: SettingsTab | null } {
  const routes: Array<[prefix: string, tab: SettingsTab]> = [
    ["LATTICE_AUTH_SUBSCRIPTION:", "accounts"],
    ["LATTICE_AUTH_API_KEY:", "api"],
  ];
  const route = routes.find(([prefix]) => message.startsWith(prefix));
  if (!route) return { text: message, settingsTab: null };
  return { text: message.slice(route[0].length).trim(), settingsTab: route[1] };
}

function modelOptions(provider: AgentProvider): ModelOption[] {
  const standard = ["low", "medium", "high", "xhigh"] as ReasoningEffort[];
  const frontier = [...standard, "max"] as ReasoningEffort[];
  switch (provider) {
    case "codex":
      return [
        { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: [...frontier, "ultra"] },
        { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", efforts: [...frontier, "ultra"] },
        { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: frontier },
        { value: "gpt-5.5", label: "GPT-5.5", efforts: standard },
        { value: "gpt-5.4", label: "GPT-5.4", efforts: standard },
        { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", efforts: standard },
      ];
    case "openai-api":
      return [
        { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["none", ...frontier] },
        { value: "gpt-5.6-terra", label: "GPT-5.6 Terra", efforts: ["none", ...frontier] },
        { value: "gpt-5.6-luna", label: "GPT-5.6 Luna", efforts: ["none", ...frontier] },
        { value: "gpt-5.5", label: "GPT-5.5", efforts: standard },
        { value: "gpt-5.4", label: "GPT-5.4", efforts: standard },
        { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", efforts: standard },
      ];
    case "claude":
      return [
        { value: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: frontier },
        { value: "claude-opus-4-7", label: "Claude Opus 4.7", efforts: frontier },
        { value: "claude-opus-4-6", label: "Claude Opus 4.6", efforts: frontier },
        { value: "claude-opus-4-5", label: "Claude Opus 4.5", efforts: frontier },
        { value: "claude-opus-4-1", label: "Claude Opus 4.1", efforts: frontier },
        { value: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: frontier },
        { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", efforts: frontier },
        { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: frontier },
      ];
    case "anthropic-api":
      return [
        { value: "claude-opus-4-8", label: "Claude Opus 4.8", efforts: frontier },
        { value: "claude-opus-4-7", label: "Claude Opus 4.7", efforts: frontier },
        { value: "claude-opus-4-6", label: "Claude Opus 4.6", efforts: frontier },
        { value: "claude-opus-4-5", label: "Claude Opus 4.5", efforts: frontier },
        { value: "claude-opus-4-1", label: "Claude Opus 4.1", efforts: frontier },
        { value: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: frontier },
        { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", efforts: frontier },
        { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: frontier },
      ];
  }
}

function defaultModel(provider: AgentProvider): string {
  return modelOptions(provider)[0].value;
}

function normalizeModel(provider: AgentProvider, model: string | undefined): string {
  if (provider === "claude") {
    if (model === "sonnet") return "claude-sonnet-5";
    if (model === "opus") return "claude-opus-4-8";
    if (model === "fable" || model === "claude-fable-5") return "claude-sonnet-5";
  }
  return modelOptions(provider).some((option) => option.value === model) ? model as string : defaultModel(provider);
}

function modelLabel(provider: AgentProvider, model: string): string {
  return modelOptions(provider).find((option) => option.value === model)?.label ?? model;
}

function normalizeEffort(value: string | undefined): ReasoningEffort {
  return value === "none" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra"
    ? value
    : "high";
}

function compactConversationTitle(title: string): string {
  return title === "New conversation" ? "New" : title;
}

function autoBuildTitle(mode: AutoBuildMode): string {
  if (mode === "automatic") return "Build automatically";
  return "Build only when requested";
}

function autoBuildDetail(mode: AutoBuildMode): string {
  if (mode === "automatic") return "Lattice saves and builds when you leave the editor or after 1.2 seconds without typing.";
  return "Use the Build button or Command-S. Source changes are still saved automatically.";
}

function autoBuildDescription(mode: AutoBuildMode): string {
  return `${autoBuildTitle(mode)} · Command-S builds now`;
}

function relativeTime(timestamp: string): string {
  const elapsed = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return new Date(timestamp).toLocaleDateString();
}

function loadRecentProjects(): RecentProject[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_PROJECTS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is RecentProject => Boolean(
        item && typeof item === "object" && "name" in item && typeof item.name === "string" &&
        "path" in item && typeof item.path === "string",
      ))
      .slice(0, 8);
  } catch {
    return [];
  }
}

function persistRecentProjects(projects: RecentProject[]) {
  try {
    localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(projects));
  } catch {
    // Recent projects are a convenience; project access still works if storage is unavailable.
  }
}

function loadPanelWidths(): PanelWidths {
  // Keep navigator/agent narrower so the editor + PDF canvas get more room by default.
  const defaults = { navigator: 200, agent: 280 };
  try {
    const value = JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) ?? "null") as Partial<PanelWidths> | null;
    return {
      navigator: clamp(Number(value?.navigator) || defaults.navigator, 160, 420),
      agent: clamp(Number(value?.agent) || defaults.agent, 260, 600),
    };
  } catch {
    return defaults;
  }
}

function loadAppearance(): AppearanceSettings {
  const defaults: AppearanceSettings = {
    uiFont: DEFAULT_UI_FONT,
    interfaceScale: 1.1,
    editorFont: DEFAULT_EDITOR_FONT,
    editorFontSize: 14,
    editorKeymap: "default",
    editorSpellcheck: false,
    maxOpenTabs: 5,
  };
  try {
    const current = localStorage.getItem(APPEARANCE_KEY);
    const legacy = localStorage.getItem(LEGACY_APPEARANCE_KEY);
    const value = JSON.parse(current ?? legacy ?? "null") as Partial<AppearanceSettings> | null;
    return {
      uiFont: resolveFontValue(
        typeof value?.uiFont === "string" ? value.uiFont : undefined,
        UI_FONT_OPTIONS,
        defaults.uiFont,
      ),
      interfaceScale: clamp(Number(value?.interfaceScale) || defaults.interfaceScale, 0.9, 1.35),
      editorFont: resolveFontValue(
        typeof value?.editorFont === "string" ? value.editorFont : undefined,
        EDITOR_FONT_OPTIONS,
        defaults.editorFont,
      ),
      editorFontSize: clamp(Number(value?.editorFontSize) || defaults.editorFontSize, 10, 24),
      editorKeymap: value?.editorKeymap === "vim"
        ? "vim"
        : value?.editorKeymap === "emacs"
          ? "emacs"
          : "default",
      editorSpellcheck: value?.editorSpellcheck === true,
      maxOpenTabs: clamp(Math.round(Number(value?.maxOpenTabs) || defaults.maxOpenTabs), 1, 20),
    };
  } catch {
    return defaults;
  }
}

function loadTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // Fall through to the system preference when storage is unavailable.
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function loadBuildPreferences(): BuildPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(BUILD_PREFERENCES_KEY) ?? "null") as { autoBuildMode?: string } | null;
    const autoBuildMode = value?.autoBuildMode;
    return {
      autoBuildMode: autoBuildMode === "manual" ? "manual" : "automatic",
    };
  } catch {
    return { autoBuildMode: "automatic" };
  }
}

function loadSystemPrompt(): string {
  try {
    return localStorage.getItem(AGENT_SYSTEM_PROMPT_KEY) ?? "";
  } catch {
    return "";
  }
}

function projectItemPath(root: string, relativePath: string): string {
  if (!relativePath) return root;
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relativePath.replace(/[\\/]/g, separator)}`;
}

function loadSplitRatio(): number {
  try {
    return clamp(Number(localStorage.getItem(SPLIT_RATIO_KEY)) || 0.46, 0.2, 0.8);
  } catch {
    return 0.46;
  }
}

function persistSplitRatio(ratio: number) {
  try {
    localStorage.setItem(SPLIT_RATIO_KEY, String(ratio));
  } catch {
    // Split resizing remains available for the current session without storage.
  }
}

function loadColumnsPdfRatio(): number {
  try {
    return clamp(Number(localStorage.getItem(COLUMNS_PDF_RATIO_KEY)) || 0.38, 0.22, 0.55);
  } catch {
    return 0.38;
  }
}

function persistColumnsPdfRatio(ratio: number) {
  try {
    localStorage.setItem(COLUMNS_PDF_RATIO_KEY, String(ratio));
  } catch {
    // Columns PDF resizing remains available for the current session without storage.
  }
}

function loadNavigatorSplit(): number {
  try {
    return clamp(Number(localStorage.getItem(NAVIGATOR_SPLIT_KEY)) || 0.58, 0.2, 0.78);
  } catch {
    return 0.58;
  }
}

function persistNavigatorSplit(ratio: number) {
  try {
    localStorage.setItem(NAVIGATOR_SPLIT_KEY, String(ratio));
  } catch {
    // Navigator resizing remains available for the current session without storage.
  }
}

function dropDirectoryAt(position: { x: number; y: number }): string | null {
  const scale = window.devicePixelRatio || 1;
  const element = document.elementFromPoint(position.x / scale, position.y / scale);
  const directory = element?.closest<HTMLElement>("[data-drop-directory]")?.dataset.dropDirectory;
  if (directory) return directory;
  return element?.closest(".navigator") ? "figures" : null;
}

function dropEditorAt(position: { x: number; y: number }): { x: number; y: number } | null {
  const scale = window.devicePixelRatio || 1;
  const point = { x: position.x / scale, y: position.y / scale };
  return document.elementFromPoint(point.x, point.y)?.closest(".source-editor") ? point : null;
}

function persistPanelWidths(widths: PanelWidths) {
  try {
    localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Panel resizing remains available for the current session without storage.
  }
}

function resizePanelWidths(
  panel: PanelKind,
  start: PanelWidths,
  delta: number,
  navigatorOpen: boolean,
  agentOpen: boolean,
): PanelWidths {
  const canvasMinimum = 360;
  // One 5px handle per visible side panel.
  const handles = (navigatorOpen ? 5 : 0) + (agentOpen ? 5 : 0);
  if (panel === "navigator") {
    const agentWidth = agentOpen ? start.agent : 0;
    const maximum = Math.max(160, Math.min(420, window.innerWidth - agentWidth - canvasMinimum - handles));
    return { ...start, navigator: clamp(start.navigator + delta, 160, maximum) };
  }
  const navigatorWidth = navigatorOpen ? start.navigator : 0;
  const maximum = Math.max(260, Math.min(600, window.innerWidth - navigatorWidth - canvasMinimum - handles));
  return { ...start, agent: clamp(start.agent + delta, 260, maximum) };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export default App;
