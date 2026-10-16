import type { ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import type { AgentHostSurface, AgentPdfDocumentPlace, AgentSelectionLines } from "../agent/agent-host-context";
import type {
  AssetPreview, CanvasMode, CanvasRequests, EditorKeymap, EditorPosition, EditorViewState, EnglishVariant, FileViewState,
  PaperSummary, TermRule, WordCount,
} from "../app-types";
import type { AnnotationRounds } from "../app/annotation-rounds";
import type { CompileDiagnostic } from "../build/compile-diagnostics";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import type { CitationInfo, DefinitionTarget, ReferenceInfo, SymbolTarget } from "../editor/latex/latex-text";
import type { OutlineNode } from "../editor/latex/latex-outline";
import type { MarkdownWorkspaceIndex } from "../editor/markdown/markdown-workspace-index";
import type { OpenSlideWorkspaceProps } from "../editor/presentation/open-slide-workspace";
import type { PresenceCursor, TrackedChangeTooltipActions } from "../overleaf/overleaf-editor-extensions";
import type { TrackedChange } from "../overleaf/use-overleaf-realtime";
import type { ResolvedCitationDraft } from "../papers/bib-entry-dialog";
import type { PdfSyncTarget } from "../pdf/pdf-viewer";
import type { AppLocale, Theme } from "../settings/app-settings";
import type { SwitchState } from "./after-switch";
import type { DeckHosts } from "./open-slide-deck-pool";
import type { SaveSlot } from "./save-slot";

/**
 * What App hands DocumentCanvas, one model per domain. Grouping names who
 * consumes what; it removes no dependency, so each model still changes
 * whenever any of its fields does. Keep the high-rate document buffer out of
 * the other models, and read fields (not whole models) in effect and memo
 * dependencies, so a keystroke does not look like a bibliography change.
 */
export type DocumentCanvasProps = Readonly<{
  document: CanvasDocument;
  preferences: CanvasPreferences;
  bibliography: CanvasBibliography;
  navigation: CanvasNavigation;
  pdf: CanvasPdf;
  review: CanvasReview;
  selection: CanvasSelection;
  assets: CanvasAssets;
  status: CanvasStatus;
  hosts: CanvasHosts;
}>;

/** The document in front (a file, an asset or a Paper), its text and its editor's lifecycle. */
type CanvasDocument = Readonly<{
  mode: CanvasMode;
  source: string;
  /** `source` as of the last pause in typing, for document-wide counts and the breadcrumb (useSettledSource); defaults to `source`. */
  settledSource?: string;
  markdownPreviewSource?: string;
  activeFile: string;
  setSource: (value: string) => void;
  onSave: () => Promise<boolean>;
  onVisualMarkdownFlushChange?: (flush: (() => boolean) | null) => void;
  onMarkdownModeViewportCaptureChange?: (capture: (() => void) | null) => void;
  onEditorLeave: () => void;
  onCompletionActiveChange: (active: boolean) => void;
  /** Remounts the source editor when it changes: the open file, or the Paper. */
  editorKey: string;
  editorEditable: boolean;
  activeAsset: AssetPreview | null;
  /** The active asset was rewritten on disk: read its new version. */
  onActiveAssetChanged?: () => void;
  /** The active asset was removed from the project while open. */
  activeAssetMissing?: boolean;
  activePaper: PaperSummary | null;
  /** Whether a Paper's original PDF is on screen in place of its Markdown. */
  onPaperPdfOpenChange?: (open: boolean) => void;
  onOpenMarkdownPath: (path: string) => void;
  onViewMarkdownSource: () => void;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  /** The project's open tabs: every deck among them stays loaded (see OpenSlideDeckPool). */
  openPaths: readonly string[];
}>;

/** The project and the user's editor settings. */
type CanvasPreferences = Readonly<{
  projectRoot: string;
  locale: AppLocale;
  theme: Theme;
  editorKeymap: EditorKeymap;
  editorSpellcheck: boolean;
  spellingWords: string[];
  onAddSpellingWord: (word: string) => boolean | Promise<boolean>;
  /** The project's English, which spell checking and Proofread follow. */
  englishVariant: EnglishVariant | null;
  /** The project's term rules, which Proofread and Polish follow. */
  termRules: readonly TermRule[];
  interactivePreviewsEnabled: boolean;
}>;

/** The project's citation, label, macro and path index, and the paper library behind it. */
type CanvasBibliography = Readonly<{
  /** Downloaded paper library backing the visual editor's `@` citation typeahead. */
  papers?: PaperSummary[];
  /** A .bib reference's library paper, opened from the reference list. */
  onOpenPaper?: (paper: PaperSummary) => void;
  /** A .bib reference's DOI, arXiv or web link. */
  onOpenUrl?: (url: string) => void;
  /** Looks a citation up for the reference list's Add reference. */
  onResolveCitation?: (query: string) => Promise<ResolvedCitationDraft>;
  /** Changes after the manuscript was saved, so the reference list scans its citations again. */
  citationUsageRevision?: unknown;
  canOpenCitation: (key: string) => boolean;
  onOpenCitation: (key: string) => void;
  citationKeys: string[];
  citations: CitationInfo[];
  references: ReferenceInfo[];
  /** The project's citation and label index has not landed yet. */
  indexPending?: boolean;
  unusedLabels: string[];
  unusedCitations: string[];
  onLoadReferenceImage: (path: string) => Promise<string | null>;
  referenceImageGeneration?: number;
  localMacros: { label: string; detail: string; type: "keyword" | "type" }[];
  katexMacros: Record<string, string>;
  projectPaths: string[];
  graphicsRoots: string[];
}>;

/** Jumps into the document and out of it: requests, view state, symbols, the outline and its dialogs. */
type CanvasNavigation = Readonly<{
  requests: CanvasRequests;
  /** Settle the request with this id (ids are unique across every kind). */
  onRequestHandled: (id: string) => void;
  onEditorPosition: (position: EditorPosition) => void;
  onViewState: (path: string, state: EditorViewState) => void;
  getFileViewState?: (path: string) => FileViewState | undefined;
  onFileViewState?: (path: string, update: Partial<FileViewState>) => void;
  onGotoDefinition: (target: DefinitionTarget) => void;
  onTexlabGoto: (path: string, line: number, column?: number) => void;
  onFindReferences: (target: SymbolTarget) => void;
  onRenameSymbol: (target: SymbolTarget) => void;
  onRenameEnvironment: (name: string) => void;
  onWrapEnvironment: () => void;
  onGotoLineRequest: () => void;
  outlineOpen: boolean;
  onOutlineOpenChange: (open: boolean) => void;
  outlineNodes: OutlineNode[];
  activeOutlineId: string | null;
  /** The manuscript's root document, which `outlineNodes` is the outline of. */
  outlineRootPath?: string;
  onOutlineNavigate: (path: string, line: number) => void;
  tableGeneratorOpen: boolean;
  onTableGeneratorOpenChange: (open: boolean) => void;
  onCreateMissingFile: (path: string) => void;
}>;

/** The compiled project PDF: its build, SyncTeX in both directions and its pages. */
type CanvasPdf = Readonly<{
  pdfUrl: string | null;
  pdfBytes?: ArrayBuffer | null;
  /** Builds the project from the PDF panel while it has no PDF yet. */
  onBuildProject?: () => void;
  building?: boolean;
  buildShortcut?: string;
  pdfTop?: ReactNode;
  pdfSyncTarget: PdfSyncTarget | null;
  canForwardSync: boolean;
  locatingPdf: boolean;
  onForwardSync: () => void;
  onPdfSource: (page: number, x: number, y: number) => void;
  onPdfPageCount: (pages: number | null) => void;
  onPdfPageChange: (page: number) => void;
}>;

/** Annotations, comments and a linked Overleaf project's live review. */
type CanvasReview = Readonly<{
  editorComments: EditorComment[];
  /** Other people's carets in the document Overleaf is carrying live. */
  overleafPresenceCursors: PresenceCursor[];
  /** Suggestions in that document, and what can be done about one. */
  overleafChanges: TrackedChange[];
  /** Margin review over the source editor (a linked Overleaf project's comments and suggestions), drawn into its view. */
  sourceMargin?: (view: EditorView) => ReactNode;
  overleafTrackChangeActions: TrackedChangeTooltipActions;
  activeEditorCommentId: string | null;
  commentAuthorName: string;
  commentAuthorId: string;
  /** Saves a new note; resolves to the local annotation it became, or null (an Overleaf thread, or none). */
  onCreateEditorComment: (comment: EditorComment) => EditorComment | Promise<boolean> | null;
  /** The revision rounds over the local annotations: the review card, Revise, the PDF's marks. */
  annotationRounds: AnnotationRounds;
  onOpenEditorComments: () => void;
  /** Resolve from a comment's card on the document, which offers it back in a toast. */
  onResolveEditorComment: (id: string) => void;
  /** Open the comments panel at this comment's reply (a click on a comment in the visual Markdown editor). */
  onReplyEditorComment: (commentId: string) => void;
  /** Post a reply written in a comment's card on the document. */
  onPostEditorCommentReply: (commentId: string, body: string) => void;
  commentFocusRequest: { id: string; nonce: string } | null;
  onCommentFocusHandled: (nonce: string) => void;
}>;

/** What the agent hears about the user's selection and the surface in use. */
type CanvasSelection = Readonly<{
  /** `lines` places a source-editor selection in its file (1-based, inclusive). */
  setSelection: (value: string, lines?: AgentSelectionLines) => void;
  /** `place` names a project PDF open as a document; without it the text is from the compiled preview. */
  onPdfTextSelect: (value: string, place?: AgentPdfDocumentPlace) => void;
  onPaperTextSelect: (value: string) => void;
  onContextSurfaceActivate: (surface: AgentHostSurface) => void;
}>;

/** Figures, pasted and dropped files, and slide decks' writes into the project. */
type CanvasAssets = Readonly<{
  onImportAsset?: (file: File) => Promise<string | null>;
  onOpenSlideMutation: OpenSlideWorkspaceProps["onMutation"];
  onOpenSlideContext?: OpenSlideWorkspaceProps["onContext"];
  onOpenSlideError?: (message: string) => void;
  onPrepareFigure: (path: string) => Promise<string | null>;
  onPasteImageFile: (file: File) => boolean | void;
  nativeFigureDropActive: boolean;
  fileDropTargetActive: boolean;
}>;

/** The editor status bar's counts and save slot, and the diagnostics its editors lint with. */
type CanvasStatus = Readonly<{
  todoCount: number;
  onOpenTodos: () => void;
  projectWordCount: WordCount | null;
  /** What the status bar's save slot shows, and its actions. */
  saveSlot?: SaveSlot;
  buildDiagnostics: CompileDiagnostic[];
  texlabDiagnostics: CompileDiagnostic[];
}>;

/**
 * Where the active document renders (its file panel's host) and where the
 * project PDF renders (the PDF panel's host; null while that panel is
 * closed or hibernated).
 */
type CanvasHosts = Readonly<{
  editorHost: HTMLElement;
  pdfHost: HTMLElement | null;
  /** The active board or sheet, its panel off screen long enough to unmount. */
  editorHibernated: boolean;
  hibernatedPlaceholder: ReactNode;
  /** Each open deck's host, and which decks sleep (see OpenSlideDeckPool). */
  decks: DeckHosts;
  /** A workspace or layout switch animating, which an asset's viewer waits out (see AfterSwitch). */
  switchState: SwitchState;
}>;
