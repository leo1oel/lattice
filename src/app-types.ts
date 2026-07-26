/**
 * Shared domain type declarations extracted from `App.tsx`.
 *
 * These are the compile-time types that describe the app's core data (projects,
 * editor state, agent sessions, papers, build results, and so on). They live
 * here so `App.tsx` and future modules can import them without pulling in the
 * whole component. Types are erased at runtime, so this file has no runtime cost.
 */
import type { ReferenceAssetPreview } from "./reference-preview";
import type { PdfSyncTarget } from "./pdf-viewer";
import type { CompileDiagnostic } from "./compile-diagnostics";

export type RootDocument = {
  path: string;
  name: string;
  isDefault: boolean;
};

export type ProjectVenue = "neurips" | "icml" | "iclr";

export type ProjectManifest = {
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

export type WordCount = {
  text: number;
  headers: number;
  captions: number;
  total: number;
  source: string;
};

export type AgentToolStep = {
  id: string;
  name: string;
  detail: string;
  phase: "start" | "end";
};

export type UnusedSymbols = {
  labels: string[];
  citations: string[];
};

export type ReplaceResult = {
  filesChanged: string[];
  replacements: number;
};

export type EditorViewState = {
  cursor: number;
  scrollTop: number;
};

export type NavigationEntry = {
  path: string;
  line: number;
};

export type FileNode = {
  name: string;
  path: string;
  kind: string;
  children: FileNode[];
};

export type ProjectSnapshot = {
  root: string;
  manifest: ProjectManifest;
  files: FileNode[];
};

export type AssetPreview = ReferenceAssetPreview;

export type FigureDropRequest = {
  id: string;
  paths: string[];
  clientX: number;
  clientY: number;
};

export type FigurePointerDrag = {
  path: string;
  label: string;
  clientX: number;
  clientY: number;
  overEditor: boolean;
};

export type SyncTexTarget = {
  path: string;
  line: number;
};

export type EditorNavigation = SyncTexTarget & { id: string };
export type EditorPosition = { path: string; line: number; column: number };
export type PdfSyncResponse = Omit<PdfSyncTarget, "id">;

export type ProjectSearchResult = {
  kind: "file" | "paper";
  path: string;
  title: string;
  snippet: string;
  line?: number | null;
  arxivId?: string;
  fileKind?: string;
};

export type BuildResult = {
  success: boolean;
  pdfBase64?: string;
  log: string;
  durationMs: number;
  diagnostics: CompileDiagnostic[];
};

export type AgentResult = {
  summary: string;
  changedFiles: string[];
  transactionId?: string;
  skillsUsed: string[];
};

export type AgentStreamEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string }
  | { type: "cancellable"; enabled: boolean }
  | { type: "tool"; name: string; detail: string; phase: string };

export type PaperSummary = {
  arxivId: string;
  title: string;
  citationKey?: string;
  /** False for works that are only cited — there is nothing to open. */
  hasFullText: boolean;
};

export type RenameTarget =
  | { kind: "entry"; path: string; name: string }
  | { kind: "paper"; paper: PaperSummary }
  | { kind: "label"; label: string }
  | { kind: "citation"; key: string }
  | { kind: "environment"; name: string }
  | { kind: "wrap-environment" };

export type RenameSymbolResult = {
  changedFiles: string[];
  occurrenceCount: number;
  transactionId: string;
};

/** One chronological slice of an agent turn: something it said, or something it did. */
export type ChatPart =
  | { kind: "text"; text: string }
  | ({ kind: "tool" } & AgentToolStep);

export type ChatMessage = {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  files?: string[];
  skills?: string[];
  /** Absent on user/system turns; the bubble falls back to `text` then. */
  parts?: ChatPart[];
};

export type AgentSession = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  provider: AgentProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  messages: ChatMessage[];
};

export type AgentSessionSummary = {
  id: string;
  title: string;
  updatedAt: string;
  provider: AgentProvider;
  model: string;
  reasoningEffort: ReasoningEffort;
  messageCount: number;
};

export type AgentSessionSearchResult = AgentSessionSummary & { snippet: string };
export type AgentSkill = {
  name: string;
  description: string;
  scope: "built-in" | "application" | "project";
  enabled: boolean;
  editable: boolean;
  overridden: boolean;
  content: string;
};
export type SkillDraft = { originalName?: string; scope: "application" | "project"; content: string };
export type McpTransport = "stdio" | "http" | "sse";
export type McpServer = {
  name: string;
  scope: "application" | "project";
  enabled: boolean;
  overridden: boolean;
  transport: string;
  command?: string | null;
  args: string[];
  env: Record<string, string>;
  cwd?: string | null;
  url?: string | null;
  headers: Record<string, string>;
  summary: string;
};
export type McpServerDraft = {
  originalName?: string;
  scope: "application" | "project";
  name: string;
  enabled: boolean;
  transport: McpTransport;
  command: string;
  argsText: string;
  envText: string;
  cwd: string;
  url: string;
  headersText: string;
};
export type AgentMention = { key: string; label: string; path: string; kind: "file" | "paper" };
export type MentionState = { start: number; end: number; query: string };

