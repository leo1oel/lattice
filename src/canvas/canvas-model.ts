import type { ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import type { AgentHostSurface, AgentPdfDocumentPlace, AgentSelectionLines } from "../agent/agent-host-context";
import type {
  AssetPreview, CanvasMode, CanvasRequests, EditorKeymap, EditorPosition, EditorViewState, FileViewState,
  PaperSourceRequest, PaperSummary, WordCount,
} from "../app-types";
import type { AnnotationRounds } from "../app/annotation-rounds";
import type { CompileDiagnostic } from "../build/compile-diagnostics";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import type { GrammarIgnores, IgnoreGrammar } from "../editor/harper-spellcheck";
import type { CompiledBuild } from "../editor/latex/compiled-labels";
import type { CitationInfo, DefinitionTarget, ReferenceInfo, SymbolTarget } from "../editor/latex/latex-text";
import type { OutlineNode } from "../editor/latex/latex-outline";
import type { MarkdownWorkspaceIndex } from "../editor/markdown/markdown-workspace-index";
import type { OpenSlideWorkspaceProps } from "../editor/presentation/open-slide-workspace";
import type { PresenceCursor, TrackedChangeTooltipActions } from "../overleaf/overleaf-editor-extensions";
import type { TrackedChange } from "../overleaf/use-overleaf-realtime";
import type { ResolvedCitationDraft } from "../papers/bib-entry-dialog";
import type { PaperSourceCitation } from "../papers/paper-source";
import type { AppLocale, Theme } from "../settings/app-settings";
import type { SwitchState } from "./after-switch";
import type { DeckHosts } from "./open-slide-deck-pool";
import type { OtOp } from "../overleaf/ot";
import type { SaveSlot } from "./save-slot";
import type { CitationReasonData } from "../editor/latex/citation-reasons";

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
  /** `base`, when given, is the source the edit was made on, and `typed` the edit (see `typeFileText`). */
  setSource: (value: string, base?: string, typed?: OtOp[]) => void;
  /** Whether `value` is the source as it came from outside the writer's editing (an agent, a collaborator), which is no undo step. */
  isOutsideSource?: (value: string) => boolean;
  onSave: () => Promise<boolean>;
  onVisualMarkdownFlushChange?: (flush: (() => boolean) | null) => void;
  onMarkdownModeViewportCaptureChange?: (capture: (() => void) | null) => void;
  /**
   * Hands App a way to end the source editor's completion, for the PDF panel:
   * turning to the PDF need not blur the editor, and an open completion holds
   * off the save that leaving it makes.
   */
  onCompletionCloseChange?: (close: (() => void) | null) => void;
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
  /** What the project's grammar check ignores, and the action that adds to it. */
  grammarIgnores?: GrammarIgnores;
  onIgnoreGrammar?: IgnoreGrammar;
  interactivePreviewsEnabled: boolean;
}>;

/** The project's citation, label, macro and path index, and the paper library behind it. */
type CanvasBibliography = Readonly<CitationReasonData & {
  /** Downloaded paper library backing the visual editor's `@` citation typeahead. */
  papers?: PaperSummary[];
  /** A .bib reference's paper, opened from the reference list: downloaded first when only cited. */
  onOpenPaper?: (paper: PaperSummary) => void;
  /** Open a library paper's PDF at a source link's page, its quote highlighted. */
  onOpenPaperSource?: (paper: PaperSummary, citation: PaperSourceCitation) => void;
  /** The Papers downloads under way (and just done), by paper key: the reference list shows their progress. */
  paperFetchStates?: Readonly<Record<string, "loading" | "success">>;
  /** A .bib reference's DOI, arXiv or web link. */
  onOpenUrl?: (url: string) => void;
  /** Whether a citation card's Open paper has a readable library paper or a source link to open. */
  canOpenCitation?: (key: string) => boolean;
  /** A citation card's Open paper, and its title: the readable library paper (at the page the citation names), else the source it cites. */
  onOpenCitation?: (key: string, page?: number) => void;
  /** Looks a citation up for the reference list's Add reference. */
  onResolveCitation?: (query: string) => Promise<ResolvedCitationDraft>;
  /** Changes after the manuscript was saved, so the reference list scans its citations again. */
  citationUsageRevision?: unknown;
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
  /** The last build that wrote a PDF; a `\ref` card shows the number and page its `.aux` gave the label. */
  compiledBuild?: CompiledBuild;
  projectPaths: string[];
  graphicsRoots: string[];
  /** The project's root document, whose folder TeX reads `\input` paths from. */
  rootDocumentPath?: string;
}>;

/** Jumps into the document and out of it: requests, view state, symbols, the outline and its dialogs. */
type CanvasNavigation = Readonly<{
  requests: CanvasRequests;
  /** Settle the request with this id (ids are unique across every kind). */
  onRequestHandled: (id: string) => void;
  /** A source link or cited page to show in its Paper's PDF, and how it is settled once shown. */
  paperSource?: PaperSourceRequest | null;
  onPaperSourceHandled?: (id: string) => void;
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
  outlineNodes: OutlineNode[];
  /** The manuscript's root document, which `outlineNodes` is the outline of. */
  outlineRootPath?: string;
  onOutlineNavigate: (path: string, line: number) => void;
  tableGeneratorOpen: boolean;
  onTableGeneratorOpenChange: (open: boolean) => void;
  onCreateMissingFile: (path: string) => void;
}>;

/**
 * The compiled project PDF as the document sees it: the outline rail reads
 * its headings' pages from it. The PDF itself is ProjectPdfPanel's.
 */
type CanvasPdf = Readonly<{
  pdfUrl: string | null;
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
  /** Saves a new note: the local annotation it became, "overleaf" when sent as an Overleaf thread, or null when refused. */
  onCreateEditorComment: (comment: EditorComment) => EditorComment | "overleaf" | null;
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
  onOpenSlideAgentRequest?: OpenSlideWorkspaceProps["onAgentRequest"];
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

/** Where the active document renders: its file panel's host. */
type CanvasHosts = Readonly<{
  editorHost: HTMLElement;
  /** The active board or sheet, its panel off screen long enough to unmount. */
  editorHibernated: boolean;
  hibernatedPlaceholder: ReactNode;
  /** Each open deck's host, and which decks sleep (see OpenSlideDeckPool). */
  decks: DeckHosts;
  /** A workspace or layout switch animating, which an asset's viewer waits out (see AfterSwitch). */
  switchState: SwitchState;
}>;
