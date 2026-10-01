/**
 * The app's shared domain model: projects, editor and view state, papers,
 * builds, and the Overleaf and Git wire shapes the Rust side serializes.
 */
import type { ReferenceAssetPreview } from "./project/reference-preview";
import type { PdfSyncTarget } from "./pdf/pdf-viewer";
import type { CompileDiagnostic } from "./build/compile-diagnostics";

type RootDocument = {
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

type SpreadsheetSheetViewState = {
  zoomRatio: number;
  scrollTop: number;
  scrollLeft: number;
};

export type SpreadsheetFileViewState = {
  activeSheetId: string;
  activeRange?: string;
  activeCell?: string;
  sheets: Record<string, SpreadsheetSheetViewState>;
};

export type PdfFileViewState = {
  page: number;
  scale: number;
  fitMode: "width" | "height" | null;
  scrollTop: number;
  scrollLeft: number;
};

export type BoardFileViewState = {
  pageId: string;
  camera: { x: number; y: number; z: number };
};

export type OpenSlideFileViewState = {
  page: number;
};

type ScrollFileViewState = {
  scrollTop: number;
  scrollLeft?: number;
  scrollRange?: number;
};

export type ImageFileViewState = ScrollFileViewState & {
  scale: number;
};

export type HtmlFileViewState = ImageFileViewState;

/**
 * Per-user view state only. These values are stored in Lattice's local app
 * settings and must never be serialized into project files or shared Y.Docs.
 */
export type FileViewState = {
  text?: EditorViewState;
  spreadsheet?: SpreadsheetFileViewState;
  pdf?: PdfFileViewState;
  board?: BoardFileViewState;
  image?: ImageFileViewState;
  html?: HtmlFileViewState;
  openSlide?: OpenSlideFileViewState;
  visualMarkdown?: ScrollFileViewState;
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

type FigureDropRequest = {
  id: string;
  paths: string[];
  clientX: number;
  clientY: number;
};

/** A line in a project file: a SyncTeX jump target, or a back/forward history entry. */
export type SyncTexTarget = { path: string; line: number };
export type NavigationEntry = SyncTexTarget;

type EditorNavigation = SyncTexTarget & { id: string };
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

type CitationHealth = {
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

export type DocumentViewMode = "source" | "split" | "pdf";
export type CanvasMode = DocumentViewMode | "asset";
export type SettingsTab = "appearance" | "editor" | "agent" | "mcp" | "overleaf" | "literature" | "api" | "doctor" | "logs";
type CiteCommand = "cite" | "citep" | "citet";
export type InsertSymbolCommand = CiteCommand | "ref" | "eqref";
type DoctorCheck = { name: string; detail: string; ok: boolean; code?: string; params?: Record<string, string> };
export type DoctorReport = { ok: boolean; summary: string; checks: DoctorCheck[] };
export type EditorKeymap = "default" | "vim" | "emacs";

// ---- Callbacks App hands to the modules split out of it -------------------

export type OpenProjectFile = (
  path: string,
  line?: number,
  options?: { revealSource?: boolean },
) => Promise<void>;
export type RefreshProject = (scope?: { expectedRoot: string; generation: number }) => Promise<ProjectSnapshot>;
export type CompileProject = (force?: boolean, sound?: boolean, options?: { consumeAgentAssociations?: boolean }) => Promise<void>;
/** Put the caret (a character offset) and scroll position back in a file. */
export type ViewRestoreRequest = { path: string; cursor: number; scrollTop: number; id: string };
/** One-shot requests App hands the canvas; each is answered once and settled by its id. */
export type CanvasRequests = {
  /** Jump the editor holding `path` to a line. */
  navigation: EditorNavigation | null;
  /** Put a reopened file's cursor and scroll back where they were. */
  restore: ViewRestoreRequest | null;
  /** Rename the environment around the caret. */
  rename: { newName: string; id: string } | null;
  /** Wrap the selection in a new environment. */
  wrap: { name: string; id: string } | null;
  /** Insert `\cite{key}`-style commands at the caret. */
  cite: { key: string; command: InsertSymbolCommand; id: string } | null;
  /** Insert imported figures where they were dropped (or at the caret). */
  figure: FigureDropRequest | null;
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
type OverleafConflict = {
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
  | "skippedRemoteDelete"
  | "refusedIncoming";
type OverleafChange = {
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
  /** True only when the caller requested a one-time local baseline check. */
  localChanged: boolean;
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

/** One message in an Overleaf comment thread; the same shape as a chat message. */
export type OverleafComment = OverleafMessage;

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
  /** App-owned transient paths that should be removed without prompting. */
  automaticRemoteDeletes?: string[];
  /** Left behind for being bigger than Overleaf will take. */
  skippedLarge?: string[];
  /**
   * Kept as they are here although Overleaf's download had them empty or
   * cut to a fraction, with no change in Overleaf's history to show for it.
   * Each is listed once per Overleaf copy, not again on every sync.
   */
  refusedIncoming?: string[];
  readOnly?: boolean;
};

// ---- Git version timeline ------------------------------------------------
// Shapes mirror the Rust `git` module's serde camelCase output exactly.

export type GitLogFileKind = "added" | "modified" | "deleted" | "renamed";
type GitLogFile = { path: string; kind: GitLogFileKind };
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
