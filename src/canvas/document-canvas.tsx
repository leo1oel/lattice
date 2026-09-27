import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLingui } from "@lingui/react/macro";
import { CodeMirrorHost as CodeMirror } from "../editor/codemirror-host";
import { paperDropExtension } from "../editor/paper-drop";
import { closeCompletion, completionStatus } from "@codemirror/autocomplete";
import { redo as redoCodeMirror, undo as undoCodeMirror } from "@codemirror/commands";
import { forceLinting as refreshLint, linter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { paperSourceCitation } from "../papers/paper-source";
import { latex } from "codemirror-lang-latex";
import {
  hueFromColorHex,
  overleafCursorsExtension,
  setOverleafCursorsEffect,
  type PresenceCursor,
} from "../overleaf/overleaf-cursors";
import {
  overleafTrackChangesExtension,
  type TrackedChangeTooltipActions,
} from "../overleaf/overleaf-track-changes";
import type { TrackedChange } from "../overleaf/use-overleaf-realtime";
import type { MarkdownWorkspaceIndex } from "../editor/markdown/markdown-workspace-index";
import { markdownPreviewSyncPolicy } from "../editor/markdown/markdown-preview-sync-policy";
import { restoreVisualViewportWithReveal } from "../editor/markdown/visual-editor-block-controls";
import { Columns2 } from "lucide-react";
import {
  latexEditorExtensions,
  latexLanguageOptions,
  textEditorExtensions,
  renameEnvironmentAt,
  wrapRange,
  wrapEnvironment,
  type CitationInfo,
  type DefinitionTarget,
  type ReferenceInfo,
  type SymbolTarget,
} from "../editor/latex/latex-editor";
import { harperDictionaryChanged } from "../editor/harper-spellcheck";
import {
  LatexSelectionToolbar,
  type LatexSelectionAction,
  type LatexSelectionToolbarPosition,
} from "../editor/latex/latex-selection-toolbar";
import { ScrollArea } from "../components/ui/scroll-area";
import { InlineMessage } from "../components/ui/inline-message";
import {
  latexFigureInsertion,
  markdownAssetInsertion,
  type FigureInsertOptions,
} from "../editor/insert/figure-insertion";
import { FigureInsertDialog } from "../editor/insert/figure-insert-dialog";
import {
  createEditorComment,
  editorCommentsExtension,
  resolveCommentAnchor,
  resolveCommentRange,
  setEditorCommentsEffect,
  setEditorCommentDraftEffect,
  type EditorComment,
  type EditorCommentLocalization,
} from "../editor/comments/editor-comments";
import { clamp, type AppLocale, type Theme } from "../settings/app-settings";
import {
  editorDiagnosticsForFile,
  type CompileDiagnostic,
} from "../build/compile-diagnostics";
import { editorTexlabDiagnosticsForFile } from "../build/texlab-diagnostics";
import { DocumentOutline } from "./document-outline";
import {
  sectionBreadcrumbNodes,
  type OutlineNode,
} from "../editor/latex/latex-outline";
import { InsertPalette } from "../editor/insert/insert-palette";
import type { InsertSnippet } from "../editor/insert/insert-snippets";
import { expandSnippetPlaceholders, nextSnippetStop, previousSnippetStop } from "../editor/insert/snippet-placeholders";
import { MathPreview } from "../editor/latex/math-preview";
import { TableGeneratorDialog } from "../editor/insert/table-generator-dialog";
import type { PdfSyncTarget } from "../pdf/pdf-viewer";
import { SPLIT_PDF_MIN_WIDTH, SPLIT_SOURCE_MIN_WIDTH } from "../app/window-layout";
import type {
  WordCount,
  EditorViewState,
  FileViewState,
  AssetPreview,
  FigureDropRequest,
  EditorNavigation,
  EditorPosition,
  PaperSummary,
  CanvasMode,
  EditorPaneId,
  InsertSymbolCommand,
  EditorKeymap,
} from "../app-types";
import {
  isHarperProseFilePath,
  isHtmlFilePath,
  isOpenSlideDeckPath,
  isPreviewableSourceFilePath,
  markdownFrontmatterEnd,
  PROJECT_FIGURE_DRAG_TYPE,
} from "../app-utils";
import type { AgentHostSurface } from "../agent/agent-host-context";
import type { CollabPeer, EditorCollabBinding, EditorCollabSession } from "../collab/collab-session";
import { mergeTextIntoYText, peerCaretOffsetsV2, publishCollabCursorV2 } from "../collab/collab-session";
import { collabEditorExtensions } from "../collab/collab-editor";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";
import { EMPTY_EXTENSIONS } from "../editor/editor-languages";
import {
  BoardEditor,
  DeferredVisualMarkdownEditor,
  HtmlPreviewLoading,
  MarkdownPreviewLoading,
  OpenSlideWorkspace,
  PdfPreview,
  PdfPreviewLoading,
  SpreadsheetEditor,
} from "./canvas-lazy-editors";
import { CodeMirrorScrollbar } from "./codemirror-scrollbar";
import { CommentComposer, type CommentDraft } from "./comment-composer";
import { EditorStatusBar } from "./editor-status-bar";
import { isLatexSourcePath, useOptionalKeymapExtensions, useTextLanguageExtensions } from "./editor-extensions";
import { HtmlPreview } from "./html-preview";
import { minimalTextChange, rangesWithinPreview, spliceMarkdownBody, useSettledPreviewText, restoreViewport } from "./markdown-preview-sync";
import { PaperReader } from "./paper-reader";
import { ProjectAssetPreview } from "./project-asset-preview";
import { SecondaryMarkdownPreview } from "./secondary-markdown-preview";
import { useMarkdownModeHandoff } from "./use-markdown-mode-handoff";
import { useMarkdownSplitScroll } from "./use-markdown-split-scroll";
import { usePaperPdf } from "./use-paper-pdf";
import { useSplitLayout } from "./use-split-layout";

export { OpenSlideTabPool } from "./open-slide-tab-pool";

/** LaTeX wrappers the floating selection toolbar applies; null declines the edit. */
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
    return [`\\href{${url.replace(/\\/g, "%5C").replace(/\{/g, "%7B").replace(/\}/g, "%7D")}}{`, "}"];
  },
};

type StructuredDocumentKind = "board" | "spreadsheet" | "presentation";

function structuredDocumentKind(path: string): StructuredDocumentKind | null {
  if (path.toLocaleLowerCase().endsWith(".tldr")) return "board";
  if (isSpreadsheetPath(path)) return "spreadsheet";
  return isOpenSlideDeckPath(path) ? "presentation" : null;
}

