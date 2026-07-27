import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { forceLinting as refreshLint, linter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { emacs } from "@replit/codemirror-emacs";
import { vim } from "@replit/codemirror-vim";
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
  BookOpen,
  Columns2,
  FileCode2,
  FileText,
  FoldHorizontal,
  Image,
  ListTodo,
  MessageSquareText,
  UnfoldHorizontal,
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
import {
  LatexSelectionToolbar,
  type LatexSelectionAction,
  type LatexSelectionToolbarPosition,
} from "./latex-selection-toolbar";
import { latexFigureInsertion, type FigureInsertOptions } from "./figure-insertion";
import { FigureInsertDialog } from "./figure-insert-dialog";
import {
  createEditorComment,
  editorCommentsExtension,
  resolveCommentRange,
  setEditorCommentsEffect,
  type EditorComment,
} from "./editor-comments";
import {
  type PaperReadingWidth,
  PAPER_READING_WIDTH_KEY,
  clamp,
  loadSplitRatio,
  persistSplitRatio,
  loadColumnsPdfRatio,
  persistColumnsPdfRatio,
  loadPaperReadingWidth,
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
import { Tip } from "./components/icon-tip";
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
import {
  stripFrontmatter,
  PROJECT_FIGURE_DRAG_TYPE,
} from "./app-utils";

export function DocumentCanvas(props: {
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
  pdfTop?: ReactNode;
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
  };

  const diagnosticsRef = useRef({ build: buildDiagnostics, texlab: texlabDiagnostics });
  diagnosticsRef.current = { build: buildDiagnostics, texlab: texlabDiagnostics };

  useEffect(() => {
    for (const view of [primaryViewRef.current, secondaryViewRef.current]) {
      if (view) refreshLint(view);
    }
  }, [buildDiagnostics, texlabDiagnostics]);

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
      case "highlight": [before, after] = [`\\colorbox{${value || "yellow"}}{`, "}"]; break;
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
        linter((view) => editorDiagnosticsForFile(diagnosticsRef.current.build, secondaryFile, view.state.doc), {
          delay: 150,
        }),
        linter((view) => editorTexlabDiagnosticsForFile(diagnosticsRef.current.texlab, secondaryFile, view.state.doc), {
          delay: 200,
        }),
      ];
    },
    [editorKeymap, editorSpellcheck, graphicsRoots, localMacros, onCreateMissingFile, onFindReferences, onGotoDefinition, onPasteImageFile, onRenameEnvironment, onRenameSymbol, onTexlabGoto, onWrapEnvironment, projectPaths, props.citationKeys, props.citations, props.onLoadReferenceImage, props.references, props.unusedCitations, props.unusedLabels, secondaryFile],
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
  const [paperWidth, setPaperWidth] = useState<PaperReadingWidth>(loadPaperReadingWidth);
  const togglePaperWidth = () => setPaperWidth((current) => {
    const next: PaperReadingWidth = current === "wide" ? "comfortable" : "wide";
    try {
      localStorage.setItem(PAPER_READING_WIDTH_KEY, next);
    } catch {
      // Preference persistence is best-effort.
    }
    return next;
  });
  if (props.mode === "paper") {
    const showBlog = props.paperView === "blog" && props.paperBlog != null;
    const content = showBlog ? props.paperBlog! : stripFrontmatter(props.paperMarkdown);
    return (
      <article className="paper-reader">
        <div className="paper-reader-title">
          <BookOpen size={15} />
          <span>{props.activePaper?.title ?? "Imported paper"}</span>
          <div className="paper-reader-tools">
            {props.paperBlog != null && (
              <div className="paper-view-toggle" role="group" aria-label="Reading view">
                <button type="button" className={showBlog ? "active" : ""} onClick={() => props.onSetPaperView("blog")}>Blog</button>
                <button type="button" className={!showBlog ? "active" : ""} onClick={() => props.onSetPaperView("fulltext")}>Paper</button>
              </div>
            )}
            <Tip label={paperWidth === "wide" ? "Comfortable width" : "Full width — fits wide tables"}>
              <button type="button" className="paper-width-toggle" onClick={togglePaperWidth} aria-label="Toggle reading width">
                {paperWidth === "wide" ? <FoldHorizontal size={13} /> : <UnfoldHorizontal size={13} />}
              </button>
            </Tip>
            {props.activePaper && <small>arXiv {props.activePaper.arxivId}</small>}
          </div>
        </div>
        <ChatMarkdown text={content} macros={props.katexMacros} className={`paper-content ${paperWidth === "wide" ? "pw-wide" : ""}`} breaks={false} />
      </article>
    );
  }
  if (props.mode === "asset" && props.activeAsset) {
    return <ProjectAssetPreview asset={props.activeAsset} />;
  }
  if (props.mode === "markdown-preview") {
    return <article className="markdown-preview"><ChatMarkdown text={props.source} macros={props.katexMacros} breaks={false} /></article>;
  }
  const showTexChrome = activeFile.endsWith(".tex");
  const editor = (
    <div className="source-workspace">
      <div className="source-main">
        <div
          className={`source-editor ${figureDropActive || props.nativeFigureDropActive ? "figure-drop-active" : ""}`}
          onPointerLeave={props.onEditorLeave}
          onFocusCapture={() => {
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
    <div className="pdf-column">
      {props.pdfTop}
      <PdfPreview
        url={props.pdfUrl}
        pdfBase64={props.pdfBase64}
        syncTarget={props.pdfSyncTarget}
        // Reverse-jump to source only when the editor is visible (split/dual/
        // columns). In PDF-only view there's nothing to jump to, so clicks stay
        // inert and the synctex cursor is off.
        onSource={props.mode === "pdf" ? undefined : props.onPdfSource}
        onTextSelect={props.onPdfTextSelect}
        onNumPages={props.onPdfPageCount}
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
        onFocusCapture={() => {
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
