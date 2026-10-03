import {
  Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type DragEvent, type FocusEvent, type HTMLAttributes, type PointerEventHandler, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { CodeMirrorHost as CodeMirror } from "../editor/codemirror-host";
import { paperDropExtension } from "../editor/paper-drop";
import { closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { redo as redoCodeMirror, undo as undoCodeMirror } from "@codemirror/commands";
import { forceLinting as refreshLint, linter } from "@codemirror/lint";
import type { Extension, TransactionSpec } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { paperAuthorNames } from "../papers/paper-identity";
import { paperSourceCitation } from "../papers/paper-source";
import {
  overleafCursorsExtension, overleafTrackChangesExtension, setOverleafCursorsEffect,
  type PresenceCursor, type TrackedChangeTooltipActions,
} from "../overleaf/overleaf-editor-extensions";
import type { TrackedChange } from "../overleaf/use-overleaf-realtime";
import type { MarkdownWorkspaceIndex } from "../editor/markdown/markdown-workspace-index";
import { restoreViewportAround } from "./viewport-restore";
import { latexEditorExtensions, latexIndexChanged, textEditorExtensions } from "../editor/latex/latex-editor";
import { latex } from "../editor/latex/latex-language";
import { wrapEnvironment, wrapRange } from "../editor/latex/latex-edits";
import { renameEnvironmentAt } from "../editor/latex/latex-environments";
import type { CitationInfo, DefinitionTarget, ReferenceInfo, SymbolTarget } from "../editor/latex/latex-text";
import { harperDictionaryChanged } from "../editor/harper-spellcheck";
import { lineTarget, revealInEditor } from "../editor/editor-reveal";
import type { VisualRevealTarget } from "../editor/markdown/visual-editor-props";
import { LatexSelectionToolbar, SELECTION_TOOLBAR_SURFACES, type LatexSelectionAction, type LatexSelectionToolbarPosition } from "../editor/latex/latex-selection-toolbar";
import { ScrollArea } from "../components/ui/scroll-area";
import { InlineMessage } from "../components/ui/inline-message";
import { latexFigureInsertion, markdownAssetInsertion, type FigureInsertOptions } from "../editor/insert/figure-insertion";
import { FigureInsertDialog } from "../editor/insert/figure-insert-dialog";
import { createEditorComment, resolveCommentAnchor, type EditorComment } from "../editor/comments/editor-comment-data";
import {
  editorCommentsExtension, setEditorCommentsEffect, setEditorCommentDraftEffect, type EditorCommentLocalization,
  type EditorCommentsExtensionOptions,
} from "../editor/comments/editor-comments";
import { clamp, type AppLocale, type Theme } from "../settings/app-settings";
import { editorDiagnosticsForFile, type CompileDiagnostic } from "../build/compile-diagnostics";
import { editorTexlabDiagnosticsForFile } from "../build/texlab-diagnostics";
import { DocumentOutline } from "./document-outline";
import { sectionBreadcrumbNodes, type OutlineNode } from "../editor/latex/latex-outline";
import { MathPreview } from "../editor/latex/math-preview";
import { TableGeneratorDialog } from "../editor/insert/table-generator-dialog";
import type { PdfSyncTarget } from "../pdf/pdf-viewer";
import {
  SPLIT_PREVIEW_MIN_WIDTH, SPLIT_SOURCE_MIN_WIDTH,
} from "../app/window-layout";
import type {
  WordCount, EditorViewState, FileViewState, AssetPreview, CanvasRequests, EditorPosition, PaperSummary, CanvasMode,
  EditorKeymap,
} from "../app-types";
import {
  isHarperProseFilePath, isHtmlFilePath, isOpenSlideDeckPath, isPreviewableSourceFilePath, markdownFrontmatterEnd,
  PROJECT_FIGURE_DRAG_TYPE,
} from "../app-utils";
import type { AgentHostSurface } from "../agent/agent-host-context";
import { frameCoalescer, onLayoutChange } from "../app/effect-helpers";
import { useLatestRef } from "../hooks/use-latest-ref";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";
import {
  BoardEditor, DeferredVisualMarkdownEditor, HtmlPreviewLoading, MarkdownPreviewLoading, OpenSlideWorkspace, PdfPreview,
  PdfPreviewLoading, SpreadsheetEditor,
} from "./canvas-lazy-editors";
import { CodeMirrorScrollbar } from "./codemirror-scrollbar";
import { CommentComposer, type CommentDraft } from "./comment-composer";
import { EditorStatusBar } from "./editor-status-bar";
import { isLatexSourcePath, useOptionalKeymapExtensions, useTextLanguageExtensions } from "./editor-extensions";
import { HtmlPreview } from "./html-preview";
import {
  captureViewport, minimalTextChange, rangesWithinPreview, restoreViewport, spliceMarkdownBody, useSettledPreviewText,
} from "./markdown-preview-sync";
import { PaperReader } from "./paper-reader";
import { captureReadingAnchor, restoreReadingAnchor } from "../editor/markdown/reading-anchor";
import { ProjectAssetPreview } from "./project-asset-preview";
import { useMarkdownModeHandoff } from "./use-markdown-mode-handoff";
import { useMarkdownSplitScroll } from "./use-markdown-split-scroll";
import { usePaperPdf } from "./use-paper-pdf";
import { useSplitLayout, type SplitMinimums } from "./use-split-layout";


/** LaTeX wrappers the floating selection toolbar applies; null declines the edit. */
const SPLIT_MINIMUMS: SplitMinimums = { source: SPLIT_SOURCE_MIN_WIDTH, preview: SPLIT_PREVIEW_MIN_WIDTH };

const SELECTION_WRAPS: Record<Exclude<LatexSelectionAction, "comment">, (value?: string) => [string, string] | null> = {
  bold: () => ["\\textbf{", "}"],
  italic: () => ["\\textit{", "}"],
  underline: () => ["\\underline{", "}"],
  strikethrough: () => ["\\sout{", "}"],
  highlight: (value) => {
    const color = value?.trim() || "yellow";
    const hex = color.match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
    return hex ? [`\\colorbox[HTML]{${hex[1].toUpperCase()}}{`, "}"] : [`\\colorbox{${color}}{`, "}"];
  },
  heading: (value) => [`\\${value || "section"}{`, "}"],
  quote: () => ["\\begin{quote}\n", "\n\\end{quote}"],
  link: (value) => {
    const url = value?.trim();
    if (!url) return null;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- percent-encodings
    const safeUrl = url.replace(/\\/g, "%5C").replace(/\{/g, "%7B").replace(/\}/g, "%7D");
    return [`\\href{${safeUrl}}{`, "}"];
  },
};

type StructuredDocumentKind = "board" | "spreadsheet" | "presentation";

/** A navigation or comment focus for the visual Markdown editor, answered by `kind`'s handler. */
type VisualReveal = { id: string; kind: "navigation" | "comment"; target: VisualRevealTarget };

function structuredDocumentKind(path: string): StructuredDocumentKind | null {
  if (path.toLocaleLowerCase().endsWith(".tldr")) return "board";
  if (isSpreadsheetPath(path)) return "spreadsheet";
  return isOpenSlideDeckPath(path) ? "presentation" : null;
}

/** The document position under a screen point, or null while CodeMirror has no layout to answer from. */
function positionAtPoint(view: EditorView, point: { x: number; y: number }): number | null {
  try {
    return view.posAtCoords(point);
  } catch {
    return null;
  }
}

/** Apply `spec` to `view`, scrolling the result into view, and hand the editor focus back. */
function editAndFocus(view: EditorView, spec: TransactionSpec) {
  view.dispatch({ ...spec, scrollIntoView: true });
  view.focus();
}

/** Hand App `value` through `register` while this canvas is mounted with both. */
function useRegistration<T>(register: ((value: T | null) => void) | undefined, value: T) {
  useLayoutEffect(() => {
    if (!register) return;
    register(value);
    return () => register(null);
  }, [register, value]);
}

export function DocumentCanvas(props: {
  projectRoot: string;
  locale: AppLocale;
  theme: Theme;
  mode: CanvasMode;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  source: string;
  /** `source` as of the last pause in typing, for document-wide counts and the breadcrumb (useSettledSource); defaults to `source`. */
  settledSource?: string;
  markdownPreviewSource?: string;
  activeFile: string;
  setSource: (value: string) => void;
  onSave: () => Promise<boolean>;
  onVisualMarkdownFlushChange?: (flush: (() => boolean) | null) => void;
  onMarkdownModeViewportCaptureChange?: (capture: (() => void) | null) => void;
  setSelection: (value: string) => void;
  onPdfTextSelect: (value: string) => void;
  onPaperTextSelect: (value: string) => void;
  onContextSurfaceActivate: (surface: AgentHostSurface) => void;
  onViewMarkdownSource: () => void;
  onOpenSlideMutation: import("../editor/presentation/open-slide-workspace").OpenSlideWorkspaceProps["onMutation"];
  onOpenSlideContext?: import("../editor/presentation/open-slide-workspace").OpenSlideWorkspaceProps["onContext"];
  onOpenSlideError?: (message: string) => void;
  pdfUrl: string | null;
  pdfBytes?: ArrayBuffer | null;
  pdfTop?: ReactNode;
  activePaper: PaperSummary | null;
  /** Downloaded paper library backing the visual editor's `@` citation typeahead. */
  papers?: PaperSummary[];
  activeAsset: AssetPreview | null;
  /** The active asset was rewritten on disk: read its new version. */
  onActiveAssetChanged?: () => void;
  /** The active asset was removed from the project while open. */
  activeAssetMissing?: boolean;
  citationKeys: string[];
  citations: CitationInfo[];
  references: ReferenceInfo[];
  /** The project's citation and label index has not landed yet. */
  indexPending?: boolean;
  unusedLabels: string[];
  unusedCitations: string[];
  onLoadReferenceImage: (path: string) => Promise<string | null>;
  referenceImageGeneration?: number;
  onEditorLeave: () => void;
  onPrepareFigure: (path: string) => Promise<string | null>;
  onPasteImageFile: (file: File) => boolean | void;
  onImportAsset?: (file: File) => Promise<string | null>;
  nativeFigureDropActive: boolean;
  fileDropTargetActive: boolean;
  requests: CanvasRequests;
  /** Settle the request with this id (ids are unique across every kind). */
  onRequestHandled: (id: string) => void;
  onEditorPosition: (position: EditorPosition) => void;
  onCompletionActiveChange: (active: boolean) => void;
  onViewState: (path: string, state: EditorViewState) => void;
  getFileViewState?: (path: string) => FileViewState | undefined;
  onFileViewState?: (path: string, update: Partial<FileViewState>) => void;
  onGotoDefinition: (target: DefinitionTarget) => void;
  onTexlabGoto: (path: string, line: number, column?: number) => void;
  onFindReferences: (target: SymbolTarget) => void;
  onRenameSymbol: (target: SymbolTarget) => void;
  onRenameEnvironment: (name: string) => void;
  onWrapEnvironment: () => void;
  localMacros: { label: string; detail: string; type: "keyword" | "type" }[];
  katexMacros: Record<string, string>;
  onGotoLineRequest: () => void;
  outlineOpen: boolean;
  onOutlineOpenChange: (open: boolean) => void;
  outlineNodes: OutlineNode[];
  activeOutlineId: string | null;
  onOutlineNavigate: (path: string, line: number) => void;
  tableGeneratorOpen: boolean;
  onTableGeneratorOpenChange: (open: boolean) => void;
  editorKeymap: EditorKeymap;
  editorSpellcheck: boolean;
  spellingWords: string[];
  onAddSpellingWord: (word: string) => boolean | Promise<boolean>;
  projectPaths: string[];
  graphicsRoots: string[];
  buildDiagnostics: CompileDiagnostic[];
  texlabDiagnostics: CompileDiagnostic[];
  pdfSyncTarget: PdfSyncTarget | null;
  canForwardSync: boolean;
  locatingPdf: boolean;
  onForwardSync: () => void;
  onPdfSource: (page: number, x: number, y: number) => void;
  editorComments: EditorComment[];
  /** Other people's carets in the document Overleaf is carrying live. */
  overleafPresenceCursors: PresenceCursor[];
  /** Suggestions in that document, and what can be done about one. */
  overleafChanges: TrackedChange[];
  overleafTrackChangeActions: TrackedChangeTooltipActions;
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
  onPdfPageChange: (page: number) => void;
  onCreateMissingFile: (path: string) => void;
  onOpenMarkdownPath: (path: string) => void;
  interactivePreviewsEnabled: boolean;
  /** Remounts the source editor when it changes: the open file, or the Paper. */
  editorKey: string;
  /**
   * Where the active document renders (its file panel's host) and where the
   * project PDF renders (the PDF panel's host; null while that panel is
   * closed or hibernated).
   */
  trellis: {
    editorHost: HTMLElement;
    pdfHost: HTMLElement | null;
    /** A board, sheet or deck whose panel has been off screen long enough to unmount. */
    editorHibernated: boolean;
    hibernatedPlaceholder: ReactNode;
  };
  editorEditable: boolean;
  onOpenCitation: (key: string) => void;
  canOpenCitation: (key: string) => boolean;
}) {
  const {
    activeFile, buildDiagnostics, indexPending,
    texlabDiagnostics, editorKey, editorKeymap, editorSpellcheck,
    katexMacros, onFindReferences, onGotoDefinition, onTexlabGoto, onGotoLineRequest,
    onOutlineNavigate, onOutlineOpenChange, onPrepareFigure, onPasteImageFile,
    onCreateMissingFile, onRenameEnvironment, onRenameSymbol, onTableGeneratorOpenChange, onWrapEnvironment,
    activeOutlineId, outlineNodes, outlineOpen, setSource, source: editorSource,
    tableGeneratorOpen, editorComments, commentAuthorName, commentAuthorId, onCreateEditorComment,
    onOpenEditorComments, commentFocusRequest, onCommentFocusHandled, getFileViewState, onFileViewState,
    onRequestHandled,
  } = props;
  const settledSource = props.settledSource ?? editorSource;
  const {
    navigation: editorNavigation, restore: viewRestore, rename: envRenameRequest, wrap: wrapEnvRequest,
    cite: citeInsertRequest, figure: figureDropRequest,
  } = props.requests;
  const { i18n, t } = useLingui();
  const editorCommentLocalization = useMemo<EditorCommentLocalization>(() => ({
    locale: i18n.locale, anonymous: t`Anonymous`, noCommentText: t`(no comment text)`,
    reopen: t`Reopen`, resolve: t`Resolve comment`, reply: t`Reply`,
  }), [i18n.locale, t]);
  const editorCommentLocalizationRef = useLatestRef(editorCommentLocalization);
  // The newest props for CodeMirror extensions and window listeners, so those
  // never rebuild for them; also the LaTeX editors' live data (citations, macros).
  const latestRef = useRef(props);
  latestRef.current = props;
  const primaryVisualMarkdownFlushRef = useRef<(() => boolean) | null>(null);
  const registerPrimaryVisualMarkdownFlush = useCallback((flush: (() => boolean) | null) => {
    primaryVisualMarkdownFlushRef.current = flush;
  }, []);
  const flushPrimaryVisualMarkdown = useCallback(() => primaryVisualMarkdownFlushRef.current?.(), []);
  const flushVisualMarkdown = useCallback(() => primaryVisualMarkdownFlushRef.current?.() !== false, []);
  useRegistration(props.onVisualMarkdownFlushChange, flushVisualMarkdown);
  const primarySurface: AgentHostSurface = props.activePaper ? "paper" : "editor";
  const primaryKind = props.activePaper ? null : structuredDocumentKind(activeFile);
  const markdownDocument = Boolean(props.activePaper)
    || (activeFile.toLocaleLowerCase().endsWith(".md") && primaryKind !== "presentation");
  const htmlDocument = !props.activePaper && isHtmlFilePath(activeFile);
  const explicitPreview = props.markdownPreviewSource;
  const markdownPreviewStart = explicitPreview !== undefined
    ? (props.source.endsWith(explicitPreview) ? props.source.length - explicitPreview.length : 0)
    : markdownDocument ? markdownFrontmatterEnd(props.source) : 0;
  const markdownPreviewText = props.markdownPreviewSource ?? props.source.slice(markdownPreviewStart);
  const markdownPreviewEnd = markdownPreviewStart + markdownPreviewText.length;
  const { settled: settledPreviewText, markEcho: setVisualEchoSource, policy: markdownSyncPolicy } = useSettledPreviewText(
    props.source,
    // Other files never reach the Markdown preview: a constant spares each
    // keystroke a publication whose only effect was one more render.
    markdownDocument ? markdownPreviewText : "",
    activeFile,
  );
  const paperFullTextActive = Boolean(props.activePaper) && activeFile.replace(/\\/g, "/").toLocaleLowerCase().endsWith("/paper.md");
  const paperAuthors = props.activePaper ? paperAuthorNames(props.activePaper).join(" · ") : "";
  const [paperVisualEligibility, setPaperVisualEligibility] = useState<{ path: string; text: string; reason: string | null } | null>(null);
  const reportPaperVisualEligibility = useCallback((reason: string | null) => {
    setPaperVisualEligibility((current) => {
      if (!paperFullTextActive) return null;
      const unchanged = current?.path === activeFile && current.text === settledPreviewText && current.reason === reason;
      return unchanged ? current : { path: activeFile, text: settledPreviewText, reason };
    });
  }, [activeFile, paperFullTextActive, settledPreviewText]);
  const paperVisualEligibilityReason = paperFullTextActive && paperVisualEligibility?.path === activeFile
    && paperVisualEligibility.text === settledPreviewText ? paperVisualEligibility.reason : null;
  const markdownPreviewLineOffset = props.source.slice(0, markdownPreviewStart).split("\n").length - 1;
  const markdownVisualCursors = useMemo(
    () => props.overleafPresenceCursors
      .filter((cursor) => cursor.row >= markdownPreviewLineOffset)
      .map((cursor) => ({ ...cursor, row: cursor.row - markdownPreviewLineOffset })),
    [markdownPreviewLineOffset, props.overleafPresenceCursors],
  );
  const markdownVisualChanges = useMemo(() => props.overleafChanges.flatMap((change) => {
    const changeEnd = change.deletion ? change.position : change.position + change.text.length;
    return change.position < markdownPreviewStart || changeEnd > markdownPreviewEnd
      ? []
      : [{ ...change, position: change.position - markdownPreviewStart }];
  }), [markdownPreviewEnd, markdownPreviewStart, props.overleafChanges]);
  const editorViewRef = useRef<EditorView | null>(null);
  const primaryViewRef = useRef<EditorView | null>(null);
  const primaryViewPathRef = useRef("");
  // Weak on purpose; deref at the point of use and never keep the result in a
  // render-scope variable. Every closure created while rendering captures this
  // render's scope, and a CodeMirror view keeps its extensions' closures alive
  // for its whole life. A strong reference here chained each editor to the one
  // before it (new view → extension closure → render scope → previous view),
  // so every file switch retained the previous editor and its whole document.
  const [primaryScrollbarView, setPrimaryScrollbarView] = useState<WeakRef<EditorView> | null>(null);
  const markdownPreviewViewportRef = useRef<HTMLDivElement | null>(null);
  // Weak for the same reason as the scrollbar views above: a retained render
  // scope must not pin a replaced preview and its whole rendered document.
  const [markdownPreviewViewport, setMarkdownPreviewViewport] = useState<WeakRef<HTMLDivElement> | null>(null);
  const paperPdf = usePaperPdf({
    activePaper: props.activePaper,
    activeFile,
    mode: props.mode,
    onOpenMarkdownPath: props.onOpenMarkdownPath,
    flushVisualMarkdown: flushPrimaryVisualMarkdown,
    previewViewportRef: markdownPreviewViewportRef,
    settledPreviewText,
  });
  const { quoteFallback, returnViewportRef: paperReturnViewportRef } = paperPdf;
  const markdownPreviewPersistenceCleanupRef = useRef<(() => void) | null>(null);
  const markdownScrollSyncSuppressedRef = useRef(false);
  const markdownPreviewViewportLockRef = useRef(0);
  // Filled by the split scroll coordinator; the primary editor's update
  // listener pokes it so cursor motion reveals the matching preview block.
  const markdownCursorRevealRef = useRef<(() => void) | null>(null);
  const markdownPreviewReconcileFromSourceRef = useRef<(() => void) | null>(null);
  const markdownPreviewOverflowAnchorRef = useRef("");
  const lastInsertionPositionRef = useRef(0);
  const pendingFigureCursorRef = useRef<number | null>(null);
  const { splitRef, splitRatio, beginSplitResize, nudgeSplit } = useSplitLayout(props.mode, SPLIT_MINIMUMS);
  const splitMinimums = SPLIT_MINIMUMS;
  const [figureDropActive, setFigureDropActive] = useState(false);
  const [cursorOffset, setCursorOffset] = useState(0);
  const [statusPosition, setStatusPosition] = useState({ line: 1, column: 0 });
  const [figureInsertPending, setFigureInsertPending] = useState<{ paths: string[]; position: number } | null>(null);
  const [commentComposer, setCommentComposer] = useState<CommentDraft | null>(null);
  const commentComposerViewRef = useRef<EditorView | null>(null);
  const commentComposerRef = useLatestRef(commentComposer);
  // Saved-view ownership for the preview column. Files without a preview of
  // their own (.bib, .sty) keep using the last previewable file's saved state.
  // This is separate from the mounted viewer's identity: all TeX source files
  // share the project's compiled PDF, including across SyncTeX jumps. The
  // canvas outlives a project switch, so the identity is tied to its root: the
  // outgoing project's file must not own the incoming project's saved PDF view.
  const [previewIdentity, setPreviewIdentity] = useState({ root: props.projectRoot, path: activeFile });
  const previewOwner = isPreviewableSourceFilePath(activeFile) ? activeFile : undefined;
  if (previewIdentity.root !== props.projectRoot || (previewOwner && previewOwner !== previewIdentity.path)) {
    setPreviewIdentity({ root: props.projectRoot, path: previewOwner ?? activeFile });
  }

  const { captureMarkdownModeViewport, viewMarkdownSource, livePrimaryView } = useMarkdownModeHandoff({
    activeFile,
    mode: props.mode,
    markdownDocument,
    previewStart: markdownPreviewStart,
    primaryViewRef,
    primaryViewPathRef,
    previewViewportRef: markdownPreviewViewportRef,
    previewViewport: markdownPreviewViewport,
    primaryView: primaryScrollbarView,
    latestRef,
    scrollSyncSuppressedRef: markdownScrollSyncSuppressedRef,
    reconcileFromSourceRef: markdownPreviewReconcileFromSourceRef,
    onViewMarkdownSource: props.onViewMarkdownSource,
  });
  useRegistration(props.onMarkdownModeViewportCaptureChange, captureMarkdownModeViewport);

  // Markdown's Preview is its visual editor: a jump or comment focus for the
  // file in front lands there, instead of opening a source view for it.
  const commentFocusPath = commentFocusRequest ? editorComments.find((item) => item.id === commentFocusRequest.id)?.path : undefined;
  const visualReveal = useMemo<VisualReveal | null>(() => {
    if (!markdownDocument || props.mode !== "pdf") return null;
    if (editorNavigation?.path === activeFile) {
      return { id: editorNavigation.id, kind: "navigation", target: { line: Math.max(1, editorNavigation.line - markdownPreviewLineOffset) } };
    }
    if (commentFocusRequest && commentFocusPath === activeFile) {
      return { id: commentFocusRequest.nonce, kind: "comment", target: { commentId: commentFocusRequest.id } };
    }
    return null;
  }, [activeFile, commentFocusPath, commentFocusRequest, editorNavigation, markdownDocument, markdownPreviewLineOffset, props.mode]);
  const visualRevealRef = useLatestRef(visualReveal);
  const [selectedText, setSelectedText] = useState("");
  const [selectionToolbar, setSelectionToolbar] = useState<{ position: LatexSelectionToolbarPosition } | null>(null);
  const commentsForActiveFile = useMemo(() => editorComments.filter((comment) => comment.path === activeFile), [activeFile, editorComments]);
  const commentsForActiveFileRef = useRef(commentsForActiveFile);
  commentsForActiveFileRef.current = commentsForActiveFile;

  // Comments rebased into the preview's own coordinates: it may render a slice
  // of the file, and resolves anchors against the text it was given.
  const markdownVisualComments = useMemo(
    () => rangesWithinPreview(commentsForActiveFile, markdownPreviewStart, markdownPreviewEnd),
    [commentsForActiveFile, markdownPreviewEnd, markdownPreviewStart],
  );

  useEffect(() => {
    if (primaryViewRef.current) refreshLint(primaryViewRef.current);
  }, [buildDiagnostics, texlabDiagnostics]);

  useEffect(() => {
    primaryViewRef.current?.dispatch({ effects: latexIndexChanged.of(null) });
  }, [indexPending]);

  useEffect(() => {
    const view = primaryViewRef.current;
    if (!view) return;
    view.dispatch({ effects: harperDictionaryChanged.of(null) });
    refreshLint(view);
  }, [props.spellingWords]);

  const completionActiveRef = useRef(false);
  const selectionToolbarOwnerRef = useRef<{ path: string; from: number; to: number } | null>(null);
  const dismissSelectionToolbar = useCallback(() => {
    selectionToolbarOwnerRef.current = null;
    setSelectionToolbar(null);
  }, []);

  const mountSourceRef = useRef(props.source);
  const visualSourceHistoryRef = useRef<{ path: string; undo: string[]; redo: string[] }>({ path: activeFile, undo: [], redo: [] });
  const prevEditorKeyRef = useRef(editorKey);
  if (prevEditorKeyRef.current !== editorKey) {
    prevEditorKeyRef.current = editorKey;
    mountSourceRef.current = props.source;
  }
  useEffect(() => {
    // A mounted source view holds the document; without one, only a change
    // from outside the preview replaces its local history.
    const view = primaryViewRef.current?.dom.isConnected ? primaryViewRef.current : null;
    const source = view ? view.state.doc.toString() : props.source;
    if (view || mountSourceRef.current !== source) {
      visualSourceHistoryRef.current = { path: activeFile, undo: [], redo: [] };
      mountSourceRef.current = source;
    }
  }, [activeFile, props.mode, props.source]);

  const updateSelectionToolbar = useCallback((view: EditorView, path: string) => {
    const range = view.state.selection.main;
    // A tab behind another one stays laid out (inert, hidden), so its
    // coordinates look valid; the toolbar is portaled and would not hide.
    const wrappable = !range.empty && (path.endsWith(".tex") || path.toLocaleLowerCase().endsWith(".md"))
      && !view.dom.closest("[inert]");
    const visibleRange = wrappable
      ? view.visibleRanges.find(({ from, to }) => range.from <= to && range.to >= from)
      : undefined;
    const editorBounds = visibleRange && view.dom.closest(".source-editor")?.getBoundingClientRect();
    const visibleFrom = Math.max(range.from, visibleRange?.from ?? 0);
    const start = visibleRange && view.coordsAtPos(visibleFrom);
    const end = visibleRange && view.coordsAtPos(Math.min(range.to, visibleRange.to, view.state.doc.lineAt(visibleFrom).to));
    if (!editorBounds || !start || !end) {
      dismissSelectionToolbar();
      return;
    }
    const halfWidth = Math.min(346, Math.max(0, editorBounds.width - 16)) / 2;
    const selectionCenter = start.top === end.top
      ? (start.left + end.right) / 2
      : start.left + Math.min(72, Math.max(20, editorBounds.width / 5));
    const left = clamp(selectionCenter, editorBounds.left + halfWidth + 8, editorBounds.right - halfWidth - 8);
    const selectionTop = Math.min(start.top, end.top);
    const below = selectionTop - editorBounds.top < 52;
    selectionToolbarOwnerRef.current = { path, from: range.from, to: range.to };
    setSelectionToolbar({
      position: { left, top: below ? start.bottom + 8 : selectionTop - 8, below, maxWidth: Math.max(0, editorBounds.width - 16) },
    });
  }, [dismissSelectionToolbar]);
  const reportEditorPosition = useCallback((view: EditorView, path: string) => {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const column = head - line.from;
    setCursorOffset((current) => (current === head ? current : head));
    setStatusPosition((current) => current.line === line.number && current.column === column ? current : { line: line.number, column });
    latestRef.current.onEditorPosition({ path, line: line.number, column });
    latestRef.current.onViewState(path, { cursor: head, scrollTop: view.scrollDOM.scrollTop });
  }, []);
  const onPrimaryChange = useCallback((value: string) => latestRef.current.setSource(value), []);
  /** Publish the editor's selection, caret and selection toolbar after an update of `path`. */
  const reportEditorUpdate = useCallback((update: ViewUpdate, path: string | null) => {
    const { state, view } = update;
    const range = state.selection.main;
    lastInsertionPositionRef.current = range.head;
    const nextSelection = range.empty ? "" : state.sliceDoc(range.from, range.to);
    latestRef.current.setSelection(nextSelection);
    setSelectedText(nextSelection);
    if (path) {
      // Focus moving to another control (a tab, a panel, a command) hides
      // the toolbar; its own menus and the link field keep it.
      const focused = view.dom.ownerDocument.activeElement;
      const focusLeft = update.focusChanged && focused && focused !== view.dom.ownerDocument.body
        && !view.dom.contains(focused) && !focused.closest(SELECTION_TOOLBAR_SURFACES);
      if (focusLeft) dismissSelectionToolbar();
      // A dismissed toolbar stays dismissed until the selection changes. The
      // blur that follows a click outside (which dismissed it) used to show
      // it again, left floating over whatever panel replaced the editor.
      else if (update.selectionSet || update.docChanged || selectionToolbarOwnerRef.current) updateSelectionToolbar(view, path);
      reportEditorPosition(view, path);
    }
  }, [dismissSelectionToolbar, reportEditorPosition, updateSelectionToolbar]);
  const onPrimaryUpdate = useCallback((viewUpdate: ViewUpdate) => {
    // "pending" keeps the last answer. In LaTeX every typed letter queries the
    // completion sources (pending) and usually finds nothing (null), and
    // reporting both edges re-rendered all of App twice per keystroke. A menu
    // that is already open stays active while it refreshes its results.
    const status = completionStatus(viewUpdate.state);
    const completionActive = status === "active" || (status === "pending" && completionActiveRef.current);
    if (completionActiveRef.current !== completionActive) {
      completionActiveRef.current = completionActive;
      latestRef.current.onCompletionActiveChange(completionActive);
    }
    reportEditorUpdate(viewUpdate, latestRef.current.activeFile);
    if (viewUpdate.state.selection.main.empty) setCommentComposer(null);
    markdownCursorRevealRef.current?.();
  }, [reportEditorUpdate]);
  useEffect(() => () => {
    if (completionActiveRef.current) latestRef.current.onCompletionActiveChange(false);
  }, []);

  useEffect(() => onLayoutChange(
    [primaryViewRef.current?.dom.closest(".source-editor")],
    () => {
      const owner = selectionToolbarOwnerRef.current;
      const view = primaryViewRef.current;
      if (owner && view) updateSelectionToolbar(view, owner.path);
    },
  ), [activeFile, updateSelectionToolbar]);

  // Switching files, or to a mode without a source editor, drops the selection toolbar.
  const sourceEditorHidden = props.mode === "pdf" || props.mode === "asset";
  useEffect(dismissSelectionToolbar, [activeFile, dismissSelectionToolbar, sourceEditorHidden]);

  useEffect(() => {
    primaryViewRef.current?.dispatch({ effects: setEditorCommentsEffect.of(commentsForActiveFile) });
  }, [commentsForActiveFile, editorKey]);

  useLayoutEffect(() => {
    const draft = commentComposer?.path === activeFile ? commentComposer : null;
    primaryViewRef.current?.dispatch({ effects: setEditorCommentDraftEffect.of(draft) });
  }, [activeFile, commentComposer, editorKey]);

  // Someone else's caret has to repaint when they move it, not when we type next.
  useEffect(() => {
    primaryViewRef.current?.dispatch({ effects: setOverleafCursorsEffect.of(props.overleafPresenceCursors) });
  }, [props.overleafPresenceCursors, editorKey]);

  useEffect(() => {
    if (!commentFocusRequest) return;
    const comment = editorComments.find((item) => item.id === commentFocusRequest.id);
    // The visual editor answers it in Markdown's Preview (visualReveal).
    if (!comment || comment.path !== activeFile || (markdownDocument && props.mode === "pdf")) return;
    const view = primaryViewRef.current;
    if (!view) return;
    const range = resolveCommentAnchor(view.state.doc.toString(), comment);
    if (range) revealInEditor(view, range);
    onCommentFocusHandled(commentFocusRequest.nonce);
  }, [activeFile, commentFocusRequest, editorComments, markdownDocument, onCommentFocusHandled, props.mode]);
  /** The visual editor landed on (or gave up on) the reveal it was asked for. */
  const visualRevealHandled = useCallback((id: string) => {
    const current = visualRevealRef.current;
    if (current?.id !== id) return;
    if (current.kind === "comment") onCommentFocusHandled(id);
    else onRequestHandled(id);
  }, [onCommentFocusHandled, onRequestHandled, visualRevealRef]);

  const applySelectionAction = useCallback((action: LatexSelectionAction, value?: string) => {
    const owner = selectionToolbarOwnerRef.current;
    if (!owner) return;
    const view = primaryViewRef.current;
    if (!view || owner.path !== latestRef.current.activeFile) return;
    const range = view.state.selection.main;
    if (range.empty || range.from !== owner.from || range.to !== owner.to) {
      dismissSelectionToolbar();
      return;
    }
    if (action === "comment") {
      const quote = view.state.sliceDoc(range.from, range.to);
      if (activeFile && quote.trim()) {
        commentComposerViewRef.current = view;
        setCommentComposer({
          path: activeFile, from: range.from, to: range.to, quote, body: "", error: null,
          prefix: view.state.sliceDoc(Math.max(0, range.from - 32), range.from),
          suffix: view.state.sliceDoc(range.to, Math.min(view.state.doc.length, range.to + 32)),
        });
      }
      dismissSelectionToolbar();
      return;
    }
    if (!props.editorEditable) return;
    const wrap = SELECTION_WRAPS[action](value);
    if (!wrap) return;
    const edit = wrapRange(view.state.doc.toString(), range.from, range.to, ...wrap);
    editAndFocus(view, { changes: edit, selection: { anchor: edit.cursorFrom, head: edit.cursorTo } });
    updateSelectionToolbar(view, owner.path);
  }, [activeFile, dismissSelectionToolbar, props.editorEditable, updateSelectionToolbar]);

  /** Create a comment on `[from, to)` of `path`; false when that range holds nothing to anchor it. */
  const createComment = (path: string, source: string, from: number, to: number, body: string) => {
    const comment = createEditorComment({ path, source, from, to, body, authorId: commentAuthorId, authorName: commentAuthorName });
    if (comment) onCreateEditorComment(comment);
    return Boolean(comment);
  };
  const closeCommentComposer = () => {
    setCommentComposer(null);
    commentComposerViewRef.current?.focus();
  };
  const saveCommentComposer = () => {
    if (!commentComposer || !activeFile) return;
    if (commentComposer.path !== activeFile) {
      setCommentComposer(null);
      return;
    }
    const range = resolveCommentAnchor(editorSource, commentComposer);
    if (!range) {
      const error = t`The selected text changed. Select it again before commenting.`;
      setCommentComposer((current) => current ? { ...current, error } : current);
      return;
    }
    if (createComment(activeFile, editorSource, range.from, range.to, commentComposer.body)) closeCommentComposer();
  };
  const breadcrumb = useMemo(
    () => activeFile.endsWith(".tex") ? sectionBreadcrumbNodes(settledSource, statusPosition.line, activeFile) : [],
    [activeFile, settledSource, statusPosition.line],
  );
  const [primaryKeymapExtensions, primaryVimMode] = useOptionalKeymapExtensions(editorKeymap);
  const primaryTextLanguageExtensions = useTextLanguageExtensions(isLatexSourcePath(activeFile) ? "" : activeFile);
  /**
   * Everything the source editor of `path` runs, in precedence order; `extra`
   * slots in after the language. Every getter here runs in CodeMirror handlers,
   * transactions or tooltips, never during React render.
   */
  const paneExtensions = (
    path: string,
    keymap: Extension[],
    textLanguage: Extension[],
    comments: EditorCommentsExtensionOptions,
    extra: Extension[] = [],
  ): Extension[] => [
    paperDropExtension(path, () => ({ projectRoot: latestRef.current.projectRoot, papers: latestRef.current.papers ?? [] })),
    ...keymap,
    ...(isLatexSourcePath(path) ? [
      latex(),
      ...latexEditorExtensions({
        live: latestRef,
        currentPath: path,
        spellcheck: editorSpellcheck && isHarperProseFilePath(path),
        texlab: true,
        loadReferenceImage: props.onLoadReferenceImage,
        onGotoDefinition,
        onFindReferences,
        onRenameSymbol,
        onRenameEnvironment,
        onWrapEnvironment,
        onPasteImage: onPasteImageFile,
        onCreateMissingFile,
        onTexlabGoto,
      }),
    ] : [
      ...textLanguage,
      ...textEditorExtensions(editorSpellcheck && isHarperProseFilePath(path), latestRef, onPasteImageFile),
    ]),
    ...extra,
    editorCommentsExtension(path, {
      getLocalization: () => editorCommentLocalizationRef.current,
      onResolve: (id) => latestRef.current.onResolveEditorComment(id),
      onReply: (comment) => latestRef.current.onReplyEditorComment(comment.id),
      ...comments,
    }),
    linter((view) => editorDiagnosticsForFile(latestRef.current.buildDiagnostics, path, view.state.doc), { delay: 150 }),
    ...(isLatexSourcePath(path) ? [linter(
      (view) => editorTexlabDiagnosticsForFile(latestRef.current.texlabDiagnostics, path, view.state.doc),
      { delay: 200 },
    )] : []),
  ];
  // The extensions capture volatile inputs (macros, citations, diagnostics, App
  // lambdas) at reconfigure time or read them through refs. CodeMirrorHost
  // answers a new extensions identity with a full reconfigure, so listing them
  // would tear down language, linters and presence carets on every keystroke.
  const editorExtensions = useMemo(
    () => paneExtensions(
      activeFile,
      primaryKeymapExtensions,
      primaryTextLanguageExtensions,
      { getComments: () => commentsForActiveFileRef.current, getDraft: () => commentComposerRef.current },
      [
        overleafCursorsExtension({ getCursors: () => latestRef.current.overleafPresenceCursors }),
        overleafTrackChangesExtension({
          getChanges: () => latestRef.current.overleafChanges,
          authorName: (userId) => latestRef.current.overleafTrackChangeActions.authorName(userId),
          canAct: () => latestRef.current.overleafTrackChangeActions.canAct(),
          onAccept: (change) => latestRef.current.overleafTrackChangeActions.onAccept(change),
          onReject: (change) => latestRef.current.overleafTrackChangeActions.onReject(change),
        }),
      ],
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional stability
    [activeFile, editorSpellcheck, primaryKeymapExtensions, primaryTextLanguageExtensions],
  );
  const insertTextAtCursor = useCallback((insert: string, cursorOffset = insert.length) => {
    const view = editorViewRef.current;
    if (!view) return;
    const from = view.state.selection.main.head;
    const anchor = from + Math.min(cursorOffset, insert.length);
    editAndFocus(view, { changes: { from, insert }, selection: { anchor } });
  }, []);
  const insertFigures = useCallback(async (paths: string[], coordinates?: { x: number; y: number }) => {
    const view = primaryViewRef.current;
    if (!view || !paths.length) return;
    const targetPath = activeFile;
    const cursor = (coordinates && coordinates.x >= 0 && coordinates.y >= 0 ? positionAtPoint(view, coordinates) : null)
      ?? view.state.selection.main.head;
    const position = view.state.doc.lineAt(clamp(cursor, 0, view.state.doc.length)).from;
    if (targetPath.toLocaleLowerCase().endsWith(".md")) {
      const edit = markdownAssetInsertion(view.state.doc.toString(), position, paths, targetPath);
      editorViewRef.current = view;
      editAndFocus(view, { changes: { from: position, insert: edit.text }, selection: { anchor: position + edit.cursorOffset } });
      return;
    }
    if (!targetPath.toLocaleLowerCase().endsWith(".tex")) return;
    const prepared: string[] = [];
    for (const path of paths) {
      const latexPath = await onPrepareFigure(path);
      if (latexPath) prepared.push(latexPath);
    }
    if (!prepared.length) return;
    setFigureInsertPending({ paths: prepared, position });
  }, [activeFile, onPrepareFigure]);
  const confirmFigureInsert = useCallback((options: FigureInsertOptions) => {
    const pending = figureInsertPending;
    if (!pending) return;
    const edit = latexFigureInsertion(editorSource, pending.position, pending.paths, options);
    pendingFigureCursorRef.current = pending.position + edit.cursorOffset;
    setSource(`${editorSource.slice(0, pending.position)}${edit.text}${editorSource.slice(pending.position)}`);
    setFigureInsertPending(null);
  }, [editorSource, figureInsertPending, setSource]);
  useEffect(() => {
    const pendingCursor = pendingFigureCursorRef.current;
    if (pendingCursor === null) return;
    const view = primaryViewRef.current;
    if (!view || view.state.doc.toString() !== editorSource) return;
    pendingFigureCursorRef.current = null;
    editorViewRef.current = view;
    editAndFocus(view, { selection: { anchor: pendingCursor } });
  }, [editorSource]);
  useEffect(() => {
    const request = editorNavigation;
    if (!request || request.path !== activeFile) return;
    // No source view to land in; in Markdown's Preview the visual editor answers it (visualReveal).
    if (props.mode === "pdf" || props.mode === "asset") return;
    // A ref can be assigned before CodeMirror's DOM reports connected; treat the
    // view as ready, since the later attachment does not rerun this effect.
    const targetView = () => primaryViewRef.current ?? editorViewRef.current;
    if (!targetView()) return;
    // codemirror-host holds an external value back while someone is typing, so
    // the view can still carry the previous file's text when a jump arrives.
    // Wait for the text to catch up — but not forever: a best-effort jump is
    // better than a request nobody answers.
    const staleDocumentDeadline = performance.now() + 600;
    const [scheduleNavigation, cancelNavigation] = frameCoalescer(() => {
      const currentView = targetView();
      if (!currentView) return;
      if (currentView.state.doc.toString() !== editorSource && performance.now() < staleDocumentDeadline) {
        scheduleNavigation();
        return;
      }
      revealInEditor(currentView, lineTarget(currentView, request.line));
      editorViewRef.current = currentView;
      onRequestHandled(request.id);
    });
    scheduleNavigation();
    return cancelNavigation;
  }, [activeFile, editorNavigation, editorSource, onRequestHandled, props.mode]);
  useEffect(() => {
    const request = figureDropRequest;
    if (!request) return;
    void insertFigures(request.paths, { x: request.clientX, y: request.clientY }).finally(() => onRequestHandled(request.id));
  }, [figureDropRequest, insertFigures, onRequestHandled]);
  // One-shot LaTeX edits at the insertion target's caret, each settled once applied.
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view) return;
    if (citeInsertRequest) {
      const from = view.state.selection.main.head;
      const insert = `\\${citeInsertRequest.command}{${citeInsertRequest.key}}`;
      editAndFocus(view, { changes: { from, insert }, selection: { anchor: from + insert.length } });
      onRequestHandled(citeInsertRequest.id);
    }
    if (envRenameRequest) {
      const edits = renameEnvironmentAt(view.state.doc.toString(), view.state.selection.main.head, envRenameRequest.newName);
      if (edits) editAndFocus(view, { changes: edits });
      onRequestHandled(envRenameRequest.id);
    }
    if (wrapEnvRequest) {
      const { from, to } = view.state.selection.main;
      const edit = wrapEnvironment(view.state.doc.toString(), from, to, wrapEnvRequest.name);
      editAndFocus(view, { changes: edit, selection: { anchor: edit.cursorFrom, head: edit.cursorTo } });
      onRequestHandled(wrapEnvRequest.id);
    }
  }, [citeInsertRequest, editorSource, envRenameRequest, onRequestHandled, primaryScrollbarView, wrapEnvRequest]);
  useEffect(() => {
    const request = viewRestore;
    if (!request) return;
    // An explicit jump supersedes an older saved position, even mid-mount, or
    // the restore could run later and undo a completed SyncTeX navigation.
    if (editorNavigation?.path === request.path) {
      onRequestHandled(request.id);
      return;
    }
    const view = editorViewRef.current;
    if (!view || request.path !== activeFile) return;
    const frame = window.requestAnimationFrame(() => {
      const current = editorViewRef.current;
      if (!current) return;
      const cursor = clamp(request.cursor, 0, current.state.doc.length);
      current.dispatch({ selection: { anchor: cursor }, scrollIntoView: true });
      current.scrollDOM.scrollTop = request.scrollTop;
      onRequestHandled(request.id);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFile, onRequestHandled, viewRestore, editorSource, editorNavigation, primaryScrollbarView]);

  const replaceVisualMarkdown = useCallback((nextBody: string, expectedBody: string) => {
    // VisualMarkdownEditor retains the previous publisher until its layout
    // flush: a late callback must not write once another document owns the canvas.
    if (latestRef.current.activeFile !== activeFile) return false;
    const view = livePrimaryView();
    const source = view?.state.doc.toString() ?? mountSourceRef.current;
    const splice = spliceMarkdownBody(source, markdownPreviewStart, expectedBody, nextBody);
    if (!splice) return false;
    const nextSource = `${splice.prefix}${splice.inserted}`;
    const change = minimalTextChange(expectedBody, splice.inserted, markdownPreviewStart);
    // Mark the document this edit produces before any writer echoes it back,
    // so useSettledPreviewText hands it straight to the preview.
    setVisualEchoSource(nextSource);

    if (view) {
      view.dispatch({ changes: change });
      mountSourceRef.current = nextSource;
      return true;
    }
    if (visualSourceHistoryRef.current.path !== activeFile) visualSourceHistoryRef.current = { path: activeFile, undo: [], redo: [] };
    visualSourceHistoryRef.current.undo.push(source);
    visualSourceHistoryRef.current.redo = [];
    mountSourceRef.current = nextSource;
    // Use the setter from the render that created this callback: during a path
    // switch the source-editor ref already belongs to the next document.
    setSource(nextSource);
    return true;
  }, [activeFile, livePrimaryView, markdownPreviewStart, setSource, setVisualEchoSource]);

  const lockMarkdownPreviewViewport = useCallback((anchor: HTMLElement | null, anchorTop: number | null, reveal: HTMLElement | null) => {
    const viewport = markdownPreviewViewportRef.current;
    if (!viewport) return;
    const scrollTop = viewport.scrollTop;
    const lock = markdownPreviewViewportLockRef.current + 1;
    if (markdownPreviewViewportLockRef.current === 0) markdownPreviewOverflowAnchorRef.current = viewport.style.overflowAnchor;
    markdownPreviewViewportLockRef.current = lock;
    viewport.style.overflowAnchor = "none";
    const restore = () => {
      if (markdownPreviewViewportLockRef.current !== lock || !viewport.isConnected) return false;
      restoreViewportAround(viewport, scrollTop, anchor, anchorTop, reveal);
      return true;
    };
    restore();
    queueMicrotask(restore);
    window.requestAnimationFrame(() => {
      if (!restore()) return;
      window.requestAnimationFrame(() => {
        if (!restore()) return;
        markdownPreviewViewportLockRef.current = 0;
        viewport.style.overflowAnchor = markdownPreviewOverflowAnchorRef.current;
      });
    });
  }, []);

  const attachMarkdownPreviewViewport = useCallback((viewport: HTMLDivElement | null) => {
    markdownPreviewPersistenceCleanupRef.current?.();
    markdownPreviewPersistenceCleanupRef.current = null;
    markdownPreviewViewportRef.current = viewport;
    setMarkdownPreviewViewport((current) => (
      current?.deref() === viewport ? current : viewport ? new WeakRef(viewport) : null
    ));
    if (!viewport) return;
    const path = activeFile;
    const returnViewport = paperReturnViewportRef.current;
    // A pending source reveal owns the full-text viewport. Keep the blog
    // position until its explicit return, even if it briefly remounts first.
    const saved = quoteFallback?.path === path ? undefined
      : returnViewport?.path === path ? returnViewport : getFileViewState?.(path)?.visualMarkdown;
    if (!quoteFallback && returnViewport?.path === path) paperReturnViewportRef.current = null;
    const anchor = saved?.anchor;
    let restoring = Boolean(saved);
    let attempts = 0;
    // A jump into this file owns its viewport: the remembered place would land
    // first and the jump second, two moves where one was asked for.
    const jumping = () => latestRef.current.requests.navigation?.path === path || visualRevealRef.current !== null;
    // Retried each frame until the preview is tall enough to hold the saved
    // place, then (with a block saved) until that block is back where it was:
    // the offset alone drifts wherever the layout changed above it.
    const [scheduleRestore, cancelRestore] = frameCoalescer(() => {
      attempts += 1;
      if (jumping()) {
        restoring = false;
        return;
      }
      const ready = saved && (attempts > 1 && anchor
        ? restoreReadingAnchor(viewport, anchor)
        : restoreViewport(viewport, { scrollTop: saved.scrollTop, scrollRange: saved.scrollRange ?? 0 }) && !anchor);
      if (!ready && attempts < 30) scheduleRestore();
      else restoring = false;
    });
    const report = () => {
      // A preview being torn down has no layout left to read a place from.
      if (restoring || !viewport.isConnected) return;
      onFileViewState?.(path, { visualMarkdown: { ...captureViewport(viewport), anchor: captureReadingAnchor(viewport) } });
    };
    viewport.addEventListener("scroll", report, { passive: true });
    if (saved) scheduleRestore();
    markdownPreviewPersistenceCleanupRef.current = () => {
      cancelRestore();
      restoring = false;
      report();
      viewport.removeEventListener("scroll", report);
    };
  }, [activeFile, getFileViewState, onFileViewState, paperReturnViewportRef, quoteFallback, visualRevealRef]);

  /** Visual-editor undo/redo: through CodeMirror when mounted, else the local history. */
  const stepVisualHistory = useCallback((direction: "undo" | "redo") => {
    const view = livePrimaryView();
    if (view) {
      const stepped = (direction === "undo" ? undoCodeMirror : redoCodeMirror)(view);
      // History commands are the preview's own edits: settling them would
      // leave the user staring at pre-undo content for the idle window.
      if (stepped) setVisualEchoSource(view.state.doc.toString());
      return stepped;
    }
    const history = visualSourceHistoryRef.current;
    if (history.path !== activeFile) return false;
    const target = history[direction].pop();
    if (target == null) return false;
    history[direction === "undo" ? "redo" : "undo"].push(mountSourceRef.current);
    mountSourceRef.current = target;
    setVisualEchoSource(target);
    latestRef.current.setSource(target);
    return true;
  }, [activeFile, livePrimaryView, setVisualEchoSource]);
  const undoVisualMarkdown = useCallback(() => stepVisualHistory("undo"), [stepVisualHistory]);
  const redoVisualMarkdown = useCallback(() => stepVisualHistory("redo"), [stepVisualHistory]);

  useMarkdownSplitScroll({
    view: primaryScrollbarView,
    preview: markdownPreviewViewport,
    active: markdownDocument && props.mode === "split",
    previewStart: markdownPreviewStart,
    peerScrollSettleMs: markdownSyncPolicy.peerScrollSettleMs,
    suppressedRef: markdownScrollSyncSuppressedRef,
    viewportLockRef: markdownPreviewViewportLockRef,
    cursorRevealRef: markdownCursorRevealRef,
    reconcileRef: markdownPreviewReconcileFromSourceRef,
  });

  /** Mount-point props that let a surface restore and file its own per-file view state. */
  const viewStateBinding = <K extends keyof FileViewState>(path: string, key: K) => ({
    initialViewState: props.getFileViewState?.(path)?.[key],
    onViewState: (state: FileViewState[K]) => props.onFileViewState?.(path, { [key]: state }),
  });
  const assetPreview = (asset: AssetPreview) => (
    <ProjectAssetPreview
      key={asset.path}
      asset={asset}
      missing={props.activeAssetMissing}
      viewState={props.getFileViewState?.(asset.path)}
      onViewState={(update) => props.onFileViewState?.(asset.path, update)}
      onFileChanged={props.onActiveAssetChanged}
    />
  );
  const htmlPreview = (path: string, source: string, sourceEditorView?: EditorView | null) => (
    props.interactivePreviewsEnabled ? (
      <HtmlPreview
        key={path}
        path={path}
        source={source}
        assetRevision={props.referenceImageGeneration ?? 0}
        sourceEditorView={sourceEditorView}
        {...viewStateBinding(path, "html")}
        onLoadAsset={props.onLoadReferenceImage}
      />
    ) : <HtmlPreviewLoading />
  );
  const structuredFallbacks: Record<StructuredDocumentKind, [string, string]> = {
    board: ["board-editor-root", t`Preparing board editor`],
    spreadsheet: ["spreadsheet-editor-root", t`Preparing spreadsheet editor`],
    presentation: ["open-slide-status", t`Starting Open Slide`],
  };
  /** The board, spreadsheet or Open Slide deck that owns the canvas. */
  const structuredEditor = (kind: StructuredDocumentKind) => {
    const path = activeFile;
    const source = props.source;
    const [fallbackClass, fallbackLabel] = structuredFallbacks[kind];
    const editor = {
      path, source,
      onChange: onPrimaryChange,
      onFlushPendingChange: registerPrimaryVisualMarkdownFlush,
    };
    // Remount per file so each board gets a fresh store; local boards serialize
    // back through the source buffer before a document switch.
    const tour = kind === "presentation" ? "open-slide-workspace" : undefined;
    return (
      <Suspense fallback={<div className={fallbackClass} aria-busy="true" aria-label={fallbackLabel} data-tour={tour} />}>
        {kind === "board" ? (
          <BoardEditor key={path} {...editor} theme={props.theme} {...viewStateBinding(path, "board")} />
        ) : kind === "spreadsheet" ? (
          <SpreadsheetEditor
            key={path} {...editor} onPersist={props.onSave} {...viewStateBinding(path, "spreadsheet")}
          />
        ) : (
          <OpenSlideWorkspace
            key={path}
            projectRoot={props.projectRoot}
            path={path}
            source={source}
            editable={props.editorEditable}
            locale={props.locale}
            theme={props.theme}
            initialViewState={props.getFileViewState?.(path)?.openSlide}
            onViewState={(openSlide) => props.onFileViewState?.(path, { openSlide })}
            onMutation={props.onOpenSlideMutation}
            onContext={props.onOpenSlideContext}
            onError={props.onOpenSlideError}
          />
        )}
      </Suspense>
    );
  };

  const activatePrimarySurface = () => props.onContextSurfaceActivate(primarySurface);
  /** Leaving `currentTarget` entirely, by pointer or by focus, counts as leaving the editor. */
  const leaveHandlers = {
    onPointerLeave: props.onEditorLeave,
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) props.onEditorLeave();
    },
  };
  /** Focusing the editor offers its agent surface and makes its source view the insertion target. */
  const focusEditor = () => {
    props.onContextSurfaceActivate(primarySurface);
    if (primaryViewRef.current) editorViewRef.current = primaryViewRef.current;
  };
  const resizer = (label: string, onPointerDown: PointerEventHandler<HTMLDivElement>, attributes?: HTMLAttributes<HTMLDivElement>) => (
    <div
      className="split-resizer"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      onPointerDown={onPointerDown}
      {...attributes}
    />
  );
  /** Props every visual Markdown editor shares. */
  const visualEditorProps = {
    onOpenProjectPath: props.onOpenMarkdownPath,
    workspaceIndex: props.workspaceIndex,
    papers: props.papers,
    macros: katexMacros,
    onImportAsset: props.onImportAsset,
    onLoadAsset: props.onLoadReferenceImage,
    assetRevision: props.referenceImageGeneration ?? 0,
    activeEditorCommentId: props.activeEditorCommentId,
    // Opens the panel on that thread, like replying from the source editor's tooltip.
    onEditorCommentClick: props.onReplyEditorComment,
    onSelectionMarkdown: (value: string) => latestRef.current.setSelection(value),
  };
  /** A visual editor's caret moved to 1-based `line` of `path`. */
  const reportVisualCaret = (path: string, line: number, column: number) => {
    setStatusPosition({ line, column });
    props.onEditorPosition({ path, line, column });
  };
  const markdownPreview = (
    <ScrollArea
      className="markdown-preview"
      data-tour={props.activePaper ? "paper-reading-view" : "markdown-visual-editor"}
      // Wide tables, code and formulas own their horizontal overflow; a second
      // root scrollbar made Base UI run another ResizeObserver loop.
      orientation="vertical"
      // Mask gradients repaint the whole editable surface while scrolling in WebKit.
      fadeEdges={false}
      contentClassName="markdown-preview-content"
      viewportClassName="editor-doc-scroll"
      // Upstream contract: the editor scroll container carries both the
      // `.editor-doc-scroll` class (bubble-menu-clip.ts) and this testid
      // (frozen-table-headers.ts resolves it via closest()).
      viewportProps={{
        "data-testid": "editor-scroll-container",
        onClickCapture: (event) => {
          if (!props.activePaper || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
          const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
          if (!link) return;
          const citation = paperSourceCitation(props.activePaper, link.href, link.title);
          if (!citation || !paperPdf.pdfSource) return;
          event.preventDefault();
          event.stopPropagation();
          paperPdf.openPdf({ ...citation, id: crypto.randomUUID() });
        },
        // Split mode has its own scroll coordinator and insertion viewport lock;
        // native anchoring would be a competing scroll writer.
        style: props.mode === "split" ? { overflowAnchor: "none" } : undefined,
      }}
      viewportRef={attachMarkdownPreviewViewport}
      onPointerDownCapture={activatePrimarySurface}
      onFocusCapture={activatePrimarySurface}
      {...leaveHandlers}
      onMouseUp={props.activePaper ? (event) => {
        const selection = window.getSelection();
        const anchor = selection?.anchorNode;
        props.onPaperTextSelect(anchor && event.currentTarget.contains(anchor) ? selection?.toString() ?? "" : "");
      } : undefined}
    >
      {props.activePaper && paperFullTextActive && (
        <header className="paper-visual-header">
          <div>
            {paperVisualEligibilityReason && (
              <InlineMessage level="warning" className="paper-visual-eligibility">
                {paperVisualEligibilityReason}
              </InlineMessage>
            )}
            <h1>{props.activePaper.title}</h1>
            {paperAuthors && <p>{paperAuthors}</p>}
          </div>
        </header>
      )}
      <Suspense fallback={props.activePaper ? null : <MarkdownPreviewLoading />}>
        <DeferredVisualMarkdownEditor
          {...visualEditorProps}
          text={settledPreviewText}
          activePath={props.activeFile}
          projectRoot={props.activePaper ? undefined : props.projectRoot}
          optimizeForReading={Boolean(props.activePaper)}
          onEligibilityChange={paperFullTextActive ? reportPaperVisualEligibility : undefined}
          // Split previews keep source labels for scroll sync; pure preview
          // spares the labeling cost while typing.
          synchronizeSourceScroll={props.mode === "split" || visualReveal !== null}
          revealRequest={visualReveal}
          onRevealHandled={visualRevealHandled}
          onRequestViewportLock={lockMarkdownPreviewViewport}
          onChangeMarkdown={replaceVisualMarkdown}
          onFlushPendingChange={registerPrimaryVisualMarkdownFlush}
          onUndo={undoVisualMarkdown}
          onRedo={redoVisualMarkdown}
          onViewInSource={viewMarkdownSource}
          presenceCursors={markdownVisualCursors}
          overleafChanges={markdownVisualChanges}
          overleafTrackChangeActions={props.overleafTrackChangeActions}
          editorComments={markdownVisualComments}
          onCreateComment={(from, to, body) => createComment(
            activeFile, props.source, markdownPreviewStart + from, markdownPreviewStart + to, body,
          )}
          editable={props.editorEditable}
          onCaretChange={(row, column) => reportVisualCaret(activeFile, row + markdownPreviewLineOffset + 1, column)}
        />
      </Suspense>
    </ScrollArea>
  );
  const paperPreview = props.activePaper ? (
    <PaperReader
      paper={props.activePaper}
      activeFile={activeFile}
      pdf={paperPdf}
      markdown={markdownPreview}
      onOpenMarkdownPath={props.onOpenMarkdownPath}
      onContextSurfaceActivate={props.onContextSurfaceActivate}
      onTextSelect={props.onPaperTextSelect}
      pdfViewState={viewStateBinding(activeFile, "pdf")}
    />
  ) : markdownPreview;
  const carriesFigure = (event: DragEvent) => Array.from(event.dataTransfer.types).includes(PROJECT_FIGURE_DRAG_TYPE);
  const editor = (
    <div className="source-workspace" data-tour="document-editor">
      <div className="source-main">
        <div
          className={`source-editor ${
            figureDropActive || props.nativeFigureDropActive ? "figure-drop-active" : ""
          } ${props.fileDropTargetActive ? "file-drop-active" : ""}`}
          data-editor-pane="primary"
          onPointerDownCapture={activatePrimarySurface}
          onFocusCapture={focusEditor}
          {...leaveHandlers}
          onDragEnterCapture={(event) => {
            if (carriesFigure(event)) setFigureDropActive(true);
          }}
          onDragOverCapture={(event) => {
            if (!carriesFigure(event)) return;
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
            key={editorKey}
            className="code-editor-root"
            value={props.source}
            editable={props.editorEditable}
            extensions={editorExtensions}
            onCreateEditor={(view) => {
              primaryViewRef.current = view;
              primaryViewPathRef.current = activeFile;
              setPrimaryScrollbarView(new WeakRef(view));
              editorViewRef.current = view;
              lastInsertionPositionRef.current = view.state.selection.main.head;
              reportEditorPosition(view, activeFile);
            }}
            onChange={onPrimaryChange}
            onUpdate={onPrimaryUpdate}
          />
          <CodeMirrorScrollbar view={primaryScrollbarView?.deref() ?? null} />
          {commentComposer && (
            <CommentComposer
              draft={commentComposer}
              // eslint-disable-next-line react-hooks/refs -- the view the draft was opened in, fixed while it is open
              view={commentComposerViewRef.current}
              anchorKey={`${activeFile}\n${editorKey}`}
              onBodyChange={(body) => setCommentComposer((current) => current ? { ...current, body } : current)}
              onCancel={closeCommentComposer}
              onSave={saveCommentComposer}
            />
          )}
        </div>
        {activeFile.endsWith(".tex") && (
          <MathPreview source={editorSource} cursor={cursorOffset} macros={katexMacros} />
        )}
        <EditorStatusBar
          position={statusPosition}
          onGotoLine={onGotoLineRequest}
          keymap={editorKeymap}
          vimMode={primaryVimMode}
          breadcrumb={breadcrumb}
          breadcrumbPath={activeFile}
          onNavigate={onOutlineNavigate}
          hasDiagnostics={buildDiagnostics.length > 0}
          comments={commentsForActiveFile}
          onOpenComments={onOpenEditorComments}
          todoCount={props.todoCount}
          onOpenTodos={props.onOpenTodos}
          projectWordCount={props.projectWordCount}
          selectedText={selectedText}
          source={settledSource}
        />
      </div>
      <TableGeneratorDialog open={tableGeneratorOpen} onClose={() => onTableGeneratorOpenChange(false)} onInsert={insertTextAtCursor} />
      <FigureInsertDialog
        open={Boolean(figureInsertPending)}
        paths={figureInsertPending?.paths ?? []}
        onClose={() => setFigureInsertPending(null)}
        onInsert={confirmFigureInsert}
      />
      {selectionToolbar && selectedText.trim() && !commentComposer && (
        <LatexSelectionToolbar
          position={selectionToolbar.position}
          canComment
          commentOnly={activeFile.toLocaleLowerCase().endsWith(".md") || !props.editorEditable}
          onAction={applySelectionAction}
          onDismiss={dismissSelectionToolbar}
        />
      )}
    </div>
  );
  const projectPdfPreview = (requestedPath: string) => {
    const previewPath = isPreviewableSourceFilePath(requestedPath) ? requestedPath : previewIdentity.path;
    const leaveEditorForPdf = () => {
      // Scrolling the PDF need not blur CodeMirror: end completion explicitly, or
      // its active-menu guard can suspend autosave. Pointer leave keeps the menu.
      if (primaryViewRef.current) closeCompletion(primaryViewRef.current);
      props.onEditorLeave();
    };
    const activatePdf = () => {
      props.onContextSurfaceActivate("pdf");
      leaveEditorForPdf();
    };
    return (
      <div
        className="pdf-column"
        data-tour="document-preview"
        onPointerDownCapture={activatePdf}
        onFocusCapture={activatePdf}
        onWheelCapture={leaveEditorForPdf}
      >
        {props.pdfTop}
        <Suspense fallback={<PdfPreviewLoading />}>
          <PdfPreview
            key={`project-pdf:${props.projectRoot}`}
            url={props.pdfUrl}
            pdfBytes={props.pdfBytes}
            citations={props.citations}
            canOpenCitation={props.canOpenCitation}
            onOpenCitation={props.onOpenCitation}
            syncTarget={props.pdfSyncTarget}
            canForwardSync={props.canForwardSync}
            locatingPdf={props.locatingPdf}
            onForwardSync={props.onForwardSync}
            // Under Trellis a reverse jump always has a file panel to land in.
            onSource={props.onPdfSource}
            onTextSelect={props.onPdfTextSelect}
            onNumPages={props.onPdfPageCount}
            onPageChange={props.onPdfPageChange}
            {...viewStateBinding(previewPath, "pdf")}
            outline={(
              <DocumentOutline
                nodes={outlineNodes}
                activeId={activeOutlineId}
                available={previewPath.toLocaleLowerCase().endsWith(".tex")}
                open={outlineOpen}
                onSelect={onOutlineNavigate}
                onOpenChange={onOutlineOpenChange}
              />
            )}
          />
        </Suspense>
      </div>
    );
  };
  const preview = props.activeAsset ? assetPreview(props.activeAsset)
    : markdownDocument ? paperPreview
      : htmlDocument ? htmlPreview(activeFile, props.source, props.mode === "split" ? primaryScrollbarView?.deref() ?? null : null)
        : projectPdfPreview(activeFile);
  // The file panel shows the document the way its kind is edited; LaTeX
  // and other source files never split here, the PDF is its own panel.
  const { editorHost, pdfHost, editorHibernated, hibernatedPlaceholder } = props.trellis;
  const readable = Boolean(props.activePaper) || markdownDocument || htmlDocument;
  const fileContent = props.activeAsset ? assetPreview(props.activeAsset)
    : primaryKind ? (editorHibernated ? hibernatedPlaceholder : structuredEditor(primaryKind))
      : paperPdf.pdfView ? paperPreview
        : !readable || props.mode === "source" ? editor
          : props.mode === "pdf" ? preview
            : (
        <div
          ref={splitRef}
          className="split-canvas"
          data-tour="split-workspace"
          data-minimum-workspace-width={splitMinimums.source + splitMinimums.preview + 1}
          style={{
            gridTemplateColumns: `clamp(${splitMinimums.source}px, calc(${splitRatio * 100}% - ${splitRatio}px), calc(100% - ${splitMinimums.preview + 1}px)) 1px minmax(${splitMinimums.preview}px, 1fr)`,
          }}
        >
          {editor}
          {resizer(
            props.activeAsset
              ? t`Resize editor and asset preview`
              : markdownDocument
                ? t`Resize editor and Markdown preview`
                : htmlDocument ? t`Resize editor and HTML preview` : t`Resize editor and PDF preview`,
            beginSplitResize,
            {
              "aria-valuemin": 20,
              "aria-valuemax": 80,
              "aria-valuenow": Math.round(splitRatio * 100),
              onKeyDown: (event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                nudgeSplit(event.key === "ArrowLeft" ? -0.03 : 0.03);
              },
            },
          )}
          {preview}
        </div>
            );
  return (
    <>
      {createPortal(fileContent, editorHost)}
      {pdfHost && createPortal(projectPdfPreview(activeFile), pdfHost)}
    </>
  );

}