export function DocumentCanvas(props: {
  projectRoot: string;
  locale: AppLocale;
  theme: Theme;
  mode: CanvasMode;
  dualPreviewPanes?: { primary: boolean; secondary: boolean };
  /** Whether some pane still holds an editor a PDF double-click can jump into. */
  canRevealPdfSource?: boolean;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  source: string;
  markdownPreviewSource?: string;
  activeFile: string;
  secondaryFile: string | null;
  secondarySource: string;
  setSecondarySource: (value: string) => void;
  focusedPane: EditorPaneId;
  onFocusPane: (pane: EditorPaneId) => void;
  dualRatioResetGeneration: number;
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
  pdfBase64: string | null;
  pdfBytes?: ArrayBuffer | null;
  pdfTop?: ReactNode;
  activePaper: PaperSummary | null;
  paperSide: "left" | "right";
  /** Downloaded paper library backing the visual editor's `@` citation typeahead. */
  papers?: PaperSummary[];
  activeAsset: AssetPreview | null;
  secondaryAsset: AssetPreview | null;
  citationKeys: string[];
  citations: CitationInfo[];
  references: ReferenceInfo[];
  unusedLabels: string[];
  unusedCitations: string[];
  onLoadReferenceImage: (path: string) => Promise<string | null>;
  referenceImageGeneration?: number;
  onEditorLeave: () => void;
  onPrepareFigure: (path: string) => Promise<string | null>;
  onPasteImageFile: (file: File) => boolean | void;
  onImportAsset?: (file: File) => Promise<string | null>;
  nativeFigureDropActive: boolean;
  fileDropTargetPane: EditorPaneId | null;
  figurePointerPosition: { x: number; y: number } | null;
  figureDropRequest: FigureDropRequest | null;
  onFigureDropHandled: (id: string) => void;
  editorNavigation: EditorNavigation | null;
  onEditorNavigationHandled: (id: string) => void;
  onEditorPosition: (position: EditorPosition) => void;
  onCompletionActiveChange: (active: boolean) => void;
  onViewState: (path: string, state: EditorViewState) => void;
  getFileViewState?: (path: string) => FileViewState | undefined;
  onFileViewState?: (path: string, update: Partial<FileViewState>) => void;
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
  spellingWords: string[];
  onAddSpellingWord: (word: string) => boolean | Promise<boolean>;
  citeInsertRequest: { key: string; command: InsertSymbolCommand; id: string } | null;
  onCiteInsertHandled: (id: string) => void;
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
  collabSession: EditorCollabSession | null;
  collabPeers: readonly CollabPeer[];
  collabReady: boolean;
  collabEditorKey: string;
  editorEditable: boolean;
  secondaryEditorEditable: boolean;
  primaryOpenSlideExternallyRendered?: boolean;
  onOpenCitation: (key: string) => void;
  canOpenCitation: (key: string) => boolean;
}) {
  const {
    activeFile, secondaryFile, secondarySource, setSecondarySource, focusedPane, onFocusPane,
    buildDiagnostics, texlabDiagnostics, citeInsertRequest, collabEditorKey, collabSession, collabReady,
    editorKeymap, editorNavigation, editorSpellcheck, envRenameRequest, figureDropRequest, insertOpen,
    localMacros, katexMacros, onCiteInsertHandled, onCompletionActiveChange, onEditorNavigationHandled,
    onEditorPosition, onEnvRenameHandled, onFigureDropHandled, onFindReferences, onGotoDefinition,
    onTexlabGoto, onGotoLineRequest, onInsertOpenChange, onOutlineNavigate, onOutlineOpenChange,
    onPrepareFigure, onPasteImageFile, onCreateMissingFile, onRenameEnvironment, onRenameSymbol,
    onTableGeneratorOpenChange, onViewRestoreHandled, onViewState, onWrapEnvHandled, onWrapEnvironment,
    activeOutlineId, outlineNodes, outlineOpen, projectPaths, graphicsRoots, setSource,
    source: editorSource, tableGeneratorOpen, viewRestore, wrapEnvRequest, editorComments,
    commentAuthorName, commentAuthorId, onCreateEditorComment, onOpenEditorComments,
    commentFocusRequest, onCommentFocusHandled, getFileViewState, onFileViewState,
  } = props;
  const { i18n, t } = useLingui();
  const editorCommentLocalization = useMemo<EditorCommentLocalization>(() => ({
    locale: i18n.locale,
    anonymous: t`Anonymous`,
    noCommentText: t`(no comment text)`,
    reopen: t`Reopen`,
    resolve: t`Resolve comment`,
    reply: t`Reply`,
  }), [i18n.locale, t]);
  const editorCommentLocalizationRef = useRef(editorCommentLocalization);
  useEffect(() => {
    editorCommentLocalizationRef.current = editorCommentLocalization;
  }, [editorCommentLocalization]);
  // Handlers CodeMirror extensions and window listeners call after render read
  // the newest props through this, so those extensions never rebuild for them.
  const latestRef = useRef(props);
  latestRef.current = props;
  const primaryVisualMarkdownFlushRef = useRef<(() => boolean) | null>(null);
  const secondaryVisualMarkdownFlushRef = useRef<(() => boolean) | null>(null);
  const registerPrimaryVisualMarkdownFlush = useCallback((flush: (() => boolean) | null) => {
    primaryVisualMarkdownFlushRef.current = flush;
  }, []);
  const registerSecondaryVisualMarkdownFlush = useCallback((flush: (() => boolean) | null) => {
    secondaryVisualMarkdownFlushRef.current = flush;
  }, []);
  const flushPrimaryVisualMarkdown = useCallback(() => primaryVisualMarkdownFlushRef.current?.(), []);
  useLayoutEffect(() => {
    if (!props.onVisualMarkdownFlushChange) return;
    const flushVisualMarkdown = () => {
      if (primaryVisualMarkdownFlushRef.current?.() === false) return false;
      return secondaryVisualMarkdownFlushRef.current?.() !== false;
    };
    props.onVisualMarkdownFlushChange(flushVisualMarkdown);
    return () => props.onVisualMarkdownFlushChange?.(null);
  }, [props.onVisualMarkdownFlushChange]);
  const primarySurface: AgentHostSurface = props.activePaper ? "paper" : "editor";
  const primaryKind = props.activePaper ? null : structuredDocumentKind(activeFile);
  const presentationDocument = primaryKind === "presentation";
  const markdownDocument = (Boolean(props.activePaper) || activeFile.toLocaleLowerCase().endsWith(".md"))
    && !presentationDocument;
  const htmlDocument = !props.activePaper && isHtmlFilePath(activeFile);
  const explicitPreviewStart = props.markdownPreviewSource !== undefined && props.source.endsWith(props.markdownPreviewSource)
    ? props.source.length - props.markdownPreviewSource.length
    : 0;
  const markdownPreviewStart = props.markdownPreviewSource !== undefined
    ? explicitPreviewStart
    : markdownDocument
      ? markdownFrontmatterEnd(props.source)
      : 0;
  const markdownPreviewText = props.markdownPreviewSource ?? props.source.slice(markdownPreviewStart);
  const markdownPreviewEnd = markdownPreviewStart + markdownPreviewText.length;
  const markdownSyncPolicy = markdownPreviewSyncPolicy(markdownPreviewText.length);
  // Recorded for every document the preview publishes, so the settling below
  // can tell the preview's own echo from an outside edit. It is state, not a
  // ref, so the comparison is a render-safe read; the update batches with the
  // source write it accompanies and costs no extra render.
  const [visualEchoSource, setVisualEchoSource] = useState<string | null>(null);
  const settledPreviewText = useSettledPreviewText(
    // A LaTeX or plain-text file never reaches the Markdown preview, so feed
    // the settling a constant there: otherwise every keystroke in a .tex file
    // scheduled a publication whose only effect was one more render.
    markdownDocument ? markdownPreviewText : "",
    props.source === visualEchoSource,
    activeFile,
    markdownSyncPolicy.publicationIdleMs,
    markdownSyncPolicy.publicationMaxMs,
  );
  const paperFullTextActive = Boolean(
    props.activePaper
    && activeFile.replace(/\\/g, "/").toLocaleLowerCase().endsWith("/paper.md"),
  );
  const [paperVisualEligibility, setPaperVisualEligibility] = useState<{
    path: string;
    text: string;
    reason: string | null;
  } | null>(null);
  const reportPaperVisualEligibility = useCallback((reason: string | null) => {
    setPaperVisualEligibility((current) => {
      if (!paperFullTextActive) return null;
      if (
        current?.path === activeFile
        && current.text === settledPreviewText
        && current.reason === reason
      ) return current;
      return { path: activeFile, text: settledPreviewText, reason };
    });
  }, [activeFile, paperFullTextActive, settledPreviewText]);
  const paperVisualEligibilityReason = paperFullTextActive
    && paperVisualEligibility?.path === activeFile
    && paperVisualEligibility.text === settledPreviewText
    ? paperVisualEligibility.reason
    : null;
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
  const secondaryViewRef = useRef<EditorView | null>(null);
  const [primaryScrollbarView, setPrimaryScrollbarView] = useState<EditorView | null>(null);
  const [secondaryScrollbarView, setSecondaryScrollbarView] = useState<EditorView | null>(null);
  const markdownPreviewViewportRef = useRef<HTMLDivElement | null>(null);
  const [markdownPreviewViewport, setMarkdownPreviewViewport] = useState<HTMLDivElement | null>(null);
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
  // Populated by the split scroll coordinator; poked from the primary
  // editor's update listener so cursor motion can reveal the matching
  // preview block (VS Code-style cursor-driven synchronization).
  const markdownCursorRevealRef = useRef<(() => void) | null>(null);
  const markdownPreviewReconcileFromSourceRef = useRef<(() => void) | null>(null);
  const markdownPreviewOverflowAnchorRef = useRef("");
  const lastInsertionPositionRef = useRef(0);
  const pendingFigureCursorRef = useRef<{ pane: EditorPaneId; cursor: number } | null>(null);
  const {
    splitRef,
    splitRatio,
    columnsPdfRatio,
    beginDualResize,
    beginColumnsPdfResize,
    beginSplitResize,
    nudgeSplit,
  } = useSplitLayout(props.mode, props.dualRatioResetGeneration);
  const [figureDropActive, setFigureDropActive] = useState(false);
  const [figureDropMarker, setFigureDropMarker] = useState<{ top: number; line: number } | null>(null);
  const [cursorOffset, setCursorOffset] = useState(0);
  const [statusPosition, setStatusPosition] = useState({ line: 1, column: 0 });
  const [vimModes, setVimModes] = useState<{ primary: string; secondary: string }>({
    primary: "normal",
    secondary: "normal",
  });
  const [snippetStops, setSnippetStops] = useState<{ base: number; stops: { from: number; to: number }[] } | null>(null);
  const [figureInsertPending, setFigureInsertPending] = useState<{
    paths: string[];
    position: number;
    pane: EditorPaneId;
  } | null>(null);
  const [commentComposer, setCommentComposer] = useState<CommentDraft | null>(null);
  const commentComposerViewRef = useRef<EditorView | null>(null);
  const commentComposerRef = useRef(commentComposer);
  useLayoutEffect(() => {
    commentComposerRef.current = commentComposer;
  }, [commentComposer]);
  // Saved-view ownership for the preview column. Files without a preview of
  // their own (.bib, .sty) keep using the last previewable file's saved state.
  // This is separate from the mounted viewer's identity: all TeX source files
  // share the project's compiled PDF, including across SyncTeX jumps.
  const [previewIdentity, setPreviewIdentity] = useState(activeFile);
  useEffect(() => {
    const owner = isPreviewableSourceFilePath(activeFile)
      ? activeFile
      : secondaryFile && isPreviewableSourceFilePath(secondaryFile)
        ? secondaryFile
        : null;
    if (owner) setPreviewIdentity(owner);
  }, [activeFile, secondaryFile]);

  const activeFileRef = useRef(activeFile);
  activeFileRef.current = activeFile;
  const { captureMarkdownModeViewport, viewMarkdownSource } = useMarkdownModeHandoff({
    activeFile,
    mode: props.mode,
    markdownDocument,
    previewStart: markdownPreviewStart,
    primaryViewRef,
    primaryViewPathRef,
    previewViewportRef: markdownPreviewViewportRef,
    previewViewport: markdownPreviewViewport,
    primaryView: primaryScrollbarView,
    activeFileRef,
    scrollSyncSuppressedRef: markdownScrollSyncSuppressedRef,
    reconcileFromSourceRef: markdownPreviewReconcileFromSourceRef,
    onViewMarkdownSource: props.onViewMarkdownSource,
  });
  useLayoutEffect(() => {
    const register = props.onMarkdownModeViewportCaptureChange;
    if (!register) return;
    register(captureMarkdownModeViewport);
    return () => register(null);
  }, [captureMarkdownModeViewport, props.onMarkdownModeViewportCaptureChange]);

  const focusedPath = focusedPane === "secondary" && secondaryFile ? secondaryFile : activeFile;
  const focusedSource = focusedPane === "secondary" && secondaryFile ? secondarySource : editorSource;
  const [selectedText, setSelectedText] = useState("");
  const [selectionToolbar, setSelectionToolbar] = useState<{
    pane: EditorPaneId;
    position: LatexSelectionToolbarPosition;
  } | null>(null);
  const commentsForActiveFile = useMemo(
    () => editorComments.filter((comment) => comment.path === activeFile),
    [activeFile, editorComments],
  );
  const commentsForActiveFileRef = useRef(commentsForActiveFile);
  commentsForActiveFileRef.current = commentsForActiveFile;
  const commentsForSecondaryFile = useMemo(
    () => editorComments.filter((comment) => comment.path === secondaryFile),
    [secondaryFile, editorComments],
  );
  const commentsForSecondaryFileRef = useRef(commentsForSecondaryFile);
  useLayoutEffect(() => {
    commentsForSecondaryFileRef.current = commentsForSecondaryFile;
  }, [commentsForSecondaryFile]);

  // Comments rebased into the preview's own coordinates. The preview may render
  // a slice of the file, and anchors are resolved against the text it was given
  // — offsets from the whole document would land in the wrong prose or nowhere.
  const markdownVisualComments = useMemo(
    () => rangesWithinPreview(commentsForActiveFile, markdownPreviewStart, markdownPreviewEnd),
    [commentsForActiveFile, markdownPreviewEnd, markdownPreviewStart],
  );

  const latexLive = {
    citationKeys: props.citationKeys,
    citations: props.citations,
    references: props.references,
    unusedLabels: props.unusedLabels,
    unusedCitations: props.unusedCitations,
    localMacros,
    graphicsRoots,
    projectPaths,
    onOpenCitation: props.onOpenCitation,
    canOpenCitation: props.canOpenCitation,
    spellingWords: props.spellingWords,
    onAddSpellingWord: props.onAddSpellingWord,
  };
  const latexLiveRef = useRef(latexLive);
  latexLiveRef.current = latexLive;

  const diagnosticsRef = useRef({ build: buildDiagnostics, texlab: texlabDiagnostics });
  diagnosticsRef.current = { build: buildDiagnostics, texlab: texlabDiagnostics };

  useEffect(() => {
    for (const view of [primaryViewRef.current, secondaryViewRef.current]) {
      if (view) refreshLint(view);
    }
  }, [buildDiagnostics, texlabDiagnostics]);

  useEffect(() => {
    for (const view of [primaryViewRef.current, secondaryViewRef.current]) {
      if (!view) continue;
      view.dispatch({ effects: harperDictionaryChanged.of(null) });
      refreshLint(view);
    }
  }, [props.spellingWords]);

  const focusedPaneRef = useRef(focusedPane);
  focusedPaneRef.current = focusedPane;
  const onCompletionActiveChangeRef = useRef(onCompletionActiveChange);
  const completionActiveRef = useRef(false);
  const reportEditorPositionRef = useRef<(view: EditorView, path: string) => void>(() => {});
  const updateSelectionToolbarRef = useRef<(view: EditorView, path: string) => void>(() => {});
  const selectionToolbarOwnerRef = useRef<{
    pane: EditorPaneId;
    path: string;
    from: number;
    to: number;
  } | null>(null);
  const dismissSelectionToolbar = useCallback(() => {
    selectionToolbarOwnerRef.current = null;
    setSelectionToolbar(null);
  }, []);
  /** Focus moving into `pane` drops a toolbar the other pane's selection owns. */
  const claimSelectionToolbar = (pane: EditorPaneId) => {
    if (selectionToolbarOwnerRef.current?.pane !== pane) dismissSelectionToolbar();
  };

  const collabSeedSourceRef = useRef(props.source);
  collabSeedSourceRef.current = props.source;
  const collabExtensions = useMemo(() => {
    // Binding before the host's Y.Texts have synced can create a competing
    // placeholder. Keep this stable across keystrokes so yCollab listeners live.
    if (!collabSession || !activeFile || !collabReady) return EMPTY_EXTENSIONS;
    // Joining/materializing updates several parent states in one transition.
    // Never turn a transient path mismatch into a render-time app crash; the
    // awaited loadFile/openPath flow will re-render once this path is active.
    if (collabSession.activePath !== activeFile) return EMPTY_EXTENSIONS;
    collabSession.setActivePath(activeFile, collabSeedSourceRef.current);
    return collabEditorExtensions(collabSession);
    // awarenessVersion: a transport reconnect swaps provider.awareness — rebuild
    // yCollab against the live Awareness or remote carets silently freeze.
  }, [activeFile, collabReady, collabSession, collabSession?.awarenessVersion]);
  const collabLive = collabExtensions.length > 0;
  const [secondaryCollabBinding, setSecondaryCollabBinding] = useState<{
    session: EditorCollabSession;
    path: string;
    binding: EditorCollabBinding;
  } | null>(null);
  const [secondaryBindingVersion, setSecondaryBindingVersion] = useState(0);
  useEffect(() => collabSession?.subscribeSecondaryBindingChanges?.(
    () => setSecondaryBindingVersion((version) => version + 1),
  ), [collabSession]);
  useEffect(() => {
    let disposed = false;
    if (!collabSession || !collabReady || !secondaryFile || !collabSession.openSecondaryPath) {
      if (!secondaryFile) collabSession?.releaseSecondaryPath?.();
      return () => { disposed = true; };
    }
    void collabSession.openSecondaryPath(secondaryFile).then((binding) => {
      if (!disposed) {
        setSecondaryCollabBinding(binding ? { session: collabSession, path: secondaryFile, binding } : null);
      }
    }).catch(() => {
      if (!disposed) setSecondaryCollabBinding(null);
    });
    return () => { disposed = true; };
  }, [collabReady, collabSession, secondaryBindingVersion, secondaryFile]);
  const secondaryCollabLive = collabReady
    && secondaryCollabBinding?.session === collabSession
    && secondaryCollabBinding.path === secondaryFile;
  const secondaryCollabExtensions = useMemo(
    () => secondaryCollabLive
      ? collabEditorExtensions(secondaryCollabBinding.binding)
      : EMPTY_EXTENSIONS,
    [secondaryCollabBinding, secondaryCollabLive],
  );
  // Lattice collab (v2) carets for the visual editor: the same awareness room
  // the source editor's yCollab binds, resolved to row/column against the live
  // Y.Text and shifted into preview coordinates like the Overleaf carets above.
  // A remote caret move publishes a fresh peer list. Memoize against that
  // signal so unrelated App renders do not dispatch equal PM decorations.
  const collabVisualCursors = useMemo(() => {
    const cursors: PresenceCursor[] = [];
    if (!collabLive || !markdownDocument || !collabSession?.boardPresenceUser) return cursors;
    const text = collabSession.ytext.toString();
    for (const caret of peerCaretOffsetsV2(collabSession)) {
      const before = text.slice(0, caret.index);
      const row = before.split("\n").length - 1;
      if (row < markdownPreviewLineOffset) continue;
      cursors.push({
        name: caret.name,
        hue: hueFromColorHex(caret.color),
        color: caret.color,
        row: row - markdownPreviewLineOffset,
        column: caret.index - (before.lastIndexOf("\n") + 1),
      });
    }
    return cursors;
    // onPeers publishes a fresh list for awareness updates, including carets.
  }, [collabLive, collabSession, markdownDocument, markdownPreviewLineOffset, props.collabPeers, props.source]);
  const allMarkdownVisualCursors = useMemo(
    () => collabVisualCursors.length
      ? [...markdownVisualCursors, ...collabVisualCursors]
      : markdownVisualCursors,
    [collabVisualCursors, markdownVisualCursors],
  );
  const mountSourceRef = useRef(props.source);
  const visualSourceHistoryRef = useRef<{ path: string; undo: string[]; redo: string[] }>({
    path: activeFile,
    undo: [],
    redo: [],
  });
  const prevCollabEditorKeyRef = useRef(collabEditorKey);
  if (prevCollabEditorKeyRef.current !== collabEditorKey) {
    prevCollabEditorKeyRef.current = collabEditorKey;
    mountSourceRef.current = props.source;
  }
  useEffect(() => {
    const view = primaryViewRef.current;
    if (view?.dom.isConnected) {
      mountSourceRef.current = view.state.doc.toString();
      visualSourceHistoryRef.current = { path: activeFile, undo: [], redo: [] };
      return;
    }
    if (mountSourceRef.current !== props.source) {
      visualSourceHistoryRef.current = { path: activeFile, undo: [], redo: [] };
      mountSourceRef.current = props.source;
    }
  }, [activeFile, props.mode, props.source]);

  useEffect(() => {
    if (!collabLive || primaryViewRef.current?.dom.isConnected || !collabSession || activeFile !== collabSession.activePath) return;
    const ytext = collabSession.ytext;
    const syncPreviewSource = () => {
      const next = ytext.toString();
      mountSourceRef.current = next;
      latestRef.current.setSource(next);
    };
    ytext.observe(syncPreviewSource);
    syncPreviewSource();
    return () => ytext.unobserve(syncPreviewSource);
  }, [activeFile, collabLive, collabSession, props.mode]);

  useEffect(() => {
    if (!secondaryCollabLive || !secondaryCollabBinding) return;
    const { ytext } = secondaryCollabBinding.binding;
    const syncSecondarySource = () => {
      latestRef.current.setSecondarySource(ytext.toString());
    };
    ytext.observe(syncSecondarySource);
    syncSecondarySource();
    return () => ytext.unobserve(syncSecondarySource);
  }, [secondaryCollabBinding, secondaryCollabLive]);

  // Stable callbacks. CodeMirrorHost reads handlers through refs, so identity
  // churn no longer forces a reconfigure (the old wrapper destroyed yCollab +
  // comment fields on any handler identity change) — kept stable regardless.
  const onPrimaryChange = useCallback((value: string) => {
    latestRef.current.setSource(value);
  }, []);
  useEffect(() => {
    onCompletionActiveChangeRef.current = onCompletionActiveChange;
  }, [onCompletionActiveChange]);
  /** Publish the focused pane's selection and caret after an editor update. */
  const reportPaneUpdate = useCallback((pane: EditorPaneId, viewUpdate: { state: EditorView["state"]; view: EditorView }) => {
    if (focusedPaneRef.current !== pane) return false;
    const range = viewUpdate.state.selection.main;
    lastInsertionPositionRef.current = range.head;
    const nextSelection = range.empty ? "" : viewUpdate.state.sliceDoc(range.from, range.to);
    latestRef.current.setSelection(nextSelection);
    setSelectedText(nextSelection);
    return true;
  }, []);
  const onPrimaryUpdate = useCallback((viewUpdate: { state: EditorView["state"]; view: EditorView }) => {
    const completionActive = completionStatus(viewUpdate.state) !== null;
    if (completionActiveRef.current !== completionActive) {
      completionActiveRef.current = completionActive;
      onCompletionActiveChangeRef.current(completionActive);
    }
    if (!reportPaneUpdate("primary", viewUpdate)) return;
    if (viewUpdate.state.selection.main.empty) setCommentComposer(null);
    updateSelectionToolbarRef.current(viewUpdate.view, latestRef.current.activeFile);
    reportEditorPositionRef.current?.(viewUpdate.view, latestRef.current.activeFile);
    markdownCursorRevealRef.current?.();
  }, [reportPaneUpdate]);
  useEffect(() => () => {
    if (completionActiveRef.current) onCompletionActiveChangeRef.current(false);
  }, []);
  const onSecondaryChange = useCallback((value: string) => {
    if (secondaryCollabBinding?.path === latestRef.current.secondaryFile) {
      const current = secondaryCollabBinding.binding.ytext.toString();
      if (current !== value) {
        if (current !== secondarySource) {
          latestRef.current.setSecondarySource(current);
          return;
        }
        mergeTextIntoYText(secondaryCollabBinding.binding.ytext, value);
      }
    }
    latestRef.current.setSecondarySource(value);
  }, [secondaryCollabBinding, secondarySource]);
  const onSecondaryUpdate = useCallback((viewUpdate: { state: EditorView["state"]; view: EditorView }) => {
    if (!reportPaneUpdate("secondary", viewUpdate)) return;
    const path = latestRef.current.secondaryFile;
    if (path) {
      updateSelectionToolbarRef.current(viewUpdate.view, path);
      reportEditorPositionRef.current?.(viewUpdate.view, path);
    }
  }, [reportPaneUpdate]);

  const updateSelectionToolbar = useCallback((view: EditorView, path: string) => {
    const range = view.state.selection.main;
    if (range.empty || (!path.endsWith(".tex") && !path.toLocaleLowerCase().endsWith(".md"))) {
      dismissSelectionToolbar();
      return;
    }
    const editorBounds = view.dom.closest(".source-editor")?.getBoundingClientRect();
    const visibleRange = view.visibleRanges.find(({ from, to }) => range.from <= to && range.to >= from);
    if (!visibleRange) {
      dismissSelectionToolbar();
      return;
    }
    const visibleFrom = Math.max(range.from, visibleRange.from);
    const line = view.state.doc.lineAt(visibleFrom);
    const visibleTo = Math.min(range.to, visibleRange.to, line.to);
    const start = view.coordsAtPos(visibleFrom);
    const end = view.coordsAtPos(visibleTo);
    if (!editorBounds || !start || !end) {
      dismissSelectionToolbar();
      return;
    }
    const estimatedWidth = Math.min(346, Math.max(0, editorBounds.width - 16));
    const halfWidth = estimatedWidth / 2;
    const selectionCenter = start.top === end.top
      ? (start.left + end.right) / 2
      : start.left + Math.min(72, Math.max(20, editorBounds.width / 5));
    const left = clamp(selectionCenter, editorBounds.left + halfWidth + 8, editorBounds.right - halfWidth - 8);
    const selectionTop = Math.min(start.top, end.top);
    const below = selectionTop - editorBounds.top < 52;
    const pane: EditorPaneId = view === secondaryViewRef.current ? "secondary" : "primary";
    selectionToolbarOwnerRef.current = { pane, path, from: range.from, to: range.to };
    setSelectionToolbar({
      pane,
      position: {
        left,
        top: below ? start.bottom + 8 : selectionTop - 8,
        below,
        maxWidth: Math.max(0, editorBounds.width - 16),
      },
    });
  }, [dismissSelectionToolbar]);
  updateSelectionToolbarRef.current = updateSelectionToolbar;

  useEffect(() => {
    let frame: number | null = null;
    const reposition = () => {
      const owner = selectionToolbarOwnerRef.current;
      if (!owner) return;
      const view = owner.pane === "secondary" ? secondaryViewRef.current : primaryViewRef.current;
      if (view) updateSelectionToolbar(view, owner.path);
    };
    const scheduleReposition = () => {
      if (frame != null || !selectionToolbarOwnerRef.current) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        reposition();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleReposition);
    for (const view of [primaryViewRef.current, secondaryViewRef.current]) {
      const editor = view?.dom.closest(".source-editor");
      if (editor) resizeObserver.observe(editor);
    }
    window.addEventListener("resize", scheduleReposition);
    window.addEventListener("scroll", scheduleReposition, true);
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleReposition);
      window.removeEventListener("scroll", scheduleReposition, true);
    };
  }, [activeFile, focusedPane, secondaryFile, updateSelectionToolbar]);

  useEffect(() => {
    if (props.mode === "pdf" || props.mode === "asset") dismissSelectionToolbar();
  }, [dismissSelectionToolbar, props.mode]);

  useEffect(dismissSelectionToolbar, [activeFile, dismissSelectionToolbar, secondaryFile]);

  useEffect(() => {
    primaryViewRef.current?.dispatch({ effects: setEditorCommentsEffect.of(commentsForActiveFile) });
  }, [commentsForActiveFile, collabEditorKey]);

  useLayoutEffect(() => {
    primaryViewRef.current?.dispatch({
      effects: setEditorCommentDraftEffect.of(commentComposer?.path === activeFile ? commentComposer : null),
    });
  }, [activeFile, commentComposer, collabEditorKey]);

  useEffect(() => {
    secondaryViewRef.current?.dispatch({ effects: setEditorCommentsEffect.of(commentsForSecondaryFile) });
  }, [commentsForSecondaryFile, collabEditorKey]);

  // Someone else's caret has to repaint when they move it, not when we
  // happen to type next.
  useEffect(() => {
    primaryViewRef.current?.dispatch({ effects: setOverleafCursorsEffect.of(props.overleafPresenceCursors) });
  }, [props.overleafPresenceCursors, collabEditorKey]);

  useEffect(() => {
    if (!commentFocusRequest) return;
    const comment = editorComments.find((item) => item.id === commentFocusRequest.id);
    if (!comment) return;
    const view = comment.path === activeFile
      ? primaryViewRef.current
      : comment.path === secondaryFile ? secondaryViewRef.current : null;
    if (!view) return;
    const range = resolveCommentRange(view.state.doc.toString(), comment);
    if (range) {
      view.dispatch({
        selection: { anchor: range.from, head: range.to },
        effects: EditorView.scrollIntoView(range.from, { y: "center" }),
      });
      view.focus();
    }
    onCommentFocusHandled(commentFocusRequest.nonce);
  }, [activeFile, secondaryFile, commentFocusRequest, editorComments, onCommentFocusHandled]);

  const openCommentComposer = useCallback((targetView?: EditorView) => {
    const view = targetView ?? editorViewRef.current;
    if (!view || !activeFile) return;
    const range = view.state.selection.main;
    if (range.empty) return;
    const quote = view.state.sliceDoc(range.from, range.to);
    if (!quote.trim()) return;
    setCommentComposer({
      path: activeFile,
      from: range.from,
      to: range.to,
      quote,
      prefix: view.state.sliceDoc(Math.max(0, range.from - 32), range.from),
      suffix: view.state.sliceDoc(range.to, Math.min(view.state.doc.length, range.to + 32)),
      body: "",
      error: null,
    });
    commentComposerViewRef.current = view;
  }, [activeFile]);

  const applySelectionAction = useCallback((action: LatexSelectionAction, value?: string) => {
    const owner = selectionToolbarOwnerRef.current;
    if (!owner) return;
    const view = owner.pane === "secondary" ? secondaryViewRef.current : primaryViewRef.current;
    const ownerFile = owner.pane === "secondary" ? latestRef.current.secondaryFile : latestRef.current.activeFile;
    if (!view || owner.path !== ownerFile) return;
    const range = view.state.selection.main;
    if (range.empty || range.from !== owner.from || range.to !== owner.to) {
      dismissSelectionToolbar();
      return;
    }
    if (action === "comment") {
      if (owner.pane !== "primary") return;
      openCommentComposer(view);
      dismissSelectionToolbar();
      return;
    }
    if (owner.pane === "secondary" ? !props.secondaryEditorEditable : !props.editorEditable) return;
    const wrap = SELECTION_WRAPS[action](value);
    if (!wrap) return;
    const edit = wrapRange(view.state.doc.toString(), range.from, range.to, ...wrap);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: { anchor: edit.cursorFrom, head: edit.cursorTo },
      scrollIntoView: true,
    });
    view.focus();
    updateSelectionToolbar(view, owner.path);
  }, [
    dismissSelectionToolbar,
    openCommentComposer,
    props.editorEditable,
    props.secondaryEditorEditable,
    updateSelectionToolbar,
  ]);

  const saveCommentComposer = useCallback(() => {
    if (!commentComposer || !activeFile) return;
    if (commentComposer.path !== activeFile) {
      setCommentComposer(null);
      return;
    }
    const range = resolveCommentAnchor(editorSource, commentComposer);
    if (!range) {
      setCommentComposer((current) => current ? {
        ...current,
        error: t`The selected text changed. Select it again before commenting.`,
      } : current);
      return;
    }
    const comment = createEditorComment({
      path: activeFile,
      source: editorSource,
      from: range.from,
      to: range.to,
      body: commentComposer.body,
      authorId: commentAuthorId,
      authorName: commentAuthorName,
    });
    if (!comment) return;
    onCreateEditorComment(comment);
    setCommentComposer(null);
    commentComposerViewRef.current?.focus();
  }, [activeFile, commentAuthorId, commentAuthorName, commentComposer, editorSource, onCreateEditorComment, t]);
  const closeCommentComposer = useCallback(() => {
    setCommentComposer(null);
    commentComposerViewRef.current?.focus();
  }, []);
  /** Create a comment on `[from, to)` of `path`, as the visual editors do. */
  const createPreviewComment = (path: string, source: string, from: number, to: number, body: string) => {
    const comment = createEditorComment({ path, source, from, to, body, authorId: commentAuthorId, authorName: commentAuthorName });
    if (comment) onCreateEditorComment(comment);
  };
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
    onEditorPosition({ path, line: line.number, column });
    onViewState(path, { cursor: head, scrollTop: view.scrollDOM.scrollTop });
  }, [onEditorPosition, onViewState]);
  const reportVimMode = useCallback((pane: EditorPaneId, mode: string) => {
    setVimModes((current) => current[pane] === mode ? current : { ...current, [pane]: mode });
  }, []);
  const reportPrimaryVimMode = useCallback((mode: string) => reportVimMode("primary", mode), [reportVimMode]);
  const reportSecondaryVimMode = useCallback((mode: string) => reportVimMode("secondary", mode), [reportVimMode]);
  const primaryKeymapExtensions = useOptionalKeymapExtensions(editorKeymap, reportPrimaryVimMode);
  const secondaryKeymapExtensions = useOptionalKeymapExtensions(editorKeymap, reportSecondaryVimMode);
  const primaryTextLanguageExtensions = useTextLanguageExtensions(
    isLatexSourcePath(activeFile) ? "" : activeFile,
  );
  const secondaryTextLanguageExtensions = useTextLanguageExtensions(
    secondaryFile && !isLatexSourcePath(secondaryFile) ? secondaryFile : "",
  );
  const paperLibraryRef = useRef({ projectRoot: props.projectRoot, papers: props.papers ?? [] });
  useLayoutEffect(() => {
    paperLibraryRef.current = { projectRoot: props.projectRoot, papers: props.papers ?? [] };
  }, [props.projectRoot, props.papers]);
  reportEditorPositionRef.current = reportEditorPosition;
  /** Language, completion and diagnostics for either pane's editor of `path`. */
  const documentExtensions = (path: string, textLanguage: Extension[]): Extension[] => [
    ...(isLatexSourcePath(path) ? [
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
        editorSpellcheck && isHarperProseFilePath(path),
        props.unusedLabels,
        props.unusedCitations,
        onRenameEnvironment,
        onWrapEnvironment,
        localMacros,
        path,
        onPasteImageFile,
        graphicsRoots,
        onCreateMissingFile,
        true,
        onTexlabGoto,
        latexLiveRef,
      ),
    ] : [
      ...textLanguage,
      ...textEditorExtensions(editorSpellcheck && isHarperProseFilePath(path), latexLiveRef, onPasteImageFile),
    ]),
  ];
  const diagnosticsExtensions = (path: string): Extension[] => [
    linter((view) => editorDiagnosticsForFile(diagnosticsRef.current.build, path, view.state.doc), { delay: 150 }),
    ...(isLatexSourcePath(path) ? [linter(
      (view) => editorTexlabDiagnosticsForFile(diagnosticsRef.current.texlab, path, view.state.doc),
      { delay: 200 },
    )] : []),
  ];
  const commentActions = {
    getLocalization: () => editorCommentLocalizationRef.current,
    currentAuthorId: commentAuthorId,
    onResolve: (id: string) => latestRef.current.onResolveEditorComment(id),
    onReply: (comment: EditorComment) => latestRef.current.onReplyEditorComment(comment.id),
  };
  const editorExtensions = useMemo(
    () => [
      // The extension reads the library only in its drop handler, not during render.
      // eslint-disable-next-line react-hooks/refs
      paperDropExtension(activeFile, () => paperLibraryRef.current),
      ...primaryKeymapExtensions,
      ...documentExtensions(activeFile, primaryTextLanguageExtensions),
      ...collabExtensions,
      overleafCursorsExtension({ getCursors: () => latestRef.current.overleafPresenceCursors }),
      overleafTrackChangesExtension({
        getChanges: () => latestRef.current.overleafChanges,
        authorName: (userId) => latestRef.current.overleafTrackChangeActions.authorName(userId),
        canAct: () => latestRef.current.overleafTrackChangeActions.canAct(),
        onAccept: (change) => latestRef.current.overleafTrackChangeActions.onAccept(change),
        onReject: (change) => latestRef.current.overleafTrackChangeActions.onReject(change),
      }),
      editorCommentsExtension(activeFile, {
        ...commentActions,
        getComments: () => commentsForActiveFileRef.current,
        getDraft: () => commentComposerRef.current,
      }),
      ...diagnosticsExtensions(activeFile),
    ],
    // Volatile macros/diagnostics/comments are read via refs so this array stays
    // stable across keystrokes — otherwise reconfigure kills yCollab carets.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional stability
    [activeFile, collabExtensions, editorSpellcheck, primaryKeymapExtensions, primaryTextLanguageExtensions],
  );
  const secondaryEditorExtensions = useMemo(
    () => secondaryFile ? [
      // The extension reads the library only in its drop handler, not during render.
      // eslint-disable-next-line react-hooks/refs
      paperDropExtension(secondaryFile, () => paperLibraryRef.current),
      ...secondaryKeymapExtensions,
      ...documentExtensions(secondaryFile, secondaryTextLanguageExtensions),
      ...secondaryCollabExtensions,
      // These getters run in CodeMirror transactions/tooltips, not React render.
      editorCommentsExtension(secondaryFile, {
        ...commentActions,
        getComments: () => commentsForSecondaryFileRef.current,
      }),
      ...diagnosticsExtensions(secondaryFile),
    ] : [],
    // Mirror the primary editor's contract above: volatile inputs (macros,
    // graphics roots, citations/references, App-provided lambdas) are
    // captured at reconfigure time and refreshed on file switch. Listing them
    // here handed the memo a fresh identity every keystroke, and
    // CodeMirrorHost (like the wrapper it replaced) answers a changed
    // extensions identity with a full StateEffect.reconfigure — which would
    // tear down the entire secondary editor (language, linters, autocomplete)
    // per character in dual/split mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional stability
    [editorSpellcheck, secondaryCollabExtensions, secondaryFile, secondaryKeymapExtensions, secondaryTextLanguageExtensions],
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
    const head = expanded.stops[0] ? from + expanded.stops[0].to : anchor;
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
  const insertFigures = useCallback(async (
    paths: string[],
    coordinates?: { x: number; y: number },
    pane: EditorPaneId = focusedPane,
  ) => {
    const view = pane === "secondary" ? secondaryViewRef.current : primaryViewRef.current;
    if (!view || !paths.length) return;
    const targetPath = pane === "secondary" && secondaryFile ? secondaryFile : activeFile;
    let coordinatePosition: number | null = null;
    if (coordinates && coordinates.x >= 0 && coordinates.y >= 0) {
      try {
        coordinatePosition = view.posAtCoords(coordinates);
      } catch {
        // CodeMirror may not have layout coordinates yet; use the current cursor instead.
      }
    }
    const cursor = coordinatePosition ?? view.state.selection.main.head;
    const position = view.state.doc.lineAt(clamp(cursor, 0, view.state.doc.length)).from;
    if (targetPath.toLocaleLowerCase().endsWith(".md")) {
      const edit = markdownAssetInsertion(view.state.doc.toString(), position, paths, targetPath);
      view.dispatch({
        changes: { from: position, insert: edit.text },
        selection: { anchor: position + edit.cursorOffset },
        scrollIntoView: true,
      });
      editorViewRef.current = view;
      onFocusPane(pane);
      view.focus();
      return;
    }
    if (!targetPath.toLocaleLowerCase().endsWith(".tex")) return;
    const prepared: string[] = [];
    for (const path of paths) {
      const latexPath = await onPrepareFigure(path);
      if (latexPath) prepared.push(latexPath);
    }
    if (!prepared.length) return;
    setFigureInsertPending({ paths: prepared, position, pane });
  }, [activeFile, focusedPane, onFocusPane, onPrepareFigure, secondaryFile]);
  const confirmFigureInsert = useCallback((options: FigureInsertOptions) => {
    const pending = figureInsertPending;
    if (!pending) return;
    const source = pending.pane === "secondary" ? secondarySource : editorSource;
    const edit = latexFigureInsertion(source, pending.position, pending.paths, options);
    pendingFigureCursorRef.current = {
      pane: pending.pane,
      cursor: pending.position + edit.cursorOffset,
    };
    const nextSource = `${source.slice(0, pending.position)}${edit.text}${source.slice(pending.position)}`;
    if (pending.pane === "secondary") setSecondarySource(nextSource);
    else setSource(nextSource);
    setFigureInsertPending(null);
  }, [editorSource, figureInsertPending, secondarySource, setFigureInsertPending, setSecondarySource, setSource]);
  useEffect(() => {
    const pendingCursor = pendingFigureCursorRef.current;
    if (!pendingCursor) return;
    const view = pendingCursor.pane === "secondary" ? secondaryViewRef.current : primaryViewRef.current;
    const currentSource = pendingCursor.pane === "secondary" ? secondarySource : editorSource;
    if (!view || view.state.doc.toString() !== currentSource) return;
    pendingFigureCursorRef.current = null;
    editorViewRef.current = view;
    onFocusPane(pendingCursor.pane);
    view.dispatch({ selection: { anchor: pendingCursor.cursor }, scrollIntoView: true });
    view.focus();
  }, [editorSource, onFocusPane, secondarySource]);
  useEffect(() => {
    const request = editorNavigation;
    if (!request) return;
    const editorVisible = props.mode !== "pdf" && props.mode !== "asset";
    const inSecondary = request.path === secondaryFile;
    // Refs can be assigned just before CodeMirror's DOM reports connected.
    // Treat the view as ready here; otherwise a one-shot navigation can be
    // missed because the later ref attachment does not itself rerun this effect.
    const view = editorVisible
      ? inSecondary
        ? secondaryViewRef.current
        : request.path === activeFile
          ? primaryViewRef.current ?? editorViewRef.current
          : null
      : null;
    const preview = request.path === activeFile && markdownDocument ? markdownPreviewViewport : null;
    if (!view && !preview) return;
    let frame: number | null = null;
    let observer: MutationObserver | null = null;
    // codemirror-host holds an external value back while someone is typing, so
    // the view can still carry the previous file's text when a jump arrives.
    // Resolving the line against that document scrolls somewhere meaningless
    // and consumes the request, which is one of the ways a SyncTeX jump lands
    // in the wrong place. Wait for the text to catch up — but not forever: a
    // best-effort jump is better than a request nobody answers.
    const staleDocumentDeadline = performance.now() + 600;
    const navigate = () => {
      frame = null;
      const currentView = editorVisible
        ? inSecondary ? secondaryViewRef.current : primaryViewRef.current ?? editorViewRef.current
        : null;
      if (currentView) {
        const currentSource = inSecondary ? secondarySource : editorSource;
        if (currentView.state.doc.toString() !== currentSource && performance.now() < staleDocumentDeadline) {
          frame = window.requestAnimationFrame(navigate);
          return;
        }
        const line = currentView.state.doc.line(clamp(request.line, 1, currentView.state.doc.lines));
        // Center the target line so a jump lands in the middle of the viewport,
        // not pinned to the top (jumping down) or bottom (jumping up).
        currentView.dispatch({
          selection: { anchor: line.from },
          effects: EditorView.scrollIntoView(line.from, { y: "center" }),
        });
        editorViewRef.current = currentView;
        onFocusPane(inSecondary ? "secondary" : "primary");
        currentView.focus();
      } else if (preview) {
        const targetLine = Math.max(1, request.line - markdownPreviewLineOffset);
        const anchors = Array.from(preview.querySelectorAll<HTMLElement>("[data-source-line]"));
        if (!anchors.length) return;
        const target = anchors.reduce<HTMLElement | null>((closest, anchor) => {
          const line = Number(anchor.dataset.sourceLine);
          if (!Number.isFinite(line) || line > targetLine) return closest;
          const closestLine = Number(closest?.dataset.sourceLine ?? 0);
          return line > closestLine ? anchor : closest;
        }, null) ?? anchors[0];
        if (target) {
          const viewportRect = preview.getBoundingClientRect();
          const targetRect = target.getBoundingClientRect();
          preview.scrollTop += targetRect.top - viewportRect.top
            - (preview.clientHeight - targetRect.height) / 2;
        }
        onFocusPane("primary");
      }
      observer?.disconnect();
      onEditorNavigationHandled(request.id);
    };
    const scheduleNavigation = () => {
      if (frame != null) return;
      frame = window.requestAnimationFrame(navigate);
    };
    if (!view && preview) {
      observer = new MutationObserver(scheduleNavigation);
      observer.observe(preview, {
        attributes: true,
        attributeFilter: ["data-source-line"],
        childList: true,
        subtree: true,
      });
    }
    scheduleNavigation();
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [
    activeFile,
    editorNavigation,
    editorSource,
    markdownDocument,
    markdownPreviewLineOffset,
    markdownPreviewViewport,
    onEditorNavigationHandled,
    onFocusPane,
    props.mode,
    secondaryFile,
    secondarySource,
  ]);
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
    void insertFigures(request.paths, { x: request.clientX, y: request.clientY }, request.pane)
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
    if (!request) return;
    // An explicit jump supersedes an older saved position, including while
    // the editor is still mounting. Otherwise the pending restore can run on
    // a later render and undo a successfully completed SyncTeX navigation.
    if (editorNavigation?.path === request.path) {
      onViewRestoreHandled(request.id);
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
      onViewRestoreHandled(request.id);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFile, onViewRestoreHandled, viewRestore, editorSource, editorNavigation]);
  useEffect(() => {
    const request = envRenameRequest;
    const view = editorViewRef.current;
    if (!request || !view) return;
    const edits = renameEnvironmentAt(view.state.doc.toString(), view.state.selection.main.head, request.newName);
    if (edits) {
      view.dispatch({ changes: edits, scrollIntoView: true });
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
        view.dispatch({ selection: { anchor: previous.from, head: previous.to }, scrollIntoView: true });
        return;
      }
      const next = nextSnippetStop(snippetStops.stops, cursor, snippetStops.base);
      if (!next) return;
      const first = snippetStops.stops[0];
      const last = snippetStops.stops.at(-1);
      event.preventDefault();
      // Tabbing on from the last stop wraps to the first; end the snippet instead.
      if (last && cursor >= snippetStops.base + last.to && next.from === snippetStops.base + first.from) {
        setSnippetStops(null);
        return;
      }
      view.dispatch({ selection: { anchor: next.from, head: next.to }, scrollIntoView: true });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [snippetStops]);

  /** The primary source view, when it is connected and showing this file. */
  const livePrimaryView = useCallback(() => {
    const storedView = primaryViewRef.current;
    return storedView?.dom.isConnected && primaryViewPathRef.current === activeFile ? storedView : null;
  }, [activeFile]);
  const replaceVisualMarkdown = useCallback((nextBody: string, expectedBody: string) => {
    // VisualMarkdownEditor retains the previous publisher until its layout
    // flush. The host normally flushes before switching, but never let a late
    // callback mutate refs or setters once another document owns the canvas.
    if (activeFileRef.current !== activeFile) return false;
    const view = livePrimaryView();
    const ytext = collabReady && collabSession?.activePath === activeFile
      ? collabSession.ytext
      : null;
    const source = view?.state.doc.toString() ?? ytext?.toString() ?? mountSourceRef.current;
    const splice = spliceMarkdownBody(source, markdownPreviewStart, expectedBody, nextBody);
    if (!splice) return false;
    const nextSource = `${splice.prefix}${splice.inserted}`;
    const change = minimalTextChange(expectedBody, splice.inserted, markdownPreviewStart);
    // Mark the document this edit is about to produce, before any writer can
    // echo it back through props, so useSettledPreviewText hands it straight to
    // the preview and keeps the preview's accepted document level with the
    // source it just wrote.
    setVisualEchoSource(nextSource);

    if (view) {
      view.dispatch({ changes: change });
      mountSourceRef.current = nextSource;
      return true;
    }
    if (ytext) {
      if (ytext.toString() !== source) return false;
      collabSession?.undoManager.stopCapturing();
      ytext.doc?.transact(() => {
        ytext.delete(change.from, change.to - change.from);
        ytext.insert(change.from, change.insert);
      });
      collabSession?.undoManager.stopCapturing();
    } else {
      const history = visualSourceHistoryRef.current;
      if (history.path !== activeFile) {
        visualSourceHistoryRef.current = { path: activeFile, undo: [source], redo: [] };
      } else {
        history.undo.push(source);
        history.redo = [];
      }
    }
    mountSourceRef.current = nextSource;
    // This callback can be retained by VisualMarkdownEditor until its layout
    // flush during a path switch. Use the setter from the render that created
    // the callback; the mutable source-editor ref already belongs to the next
    // document by then and can otherwise receive the previous document body.
    props.setSource(nextSource);
    return true;
  }, [activeFile, collabReady, collabSession, livePrimaryView, markdownPreviewStart, props.setSource]);

  const lockMarkdownPreviewViewport = useCallback((
    anchor: HTMLElement | null,
    anchorTop: number | null,
    reveal: HTMLElement | null,
  ) => {
    const viewport = markdownPreviewViewportRef.current;
    if (!viewport) return;
    const scrollTop = viewport.scrollTop;
    const lock = markdownPreviewViewportLockRef.current + 1;
    if (markdownPreviewViewportLockRef.current === 0) {
      markdownPreviewOverflowAnchorRef.current = viewport.style.overflowAnchor;
    }
    markdownPreviewViewportLockRef.current = lock;
    viewport.style.overflowAnchor = "none";
    const restore = () => {
      if (markdownPreviewViewportLockRef.current !== lock || !viewport.isConnected) return false;
      restoreVisualViewportWithReveal(viewport, scrollTop, anchor, anchorTop, reveal);
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
    setMarkdownPreviewViewport(viewport);
    if (!viewport) return;
    const path = activeFile;
    const returnViewport = paperReturnViewportRef.current;
    // A pending source reveal owns the full-text viewport. Keep the blog
    // position until its explicit return, even if it briefly remounts first.
    const saved = quoteFallback?.path === path ? undefined
      : returnViewport?.path === path ? returnViewport : getFileViewState?.(path)?.visualMarkdown;
    if (!quoteFallback && returnViewport?.path === path) paperReturnViewportRef.current = null;
    let restoring = Boolean(saved);
    let restoreFrame: number | null = null;
    const report = () => {
      if (restoring) return;
      onFileViewState?.(path, {
        visualMarkdown: {
          scrollTop: viewport.scrollTop,
          scrollRange: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
        },
      });
    };
    viewport.addEventListener("scroll", report, { passive: true });
    if (saved) {
      let attempts = 0;
      const restore = () => {
        restoreFrame = null;
        attempts += 1;
        const ready = restoreViewport(viewport, { scrollTop: saved.scrollTop, scrollRange: saved.scrollRange ?? 0 });
        if (!ready && attempts < 30) {
          restoreFrame = window.requestAnimationFrame(restore);
          return;
        }
        restoring = false;
      };
      restoreFrame = window.requestAnimationFrame(restore);
    }
    markdownPreviewPersistenceCleanupRef.current = () => {
      if (restoreFrame !== null) window.cancelAnimationFrame(restoreFrame);
      restoring = false;
      report();
      viewport.removeEventListener("scroll", report);
    };
  }, [activeFile, getFileViewState, onFileViewState, paperReturnViewportRef, quoteFallback]);

  /** Visual-editor undo/redo: through Yjs when shared, CodeMirror when mounted, else the local history. */
  const stepVisualHistory = useCallback((direction: "undo" | "redo") => {
    const view = livePrimaryView();
    if (collabReady && collabSession?.activePath === activeFile) {
      const before = collabSession.ytext.toString();
      collabSession.undoManager[direction]();
      const after = collabSession.ytext.toString();
      setVisualEchoSource(after);
      return after !== before;
    }
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
  }, [activeFile, collabReady, collabSession, livePrimaryView]);
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
      viewState={props.getFileViewState?.(asset.path)}
      onViewState={(update) => props.onFileViewState?.(asset.path, update)}
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
  const structuredCollab = (path: string) => {
    const session = props.collabSession;
    if (!props.collabReady || !session?.boardPresenceUser) return null;
    const sideloaded = session.boardDocumentForPath?.(path);
    if (sideloaded) return { ...sideloaded, user: session.boardPresenceUser };
    return session.activePath === path
      ? {
        doc: session.doc,
        awareness: session.provider.awareness,
        user: session.boardPresenceUser,
        canWrite: session.canWrite !== false,
      }
      : null;
  };
  const spreadsheetCollab = (path: string) => {
    const session = props.collabSession;
    if (!props.collabReady || !session?.boardPresenceUser) return null;
    const commit = async () => {
      await session.settled?.();
      await session.flush?.();
    };
    const sideloaded = session.spreadsheetDocumentForPath?.(path);
    if (sideloaded) return { ...sideloaded, user: session.boardPresenceUser, commit };
    return session.activePath === path
      ? {
        doc: session.doc,
        awareness: session.provider.awareness,
        user: session.boardPresenceUser,
        canWrite: session.canWrite !== false,
        commit,
      }
      : null;
  };
  /**
   * A board, spreadsheet or Open Slide deck in `pane`. `active` is left unset
   * when the document owns the whole canvas.
   */
  const structuredEditor = (kind: StructuredDocumentKind, pane: EditorPaneId, active?: boolean) => {
    const primary = pane === "primary";
    const path = primary ? activeFile : secondaryFile!;
    const source = primary ? props.source : secondarySource;
    const onChange = primary ? (next: string) => latestRef.current.setSource(next) : onSecondaryChange;
    const onFlushPendingChange = primary ? registerPrimaryVisualMarkdownFlush : registerSecondaryVisualMarkdownFlush;
    const [fallbackClass, fallbackLabel] = structuredFallbacks[kind];
    // Remount per file so each board gets a fresh store. In v2 collaboration
    // the path-specific Y.Doc carries records; local and v1 boards serialize
    // back through the source buffer before a document switch.
    return (
      <Suspense
        fallback={(
          <div
            className={fallbackClass}
            aria-busy="true"
            aria-label={fallbackLabel}
            data-tour={kind === "presentation" && active === undefined ? "open-slide-workspace" : undefined}
          />
        )}
      >
        {kind === "board" ? (
          <BoardEditor
            key={path}
            path={path}
            source={source}
            onChange={onChange}
            collab={structuredCollab(path)}
            {...viewStateBinding(path, "board")}
            onFlushPendingChange={onFlushPendingChange}
            active={active}
          />
        ) : kind === "spreadsheet" ? (
          <SpreadsheetEditor
            key={path}
            path={path}
            source={source}
            onChange={onChange}
            onPersist={props.onSave}
            collab={spreadsheetCollab(path)}
            {...viewStateBinding(path, "spreadsheet")}
            onFlushPendingChange={onFlushPendingChange}
            active={active}
          />
        ) : (
          <OpenSlideWorkspace
            key={path}
            projectRoot={props.projectRoot}
            path={path}
            source={source}
            editable={primary ? props.editorEditable : props.secondaryEditorEditable}
            locale={props.locale}
            theme={props.theme}
            active={active}
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

  if (props.mode === "asset" && props.activeAsset) return assetPreview(props.activeAsset);
  const markdownPreview = (
    <ScrollArea
      className="markdown-preview"
      data-tour={props.activePaper ? "paper-reading-view" : "markdown-visual-editor"}
      // The document surface itself scrolls vertically; wide tables, code and
      // formulas own their local horizontal overflow. A second root scrollbar
      // made Base UI run another ResizeObserver loop as lazy blocks changed
      // size during scrolling.
      orientation="vertical"
      // Mask gradients repaint the full editable surface while scrolling in
      // WebKit. Markdown has a persistent scrollbar, so the fade adds cost
      // without adding useful overflow information.
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
        // Split mode has an explicit source/preview scroll coordinator and
        // insertion viewport lock. Native anchoring is a competing scroll
        // writer when media above the viewport resolves or remounts.
        style: props.mode === "split" ? { overflowAnchor: "none" } : undefined,
      }}
      viewportRef={attachMarkdownPreviewViewport}
      onPointerDownCapture={() => props.onContextSurfaceActivate(primarySurface)}
      onFocusCapture={() => props.onContextSurfaceActivate(primarySurface)}
      onPointerLeave={props.onEditorLeave}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) props.onEditorLeave();
      }}
      onMouseUp={props.activePaper ? (event) => {
        const liveSelection = window.getSelection();
        const anchor = liveSelection?.anchorNode;
        props.onPaperTextSelect(
          anchor && event.currentTarget.contains(anchor)
            ? liveSelection?.toString() ?? ""
            : "",
        );
      } : undefined}
    >
      {props.activePaper && paperFullTextActive && (
        <header className="paper-visual-header editor-content-aligned">
          <div>
            {paperVisualEligibilityReason && (
              <InlineMessage level="warning" className="paper-visual-eligibility">
                {paperVisualEligibilityReason}
              </InlineMessage>
            )}
            <h1>{props.activePaper.title}</h1>
            {props.activePaper.authors?.trim() && (
              <p>{props.activePaper.authors.trim().replace(/\s+and\s+/gi, " · ")}</p>
            )}
          </div>
        </header>
      )}
      <Suspense fallback={props.activePaper ? null : <MarkdownPreviewLoading />}>
        <DeferredVisualMarkdownEditor
          text={settledPreviewText}
          activePath={props.activeFile}
          projectRoot={props.activePaper ? undefined : props.projectRoot}
          optimizeForReading={Boolean(props.activePaper)}
          onEligibilityChange={paperFullTextActive ? reportPaperVisualEligibility : undefined}
          // Split previews keep source labels for scroll sync. Pure preview
          // enables them only for a pending navigation, so collaborator jumps
          // stay exact without paying the labeling cost while typing.
          synchronizeSourceScroll={props.mode === "split" || editorNavigation?.path === activeFile}
          onRequestViewportLock={lockMarkdownPreviewViewport}
          onOpenProjectPath={props.onOpenMarkdownPath}
          workspaceIndex={props.workspaceIndex}
          papers={props.papers}
          macros={katexMacros}
          onChangeMarkdown={replaceVisualMarkdown}
          onFlushPendingChange={registerPrimaryVisualMarkdownFlush}
          onUndo={undoVisualMarkdown}
          onRedo={redoVisualMarkdown}
          onViewInSource={viewMarkdownSource}
          onImportAsset={props.onImportAsset}
          onLoadAsset={props.onLoadReferenceImage}
          assetRevision={props.referenceImageGeneration ?? 0}
          presenceCursors={allMarkdownVisualCursors}
          overleafChanges={markdownVisualChanges}
          overleafTrackChangeActions={props.overleafTrackChangeActions}
          editorComments={markdownVisualComments}
          activeEditorCommentId={props.activeEditorCommentId}
          // Opens the panel focused on that thread — the same thing replying
          // from the source editor's tooltip does.
          onEditorCommentClick={props.onReplyEditorComment}
          onCreateComment={(from, to, body) => createPreviewComment(
            activeFile, props.source, markdownPreviewStart + from, markdownPreviewStart + to, body,
          )}
          editable={props.editorEditable}
          onCaretChange={(row, column) => {
            const line = row + markdownPreviewLineOffset + 1;
            setStatusPosition({ line, column });
            props.onEditorPosition({ path: activeFile, line, column });
          }}
          onSourceCaretChange={(sourceOffset) => {
            if (collabLive && collabSession?.activePath === activeFile) {
              publishCollabCursorV2(collabSession, markdownPreviewStart + sourceOffset);
            }
          }}
          onSelectionMarkdown={(value) => latestRef.current.setSelection(value)}
        />
      </Suspense>
    </ScrollArea>
  );
  const paperPdfActive = Boolean(paperPdf.pdfView);
  const paperPreview = props.activePaper ? (
    <PaperReader
      paper={props.activePaper}
      activeFile={activeFile}
      pdf={paperPdf}
      markdown={markdownPreview}
      onOpenMarkdownPath={props.onOpenMarkdownPath}
      onContextSurfaceActivate={props.onContextSurfaceActivate}
      onTextSelect={props.onPaperTextSelect}
      getFileViewState={props.getFileViewState}
      onFileViewState={props.onFileViewState}
    />
  ) : markdownPreview;
  const editor = (
    <div className="source-workspace" data-tour="document-editor">
      <div className="source-main">
        <div
          className={`source-editor ${
            figureDropActive || props.nativeFigureDropActive ? "figure-drop-active" : ""
          } ${props.fileDropTargetPane === "primary" ? "file-drop-active" : ""}`}
          data-editor-pane="primary"
          onPointerDownCapture={() => props.onContextSurfaceActivate(primarySurface)}
          onPointerLeave={props.onEditorLeave}
          onFocusCapture={() => {
            props.onContextSurfaceActivate(primarySurface);
            claimSelectionToolbar("primary");
            focusedPaneRef.current = "primary";
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
            void insertFigures([path], { x: event.clientX, y: event.clientY }, "primary");
          }}
        >
          <CodeMirror
            key={collabEditorKey}
            className="code-editor-root"
            value={collabLive ? mountSourceRef.current : props.source}
            editable={props.editorEditable}
            extensions={editorExtensions}
            onCreateEditor={(view) => {
              primaryViewRef.current = view;
              primaryViewPathRef.current = activeFile;
              setPrimaryScrollbarView(view);
              if (focusedPaneRef.current === "primary") editorViewRef.current = view;
              lastInsertionPositionRef.current = view.state.selection.main.head;
              reportEditorPositionRef.current(view, activeFile);
              view.dispatch({ effects: setEditorCommentsEffect.of(commentsForActiveFileRef.current) });
            }}
            onChange={onPrimaryChange}
            onUpdate={onPrimaryUpdate}
          />
          <CodeMirrorScrollbar view={primaryScrollbarView} />
          {figureDropMarker && (
            <div className="figure-drop-line" style={{ top: figureDropMarker.top }}>
              <span>{t({ message: `Insert above line ${{ line: figureDropMarker.line }}` })}</span>
            </div>
          )}
          {commentComposer && (
            <CommentComposer
              draft={commentComposer}
              // eslint-disable-next-line react-hooks/refs -- the view the draft was opened in, fixed while it is open
              view={commentComposerViewRef.current}
              anchorKey={`${activeFile}\n${collabEditorKey}`}
              onBodyChange={(body) => setCommentComposer((current) => current ? { ...current, body } : current)}
              onCancel={closeCommentComposer}
              onSave={saveCommentComposer}
            />
          )}
        </div>
        {activeFile.endsWith(".tex") && focusedPane === "primary" && (
          <MathPreview source={focusedSource} cursor={cursorOffset} macros={katexMacros} />
        )}
        <EditorStatusBar
          position={statusPosition}
          onGotoLine={onGotoLineRequest}
          keymap={editorKeymap}
          vimMode={focusedPane === "secondary" && secondaryFile ? vimModes.secondary : vimModes.primary}
          breadcrumb={breadcrumb}
          breadcrumbPath={focusedPath}
          onNavigate={onOutlineNavigate}
          hasDiagnostics={buildDiagnostics.length > 0}
          comments={commentsForActiveFile}
          onOpenComments={onOpenEditorComments}
          todoCount={props.todoCount}
          onOpenTodos={props.onOpenTodos}
          projectWordCount={props.projectWordCount}
          selectedText={selectedText}
          source={focusedSource}
        />
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
      {selectionToolbar && selectedText.trim() && !commentComposer && (
        <LatexSelectionToolbar
          position={selectionToolbar.position}
          canComment={selectionToolbar.pane === "primary"}
          commentOnly={activeFile.toLocaleLowerCase().endsWith(".md") || !props.editorEditable}
          onAction={applySelectionAction}
          onDismiss={dismissSelectionToolbar}
        />
      )}
    </div>
  );
  const projectPdfPreview = (requestedPath: string) => {
    const previewPath = isPreviewableSourceFilePath(requestedPath) ? requestedPath : previewIdentity;
    const leaveEditorForPdf = () => {
      // Scrolling the PDF need not blur CodeMirror. End completion explicitly
      // before saving, or its active-menu guard can suspend autosave indefinitely.
      // Pointer leave alone must still preserve the menu for option selection.
      if (primaryViewRef.current) closeCompletion(primaryViewRef.current);
      if (secondaryViewRef.current) closeCompletion(secondaryViewRef.current);
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
            pdfBase64={props.pdfBase64}
            pdfBytes={props.pdfBytes}
            citations={props.citations}
            canOpenCitation={props.canOpenCitation}
            onOpenCitation={props.onOpenCitation}
            syncTarget={props.pdfSyncTarget}
            canForwardSync={props.canForwardSync}
            locatingPdf={props.locatingPdf}
            onForwardSync={props.onForwardSync}
            // Reverse-jump to source needs an editor to land in. PDF-only view has
            // none, and neither does a dual layout whose panes are both previews
            // (or whose only other pane is an asset); those clicks stay inert and
            // the synctex cursor is off. With one pane still holding an editor the
            // jump goes there — App picks the pane, since it owns that state.
            onSource={props.mode === "pdf" || !props.canRevealPdfSource ? undefined : props.onPdfSource}
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
                onClose={() => onOutlineOpenChange(false)}
                onOpen={() => onOutlineOpenChange(true)}
              />
            )}
          />
        </Suspense>
      </div>
    );
  };
  const preview = props.activeAsset
    ? assetPreview(props.activeAsset)
    : markdownDocument
      ? paperPreview
      : htmlDocument
        ? htmlPreview(activeFile, props.source, props.mode === "split" ? primaryScrollbarView : null)
        : projectPdfPreview(activeFile);
  const twoPane = props.mode === "dual" || props.mode === "columns";
  if (primaryKind && !twoPane) {
    if (primaryKind === "presentation" && props.primaryOpenSlideExternallyRendered) return null;
    return structuredEditor(primaryKind, "primary");
  }
  if (paperPdfActive && !twoPane) return paperPreview;
  if (props.mode === "source") return editor;
  if (props.mode === "pdf") return preview;
  if (twoPane) {
    const focusedClass = (pane: EditorPaneId) => (focusedPane === pane ? "focused" : "");
    /** Focus handler for a pane wrapper; `syncRef` also updates the pane ref before the next render. */
    const focusPane = (pane: EditorPaneId, surface: AgentHostSurface | null, syncRef = true) => () => {
      if (surface) props.onContextSurfaceActivate(surface);
      if (syncRef) focusedPaneRef.current = pane;
      onFocusPane(pane);
    };
    const focusSecondaryPane = () => {
      props.onContextSurfaceActivate("editor");
      claimSelectionToolbar("secondary");
      focusedPaneRef.current = "secondary";
      onFocusPane("secondary");
    };
    const secondaryKind = secondaryFile ? structuredDocumentKind(secondaryFile) : null;
    const focusPaper = focusPane("primary", "paper");
    const paperDualPane = props.activePaper ? (
      <div
        className={`dual-pane dual-primary paper-pane ${focusedClass("primary")}`}
        data-editor-pane="primary"
        data-paper-side={props.paperSide}
        tabIndex={0}
        onPointerDownCapture={focusPaper}
        onFocusCapture={focusPaper}
      >
        {paperPreview}
      </div>
    ) : null;
    const dualSecondary = props.secondaryAsset ? (
      <div
        className={`dual-pane asset-pane ${focusedClass("secondary")}`}
        data-editor-pane="secondary"
        tabIndex={0}
        onPointerDownCapture={focusSecondaryPane}
        onFocus={focusSecondaryPane}
      >
        {assetPreview(props.secondaryAsset)}
      </div>
    ) : secondaryKind ? (
      <div
        className={`dual-pane ${focusedClass("secondary")}`}
        data-editor-pane="secondary"
        tabIndex={0}
        onPointerDownCapture={focusSecondaryPane}
        onFocusCapture={focusSecondaryPane}
      >
        {structuredEditor(secondaryKind, "secondary", focusedPane === "secondary")}
      </div>
    ) : secondaryFile ? (
      <div
        className={`source-main dual-pane ${focusedClass("secondary")}`}
        onPointerDownCapture={() => props.onContextSurfaceActivate("editor")}
        onFocusCapture={() => {
          props.onContextSurfaceActivate("editor");
          claimSelectionToolbar("secondary");
          focusedPaneRef.current = "secondary";
          onFocusPane("secondary");
          if (secondaryViewRef.current) editorViewRef.current = secondaryViewRef.current;
        }}
      >
        <div
          className={`source-editor ${props.fileDropTargetPane === "secondary" ? "file-drop-active" : ""}`}
          data-editor-pane="secondary"
          onPointerLeave={props.onEditorLeave}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) props.onEditorLeave();
          }}
        >
          <CodeMirror
            className="code-editor-root"
            value={secondarySource}
            editable={props.secondaryEditorEditable}
            extensions={secondaryEditorExtensions}
            onCreateEditor={(view) => {
              secondaryViewRef.current = view;
              setSecondaryScrollbarView(view);
              view.dispatch({ effects: setEditorCommentsEffect.of(commentsForSecondaryFileRef.current) });
              if (focusedPane === "secondary") editorViewRef.current = view;
            }}
            onChange={onSecondaryChange}
            onUpdate={onSecondaryUpdate}
          />
          <CodeMirrorScrollbar view={secondaryScrollbarView} />
        </div>
      </div>
    ) : (
      <div
        className={`dual-empty ${focusedClass("secondary")}`}
        data-editor-pane="secondary"
        tabIndex={0}
        aria-label={t`Empty secondary editor`}
        onPointerDownCapture={focusSecondaryPane}
        onFocus={focusSecondaryPane}
      >
        <Columns2 size={18} />
        <p>{t`Open or drag a file here`}</p>
      </div>
    );
    const secondaryPreviewContent = secondaryFile?.toLocaleLowerCase().endsWith(".md") ? (
      <SecondaryMarkdownPreview
        key={secondaryFile}
        path={secondaryFile}
        projectRoot={props.projectRoot}
        source={secondarySource}
        onChange={onSecondaryChange}
        onFlushPendingChange={registerSecondaryVisualMarkdownFlush}
        onEditSource={props.onViewMarkdownSource}
        onOpenProjectPath={props.onOpenMarkdownPath}
        workspaceIndex={props.workspaceIndex}
        papers={props.papers}
        macros={katexMacros}
        onImportAsset={props.onImportAsset}
        onLoadAsset={props.onLoadReferenceImage}
        assetRevision={props.referenceImageGeneration ?? 0}
        editable={props.secondaryEditorEditable}
        onSelectionMarkdown={(value) => latestRef.current.setSelection(value)}
        editorComments={commentsForSecondaryFile}
        activeEditorCommentId={props.activeEditorCommentId}
        onEditorCommentClick={props.onReplyEditorComment}
        onCreateComment={(from, to, body) => createPreviewComment(secondaryFile, secondarySource, from, to, body)}
        onCaretChange={(row, column) => {
          const line = row + 1;
          setStatusPosition({ line, column });
          props.onEditorPosition({ path: secondaryFile, line, column });
        }}
      />
    ) : secondaryFile && isHtmlFilePath(secondaryFile)
      ? htmlPreview(secondaryFile, secondarySource)
      : projectPdfPreview(secondaryFile ?? activeFile);
    const dualSecondaryPreview = (
      <div
        className={`dual-pane-preview dual-pane ${focusedClass("secondary")}`}
        data-editor-pane="secondary"
        tabIndex={0}
        onPointerDownCapture={focusSecondaryPane}
        onFocusCapture={focusSecondaryPane}
        onPointerLeave={props.onEditorLeave}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) props.onEditorLeave();
        }}
      >
        {secondaryPreviewContent}
      </div>
    );
    const focusPrimaryAsset = focusPane("primary", "editor", false);
    const focusPrimaryStructured = focusPane("primary", "editor");
    const primaryPane = props.activeAsset ? (
      <div
        className={`dual-primary asset-pane ${focusedClass("primary")}`}
        data-editor-pane="primary"
        tabIndex={0}
        onPointerDownCapture={focusPrimaryAsset}
        onFocus={focusPrimaryAsset}
      >
        {assetPreview(props.activeAsset)}
      </div>
    ) : primaryKind ? (
      <div
        className={`dual-primary ${focusedClass("primary")}`}
        data-editor-pane="primary"
        tabIndex={0}
        onPointerDownCapture={focusPrimaryStructured}
        onFocusCapture={focusPrimaryStructured}
      >
        {structuredEditor(primaryKind, "primary", focusedPane === "primary")}
      </div>
    ) : (
      <div
        className={`dual-primary ${focusedClass("primary")}`}
        onPointerDownCapture={() => props.onContextSurfaceActivate("editor")}
        onFocusCapture={() => {
          props.onContextSurfaceActivate("editor");
          onFocusPane("primary");
          if (primaryViewRef.current) editorViewRef.current = primaryViewRef.current;
        }}
      >
        {editor}
      </div>
    );
    const focusPrimaryPreview = focusPane("primary", null);
    const dualPrimaryPreview = (
      <div
        className={`dual-pane-preview dual-primary ${focusedClass("primary")}`}
        data-editor-pane="primary"
        tabIndex={0}
        onPointerDownCapture={focusPrimaryPreview}
        onFocusCapture={focusPrimaryPreview}
      >
        {preview}
      </div>
    );
    const visiblePrimaryPane = paperDualPane
      ?? (props.dualPreviewPanes?.primary ? dualPrimaryPreview : primaryPane);
    const visibleSecondaryPane = props.dualPreviewPanes?.secondary ? dualSecondaryPreview : dualSecondary;
    const paperOnRight = Boolean(paperDualPane) && props.paperSide === "right";
    const leftPane = paperOnRight ? visibleSecondaryPane : visiblePrimaryPane;
    const rightPane = paperOnRight ? visiblePrimaryPane : visibleSecondaryPane;
    const editorResizer = (
      <div
        className="split-resizer"
        role="separator"
        aria-label={t`Resize dual source panes`}
        aria-orientation="vertical"
        tabIndex={0}
        onPointerDown={beginDualResize}
      />
    );
    if (props.mode === "columns") {
      const editorsShare = 1 - columnsPdfRatio;
      return (
        <div
          ref={splitRef}
          className="split-canvas dual-canvas columns-canvas"
          style={{
            gridTemplateColumns: `minmax(160px, ${splitRatio * editorsShare}fr) 1px minmax(160px, ${(1 - splitRatio) * editorsShare}fr) 1px minmax(${SPLIT_PDF_MIN_WIDTH}px, ${columnsPdfRatio}fr)`,
          }}
        >
          {leftPane}
          {editorResizer}
          {rightPane}
          <div
            className="split-resizer"
            role="separator"
            aria-label={t`Resize PDF pane`}
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
        {leftPane}
        {editorResizer}
        {rightPane}
      </div>
    );
  }
  return (
    <div
      ref={splitRef}
      className="split-canvas"
      data-tour="split-workspace"
      data-minimum-workspace-width={SPLIT_SOURCE_MIN_WIDTH + SPLIT_PDF_MIN_WIDTH + 1}
      style={{
        gridTemplateColumns: `clamp(${SPLIT_SOURCE_MIN_WIDTH}px, calc(${splitRatio * 100}% - ${splitRatio}px), calc(100% - ${SPLIT_PDF_MIN_WIDTH + 1}px)) 1px minmax(${SPLIT_PDF_MIN_WIDTH}px, 1fr)`,
      }}
    >
      {editor}
      <div
        className="split-resizer"
        role="separator"
        aria-label={props.activeAsset
          ? t`Resize editor and asset preview`
          : markdownDocument
            ? t`Resize editor and Markdown preview`
            : htmlDocument
              ? t`Resize editor and HTML preview`
              : t`Resize editor and PDF preview`}
        aria-orientation="vertical"
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(splitRatio * 100)}
        tabIndex={0}
        onPointerDown={beginSplitResize}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          nudgeSplit(event.key === "ArrowLeft" ? -0.03 : 0.03);
        }}
      />
      {preview}
    </div>
  );
}
