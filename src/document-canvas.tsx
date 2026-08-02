import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { forceLinting as refreshLint, linter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { emacs } from "@replit/codemirror-emacs";
import { getCM, vim } from "@replit/codemirror-vim";
import { latex } from "codemirror-lang-latex";
import {
  overleafCursorsExtension,
  setOverleafCursorsEffect,
  type PresenceCursor,
} from "./overleaf-cursors";
import {
  overleafTrackChangesExtension,
  type TrackedChangeTooltipActions,
} from "./overleaf-track-changes";
import type { TrackedChange } from "./use-overleaf-realtime";
import {
  Columns2,
  FileCode2,
  FileText,
  Image,
  ListTodo,
  MessageSquareText,
} from "lucide-react";
import {
  countWords,
  latexEditorExtensions,
  latexLanguageOptions,
  renameEnvironmentAt,
  textStats,
  wrapRange,
  wrapEnvironment,
  type CitationInfo,
  type DefinitionTarget,
  type ReferenceInfo,
  type SymbolTarget,
} from "./latex-editor";
import { harperDictionaryChanged } from "./harper-spellcheck";
import {
  LatexSelectionToolbar,
  type LatexSelectionAction,
  type LatexSelectionToolbarPosition,
} from "./latex-selection-toolbar";
import { ScrollArea } from "./components/ui/scroll-area";
import { Textarea } from "./components/ui/textarea";
import {
  latexFigureInsertion,
  markdownAssetInsertion,
  type FigureInsertOptions,
} from "./figure-insertion";
import { FigureInsertDialog } from "./figure-insert-dialog";
import {
  createEditorComment,
  editorCommentsExtension,
  resolveCommentRange,
  setEditorCommentsEffect,
  type EditorComment,
} from "./editor-comments";
import {
  clamp,
  loadSplitRatio,
  persistSplitRatio,
  loadColumnsPdfRatio,
  persistColumnsPdfRatio,
} from "./app-settings";
import {
  editorDiagnosticsForFile,
  type CompileDiagnostic,
} from "./compile-diagnostics";
import { editorTexlabDiagnosticsForFile } from "./texlab-diagnostics";
import { DocumentOutline } from "./document-outline";
import {
  sectionBreadcrumbNodes,
  type OutlineNode,
} from "./latex-outline";
import { InsertPalette } from "./insert-palette";
import type { InsertSnippet } from "./insert-snippets";
import { expandSnippetPlaceholders, nextSnippetStop, previousSnippetStop } from "./snippet-placeholders";
import { MathPreview } from "./math-preview";
import { ChatMarkdown } from "./chat-markdown";
import { TableGeneratorDialog } from "./table-generator-dialog";
import { PdfPreview, type PdfSyncTarget } from "./pdf-viewer";
import type {
  WordCount,
  EditorViewState,
  AssetPreview,
  FigureDropRequest,
  EditorNavigation,
  EditorPosition,
  PaperSummary,
  CanvasMode,
  EditorPaneId,
  InsertSymbolCommand,
  EditorKeymap,
} from "./app-types";
import { PROJECT_FIGURE_DRAG_TYPE } from "./app-utils";
import type { AgentHostSurface } from "./agent-host-context";

const SPLIT_SOURCE_MIN_WIDTH = 480;
const SPLIT_PDF_MIN_WIDTH = 500;
const EDITOR_BASIC_SETUP = {
  autocompletion: false,
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
  highlightActiveLineGutter: true,
};

function readVimMode(cm: ReturnType<typeof getCM>): string {
  const state = cm?.state.vim;
  if (state?.insertMode) return "insert";
  return state?.mode ?? "normal";
}

function vimModeExtension(onModeChange: (mode: string) => void): Extension {
  return ViewPlugin.fromClass(class {
    private readonly cm: ReturnType<typeof getCM>;
    private readonly handleModeChange = () => onModeChange(readVimMode(this.cm));

    constructor(view: EditorView) {
      this.cm = getCM(view);
      this.cm?.on("vim-mode-change", this.handleModeChange);
      this.handleModeChange();
    }

    destroy() {
      this.cm?.off("vim-mode-change", this.handleModeChange);
    }
  });
}

export function DocumentCanvas(props: {
  mode: CanvasMode;
  source: string;
  markdownPreviewSource?: string;
  activeFile: string;
  secondaryFile: string | null;
  secondarySource: string;
  setSecondarySource: (value: string) => void;
  focusedPane: EditorPaneId;
  onFocusPane: (pane: EditorPaneId) => void;
  setSource: (value: string) => void;
  setSelection: (value: string) => void;
  onPdfTextSelect: (value: string) => void;
  onPaperTextSelect: (value: string) => void;
  onContextSurfaceActivate: (surface: AgentHostSurface) => void;
  pdfUrl: string | null;
  pdfBase64: string | null;
  pdfTop?: ReactNode;
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
  fileDropTargetPane: EditorPaneId | null;
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
  collabExtensions: Extension[];
  collabEditorKey: string;
  onOpenCitation: (key: string) => void;
  canOpenCitation: (key: string) => boolean;
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
  const primarySurface: AgentHostSurface = props.activePaper ? "paper" : "editor";
  const splitRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const primaryViewRef = useRef<EditorView | null>(null);
  const secondaryViewRef = useRef<EditorView | null>(null);
  const [primaryScrollbarView, setPrimaryScrollbarView] = useState<EditorView | null>(null);
  const [secondaryScrollbarView, setSecondaryScrollbarView] = useState<EditorView | null>(null);
  const lastInsertionPositionRef = useRef(0);
  const pendingFigureCursorRef = useRef<{ pane: EditorPaneId; cursor: number } | null>(null);
  const [splitRatio, setSplitRatio] = useState(loadSplitRatio);
  const [columnsPdfRatio, setColumnsPdfRatio] = useState(loadColumnsPdfRatio);
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
  const [commentComposer, setCommentComposer] = useState<{
    from: number;
    to: number;
    quote: string;
    body: string;
  } | null>(null);

  const constrainSplitRatio = useCallback((ratio: number) => {
    const width = splitRef.current?.getBoundingClientRect().width ?? 0;
    if (!width) return clamp(ratio, 0.2, 0.8);
    const tracksWidth = Math.max(1, width - 1);
    const minimum = Math.min(1, SPLIT_SOURCE_MIN_WIDTH / tracksWidth);
    const maximum = Math.max(minimum, 1 - SPLIT_PDF_MIN_WIDTH / tracksWidth);
    return clamp(ratio, minimum, maximum);
  }, []);

  useEffect(() => {
    const split = splitRef.current;
    if (!split || props.mode !== "split" || typeof ResizeObserver === "undefined") return;
    const fitRatio = () => {
      setSplitRatio((current) => {
        const next = constrainSplitRatio(current);
        if (next !== current) persistSplitRatio(next);
        return next;
      });
    };
    const observer = new ResizeObserver(fitRatio);
    observer.observe(split);
    fitRatio();
    return () => observer.disconnect();
  }, [constrainSplitRatio, props.mode]);
  const focusedPath = focusedPane === "secondary" && secondaryFile ? secondaryFile : activeFile;
  const focusedSource = focusedPane === "secondary" && secondaryFile ? secondarySource : editorSource;
  const wordCount = useMemo(() => countWords(focusedSource), [focusedSource]);
  const [selectedText, setSelectedText] = useState("");
  const [selectionToolbarPosition, setSelectionToolbarPosition] = useState<LatexSelectionToolbarPosition | null>(null);
  const [selectionToolbarPane, setSelectionToolbarPane] = useState<EditorPaneId | null>(null);
  const selectionStats = useMemo(() => textStats(selectedText), [selectedText]);
  const commentsForActiveFile = useMemo(
    () => editorComments.filter((comment) => comment.path === activeFile),
    [activeFile, editorComments],
  );
  const commentsForActiveFileRef = useRef(commentsForActiveFile);
  commentsForActiveFileRef.current = commentsForActiveFile;
  // Read through a ref for the same reason the comments are: the extension is
  // built once and must not be rebuilt every time someone else moves.
  const overleafPresenceCursorsRef = useRef(props.overleafPresenceCursors);
  overleafPresenceCursorsRef.current = props.overleafPresenceCursors;
  const overleafChangesRef = useRef(props.overleafChanges);
  overleafChangesRef.current = props.overleafChanges;
  const overleafTrackChangeActionsRef = useRef(props.overleafTrackChangeActions);
  overleafTrackChangeActionsRef.current = props.overleafTrackChangeActions;
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
    onOpenCitation: props.onOpenCitation,
    canOpenCitation: props.canOpenCitation,
    spellingWords: props.spellingWords,
    onAddSpellingWord: props.onAddSpellingWord,
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
    onOpenCitation: props.onOpenCitation,
    canOpenCitation: props.canOpenCitation,
    spellingWords: props.spellingWords,
    onAddSpellingWord: props.onAddSpellingWord,
  };

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
  const updateSelectionToolbarRef = useRef<(view: EditorView, path: string) => void>(() => {});
  const selectionToolbarOwnerRef = useRef<{
    pane: EditorPaneId;
    path: string;
    from: number;
    to: number;
  } | null>(null);
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
    updateSelectionToolbarRef.current(viewUpdate.view, activeFileRefEditor.current);
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
    if (path) {
      updateSelectionToolbarRef.current(viewUpdate.view, path);
      reportEditorPositionRef.current?.(viewUpdate.view, path);
    }
  }, []);

  const updateSelectionToolbar = useCallback((view: EditorView, path: string) => {
    const range = view.state.selection.main;
    if (range.empty || !path.endsWith(".tex")) {
      selectionToolbarOwnerRef.current = null;
      setSelectionToolbarPane(null);
      setSelectionToolbarPosition(null);
      return;
    }
    const editorBounds = view.dom.closest(".source-editor")?.getBoundingClientRect();
    const visibleRange = view.visibleRanges.find(({ from, to }) => range.from <= to && range.to >= from);
    if (!visibleRange) {
      selectionToolbarOwnerRef.current = null;
      setSelectionToolbarPane(null);
      setSelectionToolbarPosition(null);
      return;
    }
    const visibleFrom = Math.max(range.from, visibleRange.from);
    const line = view.state.doc.lineAt(visibleFrom);
    const visibleTo = Math.min(range.to, visibleRange.to, line.to);
    const start = view.coordsAtPos(visibleFrom);
    const end = view.coordsAtPos(visibleTo);
    if (!editorBounds || !start || !end) {
      selectionToolbarOwnerRef.current = null;
      setSelectionToolbarPane(null);
      setSelectionToolbarPosition(null);
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
    selectionToolbarOwnerRef.current = {
      pane: view === secondaryViewRef.current ? "secondary" : "primary",
      path,
      from: range.from,
      to: range.to,
    };
    setSelectionToolbarPane(view === secondaryViewRef.current ? "secondary" : "primary");
    setSelectionToolbarPosition({
      left,
      top: below ? start.bottom + 8 : selectionTop - 8,
      below,
      maxWidth: Math.max(0, editorBounds.width - 16),
    });
  }, []);
  updateSelectionToolbarRef.current = updateSelectionToolbar;

  useEffect(() => {
    const reposition = () => {
      const owner = selectionToolbarOwnerRef.current;
      if (!owner) return;
      const view = owner.pane === "secondary" ? secondaryViewRef.current : primaryViewRef.current;
      if (view) updateSelectionToolbar(view, owner.path);
    };
    const resizeObserver = new ResizeObserver(reposition);
    for (const view of [primaryViewRef.current, secondaryViewRef.current]) {
      const editor = view?.dom.closest(".source-editor");
      if (editor) resizeObserver.observe(editor);
    }
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [activeFile, focusedPane, secondaryFile, updateSelectionToolbar]);

  useEffect(() => {
    if (props.mode === "pdf" || props.mode === "paper" || props.mode === "asset" || props.mode === "markdown-preview") {
      selectionToolbarOwnerRef.current = null;
      setSelectionToolbarPane(null);
      setSelectionToolbarPosition(null);
    }
  }, [props.mode]);

  useEffect(() => {
    selectionToolbarOwnerRef.current = null;
    setSelectionToolbarPane(null);
    setSelectionToolbarPosition(null);
  }, [activeFile, secondaryFile]);

  useEffect(() => {
    const view = primaryViewRef.current;
    if (!view) return;
    view.dispatch({ effects: setEditorCommentsEffect.of(commentsForActiveFile) });
  }, [commentsForActiveFile, collabEditorKey]);

  // Someone else's caret has to repaint when they move it, not when we
  // happen to type next.
  useEffect(() => {
    const view = primaryViewRef.current;
    if (!view) return;
    view.dispatch({ effects: setOverleafCursorsEffect.of(props.overleafPresenceCursors) });
  }, [props.overleafPresenceCursors, collabEditorKey]);

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

  const openCommentComposer = useCallback((targetView?: EditorView) => {
    const view = targetView ?? editorViewRef.current;
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

  const applySelectionAction = useCallback((action: LatexSelectionAction, value?: string) => {
    const owner = selectionToolbarOwnerRef.current;
    if (!owner) return;
    const view = owner.pane === "secondary" ? secondaryViewRef.current : primaryViewRef.current;
    if (!view || owner.path !== (owner.pane === "secondary" ? secondaryFileRefEditor.current : activeFileRefEditor.current)) return;
    const range = view.state.selection.main;
    if (range.empty || range.from !== owner.from || range.to !== owner.to) {
      selectionToolbarOwnerRef.current = null;
      setSelectionToolbarPane(null);
      setSelectionToolbarPosition(null);
      return;
    }
    if (action === "comment") {
      if (owner.pane !== "primary") return;
      openCommentComposer(view);
      selectionToolbarOwnerRef.current = null;
      setSelectionToolbarPane(null);
      setSelectionToolbarPosition(null);
      return;
    }
    let before = "";
    let after = "";
    switch (action) {
      case "bold": [before, after] = ["\\textbf{", "}"]; break;
      case "italic": [before, after] = ["\\textit{", "}"]; break;
      case "underline": [before, after] = ["\\underline{", "}"]; break;
      case "strikethrough": [before, after] = ["\\sout{", "}"]; break;
      case "highlight": {
        const color = value?.trim() || "yellow";
        const hex = color.match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
        [before, after] = hex
          ? [`\\colorbox[HTML]{${hex[1].toUpperCase()}}{`, "}"]
          : [`\\colorbox{${color}}{`, "}"];
        break;
      }
      case "heading": [before, after] = [`\\${value || "section"}{`, "}"]; break;
      case "quote": [before, after] = ["\\begin{quote}\n", "\n\\end{quote}"]; break;
      case "link": {
        const url = value?.trim();
        if (!url) return;
        const safeUrl = url
          .replace(/\\/g, "%5C")
          .replace(/\{/g, "%7B")
          .replace(/\}/g, "%7D");
        [before, after] = [`\\href{${safeUrl}}{`, "}"];
        break;
      }
    }
    const edit = wrapRange(view.state.doc.toString(), range.from, range.to, before, after);
    view.dispatch({
      changes: { from: edit.from, to: edit.to, insert: edit.insert },
      selection: { anchor: edit.cursorFrom, head: edit.cursorTo },
      scrollIntoView: true,
    });
    view.focus();
    updateSelectionToolbar(view, owner.path);
  }, [openCommentComposer, updateSelectionToolbar]);

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
  const reportVimMode = useCallback((pane: EditorPaneId, mode: string) => {
    setVimModes((current) => current[pane] === mode ? current : { ...current, [pane]: mode });
  }, []);
  const reportPrimaryVimMode = useCallback((mode: string) => reportVimMode("primary", mode), [reportVimMode]);
  const reportSecondaryVimMode = useCallback((mode: string) => reportVimMode("secondary", mode), [reportVimMode]);
  const focusedVimMode = focusedPane === "secondary" && secondaryFile
    ? vimModes.secondary
    : vimModes.primary;
  reportEditorPositionRef.current = reportEditorPosition;
  const editorExtensions = useMemo(
    () => [
      ...(editorKeymap === "vim" ? [vim({ status: false }), vimModeExtension(reportPrimaryVimMode)] : editorKeymap === "emacs" ? [emacs()] : []),
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
      overleafCursorsExtension({ getCursors: () => overleafPresenceCursorsRef.current }),
      overleafTrackChangesExtension({
        getChanges: () => overleafChangesRef.current,
        authorName: (userId) => overleafTrackChangeActionsRef.current.authorName(userId),
        canAct: () => overleafTrackChangeActionsRef.current.canAct(),
        onAccept: (change) => overleafTrackChangeActionsRef.current.onAccept(change),
        onReject: (change) => overleafTrackChangeActionsRef.current.onReject(change),
      }),
      editorCommentsExtension(activeFile, {
        getComments: () => commentsForActiveFileRef.current,
        currentAuthorId: commentAuthorId,
        onResolve: (id) => resolveEditorCommentRef.current(id),
        onReply: (comment) => replyEditorCommentRef.current(comment.id),
      }),
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
    [activeFile, collabExtensions, editorKeymap, editorSpellcheck, reportPrimaryVimMode],
  );
  const secondaryEditorExtensions = useMemo(
    () => {
      if (!secondaryFile) return [];
      return [
        ...(editorKeymap === "vim" ? [vim({ status: false }), vimModeExtension(reportSecondaryVimMode)] : editorKeymap === "emacs" ? [emacs()] : []),
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
          latexLiveRef,
        ),
        linter((view) => editorDiagnosticsForFile(diagnosticsRef.current.build, secondaryFile, view.state.doc), {
          delay: 150,
        }),
        linter((view) => editorTexlabDiagnosticsForFile(diagnosticsRef.current.texlab, secondaryFile, view.state.doc), {
          delay: 200,
        }),
      ];
    },
    [editorKeymap, editorSpellcheck, graphicsRoots, localMacros, onCreateMissingFile, onFindReferences, onGotoDefinition, onPasteImageFile, onRenameEnvironment, onRenameSymbol, onTexlabGoto, onWrapEnvironment, projectPaths, props.citationKeys, props.citations, props.onLoadReferenceImage, props.references, props.unusedCitations, props.unusedLabels, reportSecondaryVimMode, secondaryFile],
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
  }, [
    editorSource,
    figureInsertPending,
    secondarySource,
    setFigureInsertPending,
    setSecondarySource,
    setSource,
  ]);
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
      // Center the target line so a jump lands in the middle of the viewport,
      // not pinned to the top (jumping down) or bottom (jumping up).
      currentView.dispatch({
        selection: { anchor: line.from },
        effects: EditorView.scrollIntoView(line.from, { y: "center" }),
      });
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
    void insertFigures(
      request.paths,
      { x: request.clientX, y: request.clientY },
      request.pane,
    )
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
  if (props.mode === "asset" && props.activeAsset) {
    return <ProjectAssetPreview asset={props.activeAsset} />;
  }
  if (props.mode === "paper" || props.mode === "markdown-preview") {
    return (
      <ScrollArea
        className="markdown-preview"
        orientation="both"
        contentClassName="markdown-preview-content"
        onPointerDownCapture={() => props.onContextSurfaceActivate(primarySurface)}
        onFocusCapture={() => props.onContextSurfaceActivate(primarySurface)}
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
        <ChatMarkdown
          text={props.markdownPreviewSource ?? props.source}
          macros={props.katexMacros}
          breaks={false}
        />
      </ScrollArea>
    );
  }
  const showTexChrome = activeFile.endsWith(".tex");
  const editor = (
    <div className="source-workspace">
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
            if (selectionToolbarOwnerRef.current?.pane !== "primary") {
              selectionToolbarOwnerRef.current = null;
              setSelectionToolbarPane(null);
              setSelectionToolbarPosition(null);
            }
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
            height="100%"
            extensions={editorExtensions}
            onCreateEditor={(view) => {
              primaryViewRef.current = view;
              setPrimaryScrollbarView(view);
              if (focusedPaneRef.current === "primary") editorViewRef.current = view;
              lastInsertionPositionRef.current = view.state.selection.main.head;
              reportEditorPositionRef.current(view, activeFile);
              view.dispatch({ effects: setEditorCommentsEffect.of(commentsForActiveFileRef.current) });
            }}
            onChange={onPrimaryChange}
            onUpdate={onPrimaryUpdate}
            basicSetup={EDITOR_BASIC_SETUP}
          />
          <CodeMirrorScrollbar view={primaryScrollbarView} />
          {figureDropMarker && (
            <div className="figure-drop-line" style={{ top: figureDropMarker.top }}>
              <span>Insert above line {figureDropMarker.line}</span>
            </div>
          )}
          {commentComposer && (
            <div
              className="editor-comment-popover"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <p className="editor-comment-quote">{commentComposer.quote}</p>
              <Textarea
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
          {editorKeymap === "vim" && (
            <span className="status-vim-mode" aria-live="polite" title="Vim mode">
              --{focusedVimMode.toUpperCase()}--
            </span>
          )}
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
      {selectionToolbarPosition && selectedText.trim() && !commentComposer && (
        <LatexSelectionToolbar
          position={selectionToolbarPosition}
          canComment={selectionToolbarPane === "primary"}
          onAction={applySelectionAction}
        />
      )}
    </div>
  );
  const preview = (
    <div
      className="pdf-column"
      onPointerDownCapture={() => props.onContextSurfaceActivate("pdf")}
      onFocusCapture={() => props.onContextSurfaceActivate("pdf")}
    >
      {props.pdfTop}
      <PdfPreview
        url={props.pdfUrl}
        pdfBase64={props.pdfBase64}
        syncTarget={props.pdfSyncTarget}
        canForwardSync={props.canForwardSync}
        locatingPdf={props.locatingPdf}
        onForwardSync={props.onForwardSync}
        // Reverse-jump to source only when the editor is visible (split/dual/
        // columns). In PDF-only view there's nothing to jump to, so clicks stay
        // inert and the synctex cursor is off.
        onSource={props.mode === "pdf" ? undefined : props.onPdfSource}
        onTextSelect={props.onPdfTextSelect}
        onNumPages={props.onPdfPageCount}
        onPageChange={props.onPdfPageChange}
        outline={(
          <DocumentOutline
            nodes={outlineNodes}
            activeId={activeOutlineId}
            available={showTexChrome}
            open={outlineOpen}
            onSelect={onOutlineNavigate}
            onClose={() => onOutlineOpenChange(false)}
            onOpen={() => onOutlineOpenChange(true)}
          />
        )}
      />
    </div>
  );
  if (props.mode === "source") return editor;
  if (props.mode === "pdf") return preview;
  if (props.mode === "dual" || props.mode === "columns") {
    const dualSecondary = secondaryFile ? (
      <div
        className={`source-main dual-pane ${focusedPane === "secondary" ? "focused" : ""}`}
        onPointerDownCapture={() => props.onContextSurfaceActivate("editor")}
        onFocusCapture={() => {
          props.onContextSurfaceActivate("editor");
          if (selectionToolbarOwnerRef.current?.pane !== "secondary") {
            selectionToolbarOwnerRef.current = null;
            setSelectionToolbarPane(null);
            setSelectionToolbarPosition(null);
          }
          focusedPaneRef.current = "secondary";
          onFocusPane("secondary");
          if (secondaryViewRef.current) editorViewRef.current = secondaryViewRef.current;
        }}
      >
        <div className="dual-pane-label"><FileCode2 size={12} /><span>{secondaryFile}</span></div>
        <div
          className={`source-editor ${props.fileDropTargetPane === "secondary" ? "file-drop-active" : ""}`}
          data-editor-pane="secondary"
        >
          <CodeMirror
            className="code-editor-root"
            value={secondarySource}
            height="100%"
            extensions={secondaryEditorExtensions}
            onCreateEditor={(view) => {
              secondaryViewRef.current = view;
              setSecondaryScrollbarView(view);
              if (focusedPane === "secondary") editorViewRef.current = view;
            }}
            onChange={onSecondaryChange}
            onUpdate={onSecondaryUpdate}
            basicSetup={EDITOR_BASIC_SETUP}
          />
          <CodeMirrorScrollbar view={secondaryScrollbarView} />
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
            gridTemplateColumns: `minmax(160px, ${splitRatio * editorsShare}fr) 1px minmax(160px, ${(1 - splitRatio) * editorsShare}fr) 1px minmax(${SPLIT_PDF_MIN_WIDTH}px, ${columnsPdfRatio}fr)`,
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
    const split = splitRef.current;
    const bounds = split?.getBoundingClientRect();
    if (!split || !bounds?.width) return splitRatio;
    const tracksWidth = Math.max(1, bounds.width - 1);
    const minimum = Math.min(Math.ceil(tracksWidth), SPLIT_SOURCE_MIN_WIDTH);
    const maximum = Math.max(minimum, Math.floor(tracksWidth - SPLIT_PDF_MIN_WIDTH));
    const sourceWidth = clamp(Math.round(clientX - bounds.left), minimum, maximum);
    const next = constrainSplitRatio(sourceWidth / tracksWidth);

    // Keep the hot drag path outside React. Re-rendering the PDF viewer for
    // every pointer event made WebKit repeatedly lay out and repaint the
    // toolbar, which showed up as tiny icon shifts. The committed ratio is
    // still sent through React on pointer-up.
    split.style.gridTemplateColumns =
      `${sourceWidth}px 1px minmax(${SPLIT_PDF_MIN_WIDTH}px, 1fr)`;
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
      setSplitRatio(latest);
      persistSplitRatio(latest);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
  };
  const nudgeSplit = (delta: number) => {
    const next = constrainSplitRatio(splitRatio + delta);
    setSplitRatio(next);
    persistSplitRatio(next);
  };
  return (
    <div
      ref={splitRef}
      className="split-canvas"
      data-minimum-workspace-width={SPLIT_SOURCE_MIN_WIDTH + SPLIT_PDF_MIN_WIDTH + 1}
      style={{
        gridTemplateColumns: `clamp(${SPLIT_SOURCE_MIN_WIDTH}px, calc(${splitRatio * 100}% - ${splitRatio}px), calc(100% - ${SPLIT_PDF_MIN_WIDTH + 1}px)) 1px minmax(${SPLIT_PDF_MIN_WIDTH}px, 1fr)`,
      }}
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

function CodeMirrorScrollbar({ view }: { view: EditorView | null }) {
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const scrollingTimerRef = useRef<number | null>(null);
  const dragRef = useRef<{ pointerY: number; scrollTop: number } | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [scrolling, setScrolling] = useState(false);

  const updateThumb = useCallback(() => {
    const scroller = view?.scrollDOM;
    const thumb = thumbRef.current;
    if (!scroller || !thumb) return;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    const overflow = maxScroll > 1;
    setHasOverflow((current) => current === overflow ? current : overflow);
    if (!overflow) return;

    const trackHeight = Math.max(0, scroller.clientHeight - 8);
    const thumbHeight = Math.max(24, trackHeight * (scroller.clientHeight / scroller.scrollHeight));
    const travel = Math.max(0, trackHeight - thumbHeight);
    const top = 4 + travel * (scroller.scrollTop / maxScroll);
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${top}px)`;
  }, [view]);

  useEffect(() => {
    const scroller = view?.scrollDOM;
    if (!scroller) return;
    const handleScroll = () => {
      updateThumb();
      setScrolling(true);
      if (scrollingTimerRef.current) window.clearTimeout(scrollingTimerRef.current);
      scrollingTimerRef.current = window.setTimeout(() => setScrolling(false), 180);
    };
    const resizeObserver = new ResizeObserver(updateThumb);
    resizeObserver.observe(scroller);
    resizeObserver.observe(view.contentDOM);
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    updateThumb();
    return () => {
      resizeObserver.disconnect();
      scroller.removeEventListener("scroll", handleScroll);
      if (scrollingTimerRef.current) window.clearTimeout(scrollingTimerRef.current);
    };
  }, [updateThumb, view]);

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setScrolling(false);
  };

  return (
    <div
      className="cm-overlay-scrollbar"
      data-overflow={hasOverflow || undefined}
      data-scrolling={scrolling || undefined}
      aria-hidden="true"
      onPointerDown={(event) => {
        const scroller = view?.scrollDOM;
        if (!scroller || !hasOverflow) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        setScrolling(true);
        if ((event.target as HTMLElement).closest(".cm-overlay-scrollbar-thumb")) {
          dragRef.current = { pointerY: event.clientY, scrollTop: scroller.scrollTop };
          return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
        scroller.scrollTop = ratio * (scroller.scrollHeight - scroller.clientHeight);
      }}
      onPointerMove={(event) => {
        const scroller = view?.scrollDOM;
        const drag = dragRef.current;
        if (!scroller || !drag) return;
        const trackHeight = Math.max(0, scroller.clientHeight - 8);
        const thumbHeight = Math.max(24, trackHeight * (scroller.clientHeight / scroller.scrollHeight));
        const travel = Math.max(1, trackHeight - thumbHeight);
        const maxScroll = scroller.scrollHeight - scroller.clientHeight;
        scroller.scrollTop = drag.scrollTop + (event.clientY - drag.pointerY) * (maxScroll / travel);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div ref={thumbRef} className="cm-overlay-scrollbar-thumb" />
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
        <small>Drop project files here to open them, or drag this into a TeX or Markdown editor to insert it.</small>
      </div>
      <ScrollArea
        className="asset-preview-stage"
        orientation="both"
        contentClassName="asset-preview-stage-content"
      >
        {asset.mimeType.startsWith("image/")
          ? <img src={url} alt={`Preview of ${asset.path}`} />
          : <div className="asset-preview-unsupported"><FileText size={28} /><p>This format cannot be rendered in the preview.</p></div>}
      </ScrollArea>
    </div>
  );
}