export type CanvasMode = "source" | "pdf" | "split" | "dual" | "columns" | "paper" | "asset";
export type EditorPaneId = "primary" | "secondary";
export type DocumentViewMode = "source" | "split" | "pdf" | "dual" | "columns";
export type AgentProvider = "codex" | "claude" | "openai-api" | "anthropic-api";
export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type SettingsTab = "appearance" | "editor" | "agent" | "mcp" | "accounts" | "overleaf" | "api" | "doctor";
export type CiteCommand = "cite" | "citep" | "citet";
export type InsertSymbolCommand = CiteCommand | "ref" | "eqref";
export type DoctorCheck = { name: string; detail: string; ok: boolean };
export type DoctorReport = { ok: boolean; summary: string; checks: DoctorCheck[] };
export type EditorKeymap = "default" | "vim" | "emacs";
export type SubscriptionStatus = { provider: "codex" | "claude"; installed: boolean; loggedIn: boolean; detail: string };
export type ModelOption = { value: string; label: string; efforts: ReasoningEffort[] };

/** What the agent runtime says it can run, and how hard it can think. */
export type AgentModel = { value: string; label: string; efforts: string[] };

/** Which agent runtime is in use, and whether a newer one is published. */
export type AgentRuntimeStatus = {
  current: string;
  bundled: string;
  latest: string | null;
  updateAvailable: boolean;
  detail: string | null;
};

// ---- Overleaf bridge ----------------------------------------------------
// Shapes mirror the Rust `overleaf` module's serde camelCase output exactly.

export type OverleafStatus = {
  connected: boolean;
  email: string | null;
  name: string | null;
  host: string;
};
export type OverleafLoginPoll = {
  status: "pending" | "connected" | "cancelled";
  session: OverleafStatus | null;
  /** Why sign-in is still pending, when the backend knows a reason. */
  detail?: string | null;
};
export type OverleafProject = {
  id: string;
  name: string;
  lastUpdated: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  accessLevel: string | null;
  archived: boolean;
  trashed: boolean;
};
/** What "Open from Overleaf" would do with a project, before it does it. */
export type CloneTarget = {
  /**
   * `open` — already linked to this folder, so opening it is all that happens.
   * `fresh` — nothing in the way, it downloads.
   * `occupied` — a folder of that name holds files but is linked to nothing,
   * which is exactly what Stop syncing leaves behind.
   */
  kind: "open" | "fresh" | "occupied";
  path: string;
  folder: string;
};
export type OverleafLink = {
  projectId: string;
  projectName: string;
  host: string;
  lastSync: string | null;
  /** Linked, but not syncing until it is resumed. */
  paused: boolean;
};
export type OverleafConflict = {
  path: string;
  localCopy: string;
  /**
   * Whether the file has conflict markers to work through. False for one that
   * could not be merged line by line at all — a figure, a PDF — where
   * Overleaf's version takes the path and yours is kept beside it.
   */
  markers?: boolean;
};
/** What a pending sync would do to one file, before anything is written. */
export type OverleafChangeKind =
  | "incoming"
  | "outgoing"
  | "merge"
  | "conflict"
  | "deleteLocal"
  | "skippedRemoteDelete";
export type OverleafChange = {
  path: string;
  kind: OverleafChangeKind;
  /** The file as it stands locally; null when it does not exist here yet. */
  before: string | null;
  /** What it becomes if applied; null when it would be deleted. */
  after: string | null;
  binary: boolean;
};
export type OverleafPreview = {
  changes: OverleafChange[];
  remoteVersion: number | null;
};

export type OverleafProbe = {
  changed: boolean;
  /** False when this Overleaf gives no version to compare against. */
  versionKnown: boolean;
  remoteVersion: number | null;
  lastSync: string | null;
};
/** One message in the project's Overleaf chat. */
export type OverleafMessage = {
  id: string;
  content: string;
  authorName: string;
  authorEmail: string | null;
  /** Milliseconds since the epoch, as Overleaf reports it. */
  timestamp: number;
  /** True when this account wrote it, so the panel can side it. */
  mine: boolean;
};

/** One message in an Overleaf comment thread. */
export type OverleafComment = {
  id: string;
  content: string;
  authorName: string;
  authorEmail: string | null;
  timestamp: number;
  mine: boolean;
};

/** A comment thread: everything said about one spot in the project. */
export type OverleafThread = {
  id: string;
  messages: OverleafComment[];
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
};

export type OverleafSyncResult = {
  pulled: string[];
  pushed: string[];
  /** Files where both sides had edits that combined cleanly. */
  merged: string[];
  conflicts: OverleafConflict[];
  deletedLocal: string[];
  skippedRemoteDeletes: string[];
  /** Left behind for being bigger than Overleaf will take. */
  skippedLarge?: string[];
};

// ---- Git version timeline ------------------------------------------------
// Shapes mirror the Rust `git` module's serde camelCase output exactly.

export type GitLogFileKind = "added" | "modified" | "deleted" | "renamed";
export type GitLogFile = { path: string; kind: GitLogFileKind };
export type GitLogEntry = {
  hash: string;
  shortHash: string;
  authorName: string;
  timestamp: string;
  message: string;
  files: GitLogFile[];
};
export type GitFileDiff = {
  before: string | null;
  after: string | null;
  binary: boolean;
};
