/**
 * Shared domain type declarations extracted from `App.tsx`.
 *
 * These are the compile-time types that describe the app's core data (projects,
 * editor state, papers, build results, and so on). They live
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
  spellingWords?: string[];
};

export type WordCount = {
  text: number;
  headers: number;
  captions: number;
  total: number;
  source: string;
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
  /** Native, content-derived routing. v1 collaboration remains extension-scoped. */
  contentKind?: "directory" | "text" | "binary" | "symlink";
  size?: number;
  children: FileNode[];
};

export type ProjectSnapshot = {
  root: string;
  manifest: ProjectManifest;
  files: FileNode[];
};

export type GitFileStatus = {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
};

export type GitStatus = {
  available: boolean;
  repository: boolean;
  branch: string | null;
  remote?: string | null;
  remoteUrl?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  files: GitFileStatus[];
};

export type AssetPreview = ReferenceAssetPreview;

export type FigureDropRequest = {
  id: string;
  paths: string[];
  clientX: number;
  clientY: number;
  pane?: EditorPaneId;
};

export type FigurePointerDrag = {
  path: string;
  label: string;
  clientX: number;
  clientY: number;
  overCanvas: boolean;
  insertAtEditor: boolean;
};

export type SyncTexTarget = {
  path: string;
  line: number;
};

export type EditorNavigation = SyncTexTarget & { id: string };
export type EditorPosition = { path: string; line: number; column: number };
export type PdfSyncResponse = Omit<PdfSyncTarget, "id">;

export type BuildResult = {
  success: boolean;
  hasPdf: boolean;
  log: string;
  durationMs: number;
  diagnostics: CompileDiagnostic[];
  /** Project-relative path of the document the build actually compiled. */
  rootDocument: string;
};

export type PaperSummary = {
  arxivId: string;
  /** Normalized DOI from the authoritative bibliography entry. */
  doi?: string;
  /** The cited page for webpage references; how the row fetches when there is no arXiv id. */
  url?: string;
  title: string;
  /** BibTeX author field, used by the local Papers filter. */
  authors?: string;
  citationKey?: string;
  /** False for works that are only cited — there is nothing to open. */
  hasFullText: boolean;
  /** True only when blog.md is already available locally. */
  hasBlog: boolean;
  /** Converter-owned files needed to render figures in the paper reader. */
  assetPaths?: string[];
  /** Advisory DOI-exact update metadata from Crossref. */
  citationHealth?: CitationHealth;
};

export type CitationHealth = {
  kind: "retracted" | "expressionOfConcern" | "corrected" | "replaced" | "unknown" | "unavailable";
  updateType?: string;
  source?: string;
  date?: string;
  link?: string;
  checkedAt: string;
  stale?: boolean;
};

export type RenameTarget =
  | { kind: "label"; label: string }
  | { kind: "citation"; key: string }
  | { kind: "environment"; name: string }
  | { kind: "wrap-environment" };

export type RenameSymbolResult = {
  changedFiles: string[];
  occurrenceCount: number;
  transactionId: string;
};

export type CanvasMode = "source" | "pdf" | "split" | "dual" | "columns" | "asset";
export type EditorPaneId = "primary" | "secondary";
export type DocumentViewMode = "source" | "split" | "pdf" | "dual" | "columns";
export type SettingsTab = "appearance" | "editor" | "agent" | "mcp" | "overleaf" | "api" | "doctor" | "logs";
export type CiteCommand = "cite" | "citep" | "citet";
export type InsertSymbolCommand = CiteCommand | "ref" | "eqref";
export type DoctorCheck = { name: string; detail: string; ok: boolean };
export type DoctorReport = { ok: boolean; summary: string; checks: DoctorCheck[] };
export type EditorKeymap = "default" | "vim" | "emacs";

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
