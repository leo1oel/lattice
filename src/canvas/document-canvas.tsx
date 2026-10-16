import {
  Suspense, useCallback, useEffect, useInsertionEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type DragEvent, type FocusEvent, type HTMLAttributes, type PointerEventHandler, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { CodeMirrorHost as CodeMirror } from "../editor/codemirror-host";
import { takeResumed } from "../editor/parked-editors";
import { latexCitationAfter } from "../editor/paper-drop";
import { closeCompletion } from "@codemirror/autocomplete";
import { redo as redoCodeMirror, undo as undoCodeMirror } from "@codemirror/commands";
import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { paperAuthorNames } from "../papers/paper-identity";
import { paperSourceCitation } from "../papers/paper-source";
import { restoreViewportAround } from "./viewport-restore";
import { wrapEnvironment, wrapRange } from "../editor/latex/latex-edits";
import { renameEnvironmentAt } from "../editor/latex/latex-environments";
import { lineTarget, revealInEditor } from "../editor/editor-reveal";
import { surfaceShown } from "../editor/focus-when-shown";
import type { VisualRevealTarget } from "../editor/markdown/visual-editor-props";
import { LatexSelectionToolbar, SELECTION_TOOLBAR_SURFACES, type LatexSelectionAction, type LatexSelectionToolbarPosition } from "../editor/latex/latex-selection-toolbar";
import { highlightAround, highlightOpening, latexHighlights, recolorHighlight, removeHighlight } from "../editor/latex/latex-highlights";
import { ScrollArea } from "../components/ui/scroll-area";
import { InlineMessage } from "../components/ui/inline-message";
import { latexFigureInsertion, markdownAssetInsertion, type FigureInsertOptions } from "../editor/insert/figure-insertion";
import { FigureInsertDialog } from "../editor/insert/figure-insert-dialog";
import {
  createEditorComment, resolveCommentAnchor, type AnnotationIntent,
} from "../editor/comments/editor-comment-data";
import { clamp } from "../settings/app-settings";
import { replaceTokenOnLine } from "../build/compile-diagnostics";
import { DocumentOutline } from "./document-outline";
import { sectionBreadcrumbNodes } from "../editor/latex/latex-outline";
import { LatexOutlineRail } from "../editor/latex/latex-outline-rail";
import { MathPreview } from "../editor/latex/math-preview";
import { TableGeneratorDialog } from "../editor/insert/table-generator-dialog";
import {
  SPLIT_PREVIEW_MIN_WIDTH, SPLIT_SOURCE_MIN_WIDTH,
} from "../app/window-layout";
import type { FileViewState, AssetPreview } from "../app-types";
import {
  isBibFilePath, isHtmlFilePath, isOpenSlideDeckPath, isPreviewableSourceFilePath,
  markdownFrontmatterEnd, PROJECT_FIGURE_DRAG_TYPE,
} from "../app-utils";
import type { AgentHostSurface } from "../agent/agent-host-context";
import { frameCoalescer, onLayoutChange } from "../app/effect-helpers";
import { useCommittedRef, useLatestRef } from "../hooks/use-latest-ref";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";
import {
  BibVisualEditor, BoardEditor, DeferredVisualMarkdownEditor, HtmlPreviewLoading, MarkdownPreviewLoading, PdfPreview,
  PdfPreviewLoading, SpreadsheetEditor,
} from "./canvas-lazy-editors";
import { loadPdfPreviewModule } from "./canvas-lazy-modules";
import { ChunkGate } from "../components/chunk-gate";
import { CodeMirrorScrollbar } from "./codemirror-scrollbar";
import { AnnotationComposer } from "./annotation-composer";
import { EditorCommentCards } from "./editor-comment-cards";
import { AnnotationReviewLayer } from "./annotation-review";
import { claimSupport } from "../app/claim-support";
import { notifyInfo } from "../telemetry/app-notify";
import { createProofreadBridge } from "./proofread-bridge";
import { ProofreadLayer } from "./proofread-layer";
import { EditorStatusBar } from "./editor-status-bar";
import { isLatexSourcePath } from "./editor-extensions";
import { HtmlPreview } from "./html-preview";
import {
  capturePreviewViewport, minimalTextChange, rangesWithinPreview, restorePreviewAnchor, restorePreviewViewport, restoreViewport,
  spliceMarkdownBody, useSettledPreviewText,
} from "./markdown-preview-sync";
import { PaperReader } from "./paper-reader";
import { OpenSlideDeckPool } from "./open-slide-deck-pool";
import { AfterSwitch } from "./after-switch";
import type { DocumentCanvasProps } from "./canvas-model";
import { ProjectAssetPreview } from "./project-asset-preview";
import { SavedViewState } from "./saved-view-state";
import { useBibUnreadable } from "./use-bib-readability";
import { useMarkdownModeHandoff } from "./use-markdown-mode-handoff";
import { useMarkdownSplitScroll } from "./use-markdown-split-scroll";
import { useSourceSession } from "./use-source-session";
import { usePaperPdf } from "./use-paper-pdf";
import { splitGridTemplate, useSplitLayout, type SplitMinimums } from "./use-split-layout";


/** LaTeX wrappers the floating selection toolbar applies; null declines the edit. */
const SPLIT_MINIMUMS: SplitMinimums = { source: SPLIT_SOURCE_MIN_WIDTH, preview: SPLIT_PREVIEW_MIN_WIDTH };

const SELECTION_WRAPS: Record<Exclude<LatexSelectionAction, "comment" | "proofread" | "polish" | "support" | "unhighlight">, (value?: string) => [string, string] | null> = {
  bold: () => ["\\textbf{", "}"],
  italic: () => ["\\textit{", "}"],
  underline: () => ["\\underline{", "}"],
  strikethrough: () => ["\\sout{", "}"],
  highlight: (value) => [highlightOpening(value ?? ""), "}"],
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

/** How long a jump waits for its source view to be ready before landing as best it can. */
const LANDING_WAIT_MS = 1000;

/**
 * Run `land` in the source view once a jump can land there, a frame at a time
 * until then; the returned function cancels it. Ready means two things:
 * - the view holds `source`: codemirror-host holds an external value back
 *   while someone is typing, so the view can still carry the previous file's
 *   text when a jump arrives;
 * - its surface is shown (focus-when-shown.ts): opening a comment from the
 *   panel over the document moves the canvas into a Trellis tab that shows a
 *   frame or more later. Landed before then, the browser refused the editor
 *   focus and the writer's typing after the jump went nowhere.
 * Neither waits forever: a best-effort landing beats a request nobody answers.
 */
function landWhenReady(targetView: () => EditorView | null, source: string, land: (view: EditorView) => void): () => void {
  const deadline = performance.now() + LANDING_WAIT_MS;
  const [schedule, cancel] = frameCoalescer(() => {
    const view = targetView();
    if (!view) return;
    const ready = view.state.doc.toString() === source && surfaceShown(view.dom);
    if (!ready && performance.now() < deadline) schedule();
    else land(view);
  });
  schedule();
  return cancel;
}

/** Hand App `value` through `register` while this canvas is mounted with both. */
function useRegistration<T>(register: ((value: T | null) => void) | undefined, value: T) {
  useLayoutEffect(() => {
    if (!register) return;
    register(value);
    return () => register(null);
  }, [register, value]);
}

export function DocumentCanvas(props: DocumentCanvasProps) {
  const { activeFile, editorKey, setSource, source: editorSource } = props.document;
  const { editorKeymap } = props.preferences;
  const { katexMacros } = props.bibliography;
  const {
    onGotoLineRequest, onOutlineNavigate, onOutlineOpenChange, onTableGeneratorOpenChange,
    activeOutlineId, outlineNodes, outlineOpen, tableGeneratorOpen, getFileViewState, onFileViewState, onRequestHandled,
  } = props.navigation;
  const { onPrepareFigure } = props.assets;
  const {
    editorComments, commentAuthorName, commentAuthorId, onCreateEditorComment, onOpenEditorComments,
    commentFocusRequest, onCommentFocusHandled,
  } = props.review;
  const { buildDiagnostics } = props.status;
  const settledSource = props.document.settledSource ?? editorSource;
  const {
    navigation: editorNavigation, restore: viewRestore, rename: envRenameRequest, wrap: wrapEnvRequest,
    cite: citeInsertRequest, figure: figureDropRequest, proofread: proofreadRequest, replace: tokenReplaceRequest,
  } = props.navigation.requests;
  const { t } = useLingui();
  const commentAuthor = useMemo(() => ({ id: commentAuthorId, name: commentAuthorName }), [commentAuthorId, commentAuthorName]);
  // The newest props for handlers and window listeners, so those never
  // rebuild for them; current before the editor's own commit reads them.
  const latestRef = useCommittedRef(props);
  const [proofread] = useState(createProofreadBridge);
  const [selectionToolbar, setSelectionToolbar] = useState<{ position: LatexSelectionToolbarPosition; highlight: string | null } | null>(null);
  const selectionToolbarOwnerRef = useRef<{ path: string; from: number; to: number } | null>(null);
  const dismissSelectionToolbar = useCallback(() => {
    selectionToolbarOwnerRef.current = null;
    setSelectionToolbar(null);
  }, []);
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
    const halfWidth = Math.min(350, Math.max(0, editorBounds.width - 16)) / 2;
    const selectionCenter = start.top === end.top
      ? (start.left + end.right) / 2
      : start.left + Math.min(72, Math.max(20, editorBounds.width / 5));
    const left = clamp(selectionCenter, editorBounds.left + halfWidth + 8, editorBounds.right - halfWidth - 8);
    const selectionTop = Math.min(start.top, end.top);
    const below = selectionTop - editorBounds.top < 52;
    selectionToolbarOwnerRef.current = { path, from: range.from, to: range.to };
    // A highlight around the selection: the palette ticks its colour and offers Remove.
    const highlight = path.endsWith(".tex") ? highlightAround(view.state.doc, range.from, range.to) : null;
    setSelectionToolbar({
      position: { left, top: below ? start.bottom + 8 : selectionTop - 8, below, maxWidth: Math.max(0, editorBounds.width - 16) },
      highlight: highlight ? highlight.color ?? "" : null,
    });
  }, [dismissSelectionToolbar]);
  // Filled by the split scroll coordinator; the source editor's updates poke
  // it so cursor motion reveals the matching preview block.
  const markdownCursorRevealRef = useRef<(() => void) | null>(null);
  const session = useSourceSession(props, {
    latestRef,
    proofread,
    pinLabel: (numbers) => {
      const list = numbers.join(", ");
      return numbers.length === 1 ? t`Annotation ${list}` : t`Annotations ${list}`;
    },
    onEditorUpdate: (update, path) => {
      if (path) {
        const { view } = update;
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
      }
      markdownCursorRevealRef.current?.();
    },
  });
  const { viewRef: primaryViewRef, viewPathRef: primaryViewPathRef, insertionViewRef: editorViewRef } = session;
  const primaryScrollbarView = session.view;
  const {
    draft: commentComposer, setDraft: setCommentComposer, openDraft: openCommentComposer, selectedText, comments: commentsForActiveFile,
  } = session;
  const primaryVisualMarkdownFlushRef = useRef<(() => boolean) | null>(null);
  const registerPrimaryVisualMarkdownFlush = useCallback((flush: (() => boolean) | null) => {
    primaryVisualMarkdownFlushRef.current = flush;
  }, []);
  const flushPrimaryVisualMarkdown = useCallback(() => primaryVisualMarkdownFlushRef.current?.(), []);
  const flushVisualMarkdown = useCallback(() => primaryVisualMarkdownFlushRef.current?.() !== false, []);
  useRegistration(props.document.onVisualMarkdownFlushChange, flushVisualMarkdown);
  const primarySurface: AgentHostSurface = props.document.activePaper ? "paper" : "editor";
  const primaryKind = props.document.activePaper ? null : structuredDocumentKind(activeFile);
  // Every open deck renders in OpenSlideDeckPool; these change only with what they hold, so the pool re-derives only then.
  const activeDeckSource = primaryKind === "presentation" ? props.document.source : null;
  const activeDeck = useMemo(() => (
    activeDeckSource === null ? null : { path: activeFile, source: activeDeckSource, editable: props.document.editorEditable }
  ), [activeDeckSource, activeFile, props.document.editorEditable]);
  const deckSettings = useMemo(() => ({
    projectRoot: props.preferences.projectRoot,
    locale: props.preferences.locale,
    theme: props.preferences.theme,
    onMutation: props.assets.onOpenSlideMutation,
    onContext: props.assets.onOpenSlideContext,
    onError: props.assets.onOpenSlideError,
  }), [props.preferences.locale, props.assets.onOpenSlideContext, props.assets.onOpenSlideError, props.assets.onOpenSlideMutation, props.preferences.projectRoot, props.preferences.theme]);
  const markdownDocument = Boolean(props.document.activePaper)
    || (activeFile.toLocaleLowerCase().endsWith(".md") && primaryKind !== "presentation");
  const htmlDocument = !props.document.activePaper && isHtmlFilePath(activeFile);
  const bibDocument = !props.document.activePaper && isBibFilePath(activeFile);
  // The source editor's accessible name: which document, then which kind of
  // source, so a screen reader tells it from the other editor or a search field.
  const documentName = props.document.activePaper?.title || activeFile.slice(activeFile.lastIndexOf("/") + 1);
  const sourceLabel = isLatexSourcePath(activeFile) ? t`${documentName} — LaTeX source`
    : markdownDocument ? t`${documentName} — Markdown source`
    : bibDocument ? t`${documentName} — BibTeX source`
    : htmlDocument ? t`${documentName} — HTML source`
    : t`${documentName} — source`;
  // Shown alone, a reference list the file cannot make gives way to the source.
  const bibUnreadable = useBibUnreadable(bibDocument && props.document.mode === "pdf" ? props.document.source : null);
  const explicitPreview = props.document.markdownPreviewSource;
  const markdownPreviewStart = explicitPreview !== undefined
    ? (props.document.source.endsWith(explicitPreview) ? props.document.source.length - explicitPreview.length : 0)
    : markdownDocument ? markdownFrontmatterEnd(props.document.source) : 0;
  const markdownPreviewText = props.document.markdownPreviewSource ?? props.document.source.slice(markdownPreviewStart);
  const markdownPreviewEnd = markdownPreviewStart + markdownPreviewText.length;
  const { settled: settledPreviewText, markEcho: setVisualEchoSource, policy: markdownSyncPolicy } = useSettledPreviewText(
    props.document.source,
    // Other files never reach the Markdown preview: a constant spares each
    // keystroke a publication whose only effect was one more render.
    markdownDocument ? markdownPreviewText : "",
    activeFile,
  );
  const paperFullTextActive = Boolean(props.document.activePaper) && activeFile.replace(/\\/g, "/").toLocaleLowerCase().endsWith("/paper.md");
  const paperAuthors = props.document.activePaper ? paperAuthorNames(props.document.activePaper).join(" · ") : "";
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
  const markdownPreviewLineOffset = props.document.source.slice(0, markdownPreviewStart).split("\n").length - 1;
  const markdownVisualCursors = useMemo(
    () => props.review.overleafPresenceCursors
      .filter((cursor) => cursor.row >= markdownPreviewLineOffset)
      .map((cursor) => ({ ...cursor, row: cursor.row - markdownPreviewLineOffset })),
    [markdownPreviewLineOffset, props.review.overleafPresenceCursors],
  );
  const markdownVisualChanges = useMemo(() => props.review.overleafChanges.flatMap((change) => {
    const changeEnd = change.deletion ? change.position : change.position + change.text.length;
    return change.position < markdownPreviewStart || changeEnd > markdownPreviewEnd
      ? []
      : [{ ...change, position: change.position - markdownPreviewStart }];
  }), [markdownPreviewEnd, markdownPreviewStart, props.review.overleafChanges]);
  const markdownPreviewViewportRef = useRef<HTMLDivElement | null>(null);
  // Weak for the same reason as the source session's view: a retained render
  // scope must not pin a replaced preview and its whole rendered document.
  const [markdownPreviewViewport, setMarkdownPreviewViewport] = useState<WeakRef<HTMLDivElement> | null>(null);
  const paperPdf = usePaperPdf({
    activePaper: props.document.activePaper,
    activeFile,
    mode: props.document.mode,
    onOpenMarkdownPath: props.document.onOpenMarkdownPath,
    flushVisualMarkdown: flushPrimaryVisualMarkdown,
    previewViewportRef: markdownPreviewViewportRef,
    settledPreviewText,
  });
  const { quoteFallback, returnViewportRef: paperReturnViewportRef } = paperPdf;
  const paperPdfOpen = paperPdf.pdfView !== null;
  const { onPaperPdfOpenChange } = props.document;
  useLayoutEffect(() => {
    if (!onPaperPdfOpenChange) return;
    onPaperPdfOpenChange(paperPdfOpen);
    return () => onPaperPdfOpenChange(false);
  }, [onPaperPdfOpenChange, paperPdfOpen]);
  const markdownPreviewPersistenceCleanupRef = useRef<(() => void) | null>(null);
  const markdownScrollSyncSuppressedRef = useRef(false);
  const markdownPreviewViewportLockRef = useRef(0);
  const markdownPreviewReconcileFromSourceRef = useRef<(() => void) | null>(null);
  const markdownPreviewOverflowAnchorRef = useRef("");
  const pendingFigureCursorRef = useRef<number | null>(null);
  const { splitRef, splitRatio, beginSplitResize, nudgeSplit } = useSplitLayout(props.document.mode, SPLIT_MINIMUMS);
  const splitMinimums = SPLIT_MINIMUMS;
  const [figureDropActive, setFigureDropActive] = useState(false);
  const [figureInsertPending, setFigureInsertPending] = useState<{ paths: string[]; position: number } | null>(null);
  // Saved-view ownership for the preview column. Files without a preview of
  // their own (.bib, .sty) keep using the last previewable file's saved state.
  // This is separate from the mounted viewer's identity: all TeX source files
  // share the project's compiled PDF, including across SyncTeX jumps. The
  // canvas outlives a project switch, so the identity is tied to its root: the
  // outgoing project's file must not own the incoming project's saved PDF view.
  const [previewIdentity, setPreviewIdentity] = useState({ root: props.preferences.projectRoot, path: activeFile });
  const previewOwner = isPreviewableSourceFilePath(activeFile) ? activeFile : undefined;
  if (previewIdentity.root !== props.preferences.projectRoot || (previewOwner && previewOwner !== previewIdentity.path)) {
    setPreviewIdentity({ root: props.preferences.projectRoot, path: previewOwner ?? activeFile });
  }

  const { captureMarkdownModeViewport, viewMarkdownSource, livePrimaryView } = useMarkdownModeHandoff({
    activeFile,
    mode: props.document.mode,
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
    onViewMarkdownSource: props.document.onViewMarkdownSource,
  });
  useRegistration(props.document.onMarkdownModeViewportCaptureChange, captureMarkdownModeViewport);

  // Markdown's Preview is its visual editor: a jump or comment focus for the
  // file in front lands there, instead of opening a source view for it.
  const commentFocusPath = commentFocusRequest ? editorComments.find((item) => item.id === commentFocusRequest.id)?.path : undefined;
  const visualReveal = useMemo<VisualReveal | null>(() => {
    if (!markdownDocument || props.document.mode !== "pdf") return null;
    if (editorNavigation?.path === activeFile) {
      return { id: editorNavigation.id, kind: "navigation", target: { line: Math.max(1, editorNavigation.line - markdownPreviewLineOffset) } };
    }
    if (commentFocusRequest && commentFocusPath === activeFile) {
      return { id: commentFocusRequest.nonce, kind: "comment", target: { commentId: commentFocusRequest.id } };
    }
    return null;
  }, [activeFile, commentFocusPath, commentFocusRequest, editorNavigation, markdownDocument, markdownPreviewLineOffset, props.document.mode]);
  const visualRevealRef = useLatestRef(visualReveal);
  const toolbarShown = selectionToolbar !== null;
  const documentColors = useMemo(() => toolbarShown ? documentHighlightColors(settledSource) : [], [toolbarShown, settledSource]);

  // Comments rebased into the preview's own coordinates: it may render a slice
  // of the file, and resolves anchors against the text it was given.
  const markdownVisualComments = useMemo(
    () => rangesWithinPreview(commentsForActiveFile, markdownPreviewStart, markdownPreviewEnd),
    [commentsForActiveFile, markdownPreviewEnd, markdownPreviewStart],
  );

  const mountSourceRef = useRef(props.document.source);
  const visualSourceHistoryRef = useRef<{ path: string; undo: string[]; redo: string[] }>({ path: activeFile, undo: [], redo: [] });
  // A new editor starts from the source it mounts with, before anything in
  // its commit (a visual editor's first publication) reads it.
  useInsertionEffect(() => {
    mountSourceRef.current = latestRef.current.document.source;
  }, [editorKey, latestRef]);
  useEffect(() => {
    // A mounted source view holds the document; without one, only a change
    // from outside the preview replaces its local history.
    const view = primaryViewRef.current?.dom.isConnected ? primaryViewRef.current : null;
    const source = view ? view.state.doc.toString() : props.document.source;
    if (view || mountSourceRef.current !== source) {
      visualSourceHistoryRef.current = { path: activeFile, undo: [], redo: [] };
      mountSourceRef.current = source;
    }
  }, [activeFile, primaryViewRef, props.document.mode, props.document.source]);


  useEffect(() => onLayoutChange(
    [primaryViewRef.current?.dom.closest(".source-editor")],
    () => {
      const owner = selectionToolbarOwnerRef.current;
      const view = primaryViewRef.current;
      if (owner && view) updateSelectionToolbar(view, owner.path);
    },
  ), [activeFile, primaryViewRef, updateSelectionToolbar]);

  // Switching files, or to a mode without a source editor, drops the selection toolbar.
  const sourceEditorHidden = props.document.mode === "pdf" || props.document.mode === "asset";
  useEffect(dismissSelectionToolbar, [activeFile, dismissSelectionToolbar, sourceEditorHidden]);

  useEffect(() => {
    if (!commentFocusRequest) return;
    const comment = editorComments.find((item) => item.id === commentFocusRequest.id);
    // The visual editor answers it in Markdown's Preview (visualReveal).
    if (!comment || comment.path !== activeFile || (markdownDocument && props.document.mode === "pdf")) return;
    if (!primaryViewRef.current) return;
    return landWhenReady(() => primaryViewRef.current, editorSource, (view) => {
      const range = resolveCommentAnchor(view.state.doc.toString(), comment);
      if (range) revealInEditor(view, range);
      onCommentFocusHandled(commentFocusRequest.nonce);
    });
  }, [activeFile, commentFocusRequest, editorComments, editorSource, markdownDocument, onCommentFocusHandled, primaryViewRef, props.document.mode]);
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
    if (!view || owner.path !== latestRef.current.document.activeFile) return;
    const range = view.state.selection.main;
    if (range.empty || range.from !== owner.from || range.to !== owner.to) {
      dismissSelectionToolbar();
      return;
    }
    if (action === "comment") {
      const quote = view.state.sliceDoc(range.from, range.to);
      if (activeFile && quote.trim()) {
        openCommentComposer(view, {
          path: activeFile, from: range.from, to: range.to, quote, body: "", error: null,
          line: view.state.doc.lineAt(range.from).number,
          prefix: view.state.sliceDoc(Math.max(0, range.from - 32), range.from),
          suffix: view.state.sliceDoc(range.to, Math.min(view.state.doc.length, range.to + 32)),
        });
      }
      dismissSelectionToolbar();
      return;
    }
    if (!props.document.editorEditable) return;
    if (action === "support") {
      const doc = view.state.doc;
      if (activeFile) {
        void claimSupport.find({
          path: activeFile, from: range.from, to: range.to, line: doc.lineAt(range.from).number,
          quote: view.state.sliceDoc(range.from, range.to),
          prefix: view.state.sliceDoc(Math.max(0, range.from - 32), range.from),
          suffix: view.state.sliceDoc(range.to, Math.min(doc.length, range.to + 32)),
        });
      }
      dismissSelectionToolbar();
      return;
    }
    if (action === "proofread" || action === "polish") {
      proofread.start(view, action);
      dismissSelectionToolbar();
      return;
    }
    // Remove takes off the highlight around the selection; a colour chosen for
    // a whole highlight recolours it rather than nesting another inside.
    if (action === "highlight" || action === "unhighlight") {
      const around = highlightAround(view.state.doc, range.from, range.to);
      const whole = around && ((around.contentFrom === range.from && around.contentTo === range.to)
        || (around.from === range.from && around.to === range.to));
      const target = action === "unhighlight" || whole ? around : null;
      if (target) {
        const changes = view.state.changes(action === "unhighlight" ? removeHighlight(target) : [recolorHighlight(target, value ?? "")]);
        editAndFocus(view, {
          changes,
          selection: { anchor: changes.mapPos(target.contentFrom, 1), head: changes.mapPos(target.contentTo, -1) },
        });
        updateSelectionToolbar(view, owner.path);
        return;
      }
      if (action === "unhighlight") return;
    }
    const wrap = SELECTION_WRAPS[action](value);
    if (!wrap) return;
    const edit = wrapRange(view.state.doc.toString(), range.from, range.to, ...wrap);
    editAndFocus(view, { changes: edit, selection: { anchor: edit.cursorFrom, head: edit.cursorTo } });
    updateSelectionToolbar(view, owner.path);
  }, [activeFile, dismissSelectionToolbar, latestRef, openCommentComposer, primaryViewRef, proofread, props.document.editorEditable, updateSelectionToolbar]);

  /**
   * Annotate `[from, to)` of `path`, then ask the agent about every open
   * annotation when `revise`; false when that range holds nothing to anchor it.
   */
  const createComment = (path: string, source: string, from: number, to: number, body: string, extra: {
    intent?: AnnotationIntent;
    revise?: boolean;
  } = {}) => {
    const comment = createEditorComment({
      path, source, from, to, body, authorId: commentAuthorId, authorName: commentAuthorName, intent: extra.intent,
    });
    if (!comment) return false;
    const created = onCreateEditorComment(comment);
    if (created && !(created instanceof Promise) && extra.revise) props.review.annotationRounds.revise();
    return true;
  };
  const closeCommentComposer = () => {
    setCommentComposer(null);
    session.draftView?.deref()?.focus();
  };
  /**
   * Esc or a click outside closed the note. A click outside goes on to do
   * what it does there, so the editor does not take focus back from it. A
   * note with words in it is offered back, in the file it was written on.
   */
  const dismissCommentComposer = (outside: boolean) => {
    const draft = commentComposer;
    if (outside) setCommentComposer(null);
    else closeCommentComposer();
    if (!draft?.body.trim()) return;
    notifyInfo(t`Annotations`, t`Note discarded`, {
      dedupeKey: "annotation-draft-discarded",
      primaryAction: {
        label: t`Undo`,
        onClick: () => {
          const view = primaryViewRef.current;
          if (!view || latestRef.current.document.activeFile !== draft.path) return;
          openCommentComposer(view, { ...draft, error: null });
        },
      },
    });
  };
  const saveCommentComposer = (revise: boolean) => {
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
    const { body, intent } = commentComposer;
    if (createComment(activeFile, editorSource, range.from, range.to, body, { intent, revise })) closeCommentComposer();
  };
  const breadcrumb = useMemo(
    () => activeFile.endsWith(".tex") ? sectionBreadcrumbNodes(settledSource, session.position.line, activeFile) : [],
    [activeFile, settledSource, session.position.line],
  );
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
  }, [activeFile, editorViewRef, onPrepareFigure, primaryViewRef]);
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
  }, [editorSource, editorViewRef, primaryViewRef]);
  useEffect(() => {
    const request = editorNavigation;
    if (!request || request.path !== activeFile) return;
    // No source view to land in; in Markdown's Preview the visual editor answers it (visualReveal).
    if (props.document.mode === "pdf" || props.document.mode === "asset") return;
    // A ref can be assigned before CodeMirror's DOM reports connected; treat the
    // view as ready, since the later attachment does not rerun this effect.
    const targetView = () => primaryViewRef.current ?? editorViewRef.current;
    if (!targetView()) return;
    return landWhenReady(targetView, editorSource, (view) => {
      revealInEditor(view, lineTarget(view, request.line));
      editorViewRef.current = view;
      onRequestHandled(request.id);
    });
  }, [activeFile, editorNavigation, editorSource, editorViewRef, onRequestHandled, primaryViewRef, props.document.mode]);
  // A failed build's suggested fix, once the file it names is the one shown:
  // App opens it at the line first, so this lands as a jump does.
  useEffect(() => {
    const request = tokenReplaceRequest;
    if (!request || request.path !== activeFile) return;
    if (props.document.mode === "pdf" || props.document.mode === "asset") return;
    const targetView = () => primaryViewRef.current ?? editorViewRef.current;
    if (!targetView()) return;
    return landWhenReady(targetView, editorSource, (view) => {
      const edit = props.document.editorEditable
        ? replaceTokenOnLine(view.state.doc.toString(), request.line, request.token, request.replacement)
        : null;
      if (edit) editAndFocus(view, { changes: edit, selection: { anchor: edit.from + edit.insert.length } });
      editorViewRef.current = view;
      onRequestHandled(request.id);
    });
  }, [activeFile, editorSource, editorViewRef, onRequestHandled, primaryViewRef, props.document.editorEditable, props.document.mode, tokenReplaceRequest]);
  useEffect(() => {
    const request = figureDropRequest;
    if (!request) return;
    void insertFigures(request.paths, { x: request.clientX, y: request.clientY }).finally(() => onRequestHandled(request.id));
  }, [figureDropRequest, insertFigures, onRequestHandled]);
  // The palette's Proofread / Polish selection: the source editor's selection,
  // which it kept while the palette had focus. Settled whether or not a
  // proofread could start, so it never waits for the next selection.
  useEffect(() => {
    const request = proofreadRequest;
    if (!request) return;
    const view = primaryViewRef.current ?? editorViewRef.current;
    if (view && props.document.editorEditable) proofread.start(view, request.mode);
    onRequestHandled(request.id);
  }, [editorViewRef, onRequestHandled, primaryViewRef, proofread, proofreadRequest, props.document.editorEditable]);
  // One-shot LaTeX edits at the insertion target's caret, each settled once
  // applied. Find support's Cite instead goes after the claim, found again in
  // its file once that file is the one on screen (App opens it first).
  useEffect(() => {
    const view = editorViewRef.current;
    if (view) {
      if (citeInsertRequest && !citeInsertRequest.at) {
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
    }
    const request = citeInsertRequest;
    const at = request?.at;
    if (!request || !at || at.path !== activeFile || props.document.mode === "pdf" || props.document.mode === "asset") return;
    const targetView = () => primaryViewRef.current ?? editorViewRef.current;
    if (!targetView()) return;
    return landWhenReady(targetView, editorSource, (view) => {
      const source = view.state.doc.toString();
      const range = resolveCommentAnchor(source, at);
      const editable = props.document.editorEditable && !view.state.readOnly;
      const edit = range && editable ? latexCitationAfter(source, range.from, range.to, request.key) : null;
      if (edit) {
        // The caret lands after it, in view: selected, the citation would
        // raise the selection toolbar over the very text it shows.
        const end = edit.from + edit.insert.length;
        editAndFocus(view, { changes: edit, selection: { anchor: end } });
        revealInEditor(view, { from: end });
      }
      at.settled(!range ? "moved" : !editable ? "read-only" : edit ? "cited" : "already");
      onRequestHandled(request.id);
    });
  }, [
    activeFile, citeInsertRequest, editorSource, editorViewRef, envRenameRequest, onRequestHandled, primaryScrollbarView,
    primaryViewRef, props.document.editorEditable, props.document.mode, wrapEnvRequest,
  ]);
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
    // The editor came back from where it was parked, already exactly where it
    // was left; the saved pixel offset would land elsewhere (see parked-editors.ts).
    if (takeResumed(view)) {
      onRequestHandled(request.id);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const current = editorViewRef.current;
      if (!current) return;
      const cursor = clamp(request.cursor, 0, current.state.doc.length);
      // The caret goes back without being scrolled to: the saved offset is
      // the place. Revealed, a caret left above where the writer then
      // scrolled won at CodeMirror's next measure and pulled the view back up.
      current.dispatch({ selection: { anchor: cursor } });
      current.scrollDOM.scrollTop = request.scrollTop;
      onRequestHandled(request.id);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeFile, editorViewRef, onRequestHandled, viewRestore, editorSource, editorNavigation, primaryScrollbarView]);

  const replaceVisualMarkdown = useCallback((nextBody: string, expectedBody: string) => {
    // VisualMarkdownEditor retains the previous publisher until its layout
    // flush: a late callback must not write once another document owns the canvas.
    if (latestRef.current.document.activeFile !== activeFile) return false;
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
  }, [activeFile, latestRef, livePrimaryView, markdownPreviewStart, setSource, setVisualEchoSource]);

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
    const snapshot = saved && { ...saved, scrollRange: saved.scrollRange ?? 0 };
    let restoring = Boolean(saved);
    let attempts = 0;
    // A jump into this file owns its viewport: the remembered place would land
    // first and the jump second, two moves where one was asked for.
    const jumping = () => latestRef.current.navigation.requests.navigation?.path === path || visualRevealRef.current !== null;
    // Retried each frame until the preview is tall enough to hold the saved
    // place, then (with a block saved) until that block is back where it was:
    // the offset alone drifts wherever the layout changed above it.
    const [scheduleRestore, cancelRestore] = frameCoalescer(() => {
      attempts += 1;
      if (jumping()) {
        restoring = false;
        return;
      }
      const ready = snapshot && (attempts > 1 ? restorePreviewViewport(viewport, snapshot) : restoreViewport(viewport, snapshot) && !anchor);
      if (!ready && attempts < 30) scheduleRestore();
      else restoring = false;
    });
    let lastAnchor = anchor;
    let width = viewport.clientWidth;
    const report = () => {
      // A preview being torn down has no layout left to read a place from;
      // one rewrapped at a width the observer below has yet to see scrolled
      // only by that reflow (native anchoring), not by the reader.
      if (restoring || !viewport.isConnected || (viewport.clientWidth && viewport.clientWidth !== width)) return;
      const place = capturePreviewViewport(viewport);
      lastAnchor = place.anchor;
      onFileViewState?.(path, { visualMarkdown: place });
    };
    // The block last read at the top stays there through a change of width
    // (a panel resized, a Writing or Reading layout taking over), as the text
    // above it rewraps; WebKit has no native scroll anchoring to do it. The
    // observer runs after that layout and before it paints.
    let resizeFrames = 0;
    const [scheduleKeep, cancelKeep] = frameCoalescer(() => {
      resizeFrames += 1;
      if (lastAnchor && !restorePreviewAnchor(viewport, lastAnchor) && resizeFrames < 10) scheduleKeep();
    });
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => {
      // Hidden (no width) is no new width: the place waits for it to show again.
      if (viewport.clientWidth === width || !viewport.clientWidth) return;
      width = viewport.clientWidth;
      // Split mode's scroll sync and its insertion lock own this scroll, and
      // both turn native anchoring off while they do.
      if (restoring || !lastAnchor || viewport.style.overflowAnchor === "none") return;
      resizeFrames = 0;
      if (!restorePreviewAnchor(viewport, lastAnchor)) scheduleKeep();
    });
    resizeObserver?.observe(viewport);
    viewport.addEventListener("scroll", report, { passive: true });
    if (saved) scheduleRestore();
    markdownPreviewPersistenceCleanupRef.current = () => {
      cancelRestore();
      cancelKeep();
      resizeObserver?.disconnect();
      restoring = false;
      report();
      viewport.removeEventListener("scroll", report);
    };
  }, [activeFile, getFileViewState, latestRef, onFileViewState, paperReturnViewportRef, quoteFallback, visualRevealRef]);

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
    latestRef.current.document.setSource(target);
    return true;
  }, [activeFile, latestRef, livePrimaryView, setVisualEchoSource]);
  const undoVisualMarkdown = useCallback(() => stepVisualHistory("undo"), [stepVisualHistory]);
  const redoVisualMarkdown = useCallback(() => stepVisualHistory("redo"), [stepVisualHistory]);

  /**
   * The reference list's edit of the .bib in front: `next` was computed from
   * `base`, so it lands only on that text. A mounted source view takes it as
   * one change in its own history; otherwise the preview's history holds it,
   * as it does a visual Markdown edit.
   */
  const replaceBibSource = useCallback((next: string, base: string) => {
    if (latestRef.current.document.activeFile !== activeFile) return false;
    const view = livePrimaryView();
    const source = view?.state.doc.toString() ?? mountSourceRef.current;
    if (source !== base) return false;
    if (view) {
      view.dispatch({ changes: minimalTextChange(base, next, 0) });
      mountSourceRef.current = next;
      return true;
    }
    if (visualSourceHistoryRef.current.path !== activeFile) visualSourceHistoryRef.current = { path: activeFile, undo: [], redo: [] };
    visualSourceHistoryRef.current.undo.push(source);
    visualSourceHistoryRef.current.redo = [];
    mountSourceRef.current = next;
    setSource(next);
    return true;
  }, [activeFile, latestRef, livePrimaryView, setSource]);

  useMarkdownSplitScroll({
    view: primaryScrollbarView,
    preview: markdownPreviewViewport,
    active: markdownDocument && props.document.mode === "split",
    previewStart: markdownPreviewStart,
    peerScrollSettleMs: markdownSyncPolicy.peerScrollSettleMs,
    suppressedRef: markdownScrollSyncSuppressedRef,
    viewportLockRef: markdownPreviewViewportLockRef,
    cursorRevealRef: markdownCursorRevealRef,
    reconcileRef: markdownPreviewReconcileFromSourceRef,
  });

  /** Reads `path`'s saved `key` view state, for a surface to restore as it mounts (see saved-view-state.tsx). */
  const savedView = <K extends keyof FileViewState>(path: string, key: K) => (
    (): FileViewState[K] | undefined => props.navigation.getFileViewState?.(path)?.[key]
  );
  /**
   * The surface `mount` (keyed `mountKey`) with the props that let it restore
   * and file its own per-file view state, read as it mounts.
   */
  const withViewState = <K extends keyof FileViewState>(
    path: string,
    key: K,
    mountKey: string,
    mount: (binding: { initialViewState?: FileViewState[K]; onViewState: (state: FileViewState[K]) => void }) => ReactNode,
  ) => (
    <SavedViewState<FileViewState[K] | undefined> key={mountKey} read={savedView(path, key)}>
      {(initialViewState) => mount({
        initialViewState,
        onViewState: (state) => props.navigation.onFileViewState?.(path, { [key]: state }),
      })}
    </SavedViewState>
  );
  const assetPreview = (asset: AssetPreview) => (
    <AfterSwitch key={asset.path} state={props.hosts.switchState}>
      <SavedViewState<FileViewState | undefined> read={() => props.navigation.getFileViewState?.(asset.path)}>
        {(viewState) => (
          <ProjectAssetPreview
            asset={asset}
            missing={props.document.activeAssetMissing}
            viewState={viewState}
            onViewState={(update) => props.navigation.onFileViewState?.(asset.path, update)}
            onFileChanged={props.document.onActiveAssetChanged}
            onPdfTextSelect={props.selection.onPdfTextSelect}
          />
        )}
      </SavedViewState>
    </AfterSwitch>
  );
  const htmlPreview = (path: string, source: string, sourceEditorView?: EditorView | null) => (
    props.preferences.interactivePreviewsEnabled ? withViewState(path, "html", path, (binding) => (
      <HtmlPreview
        path={path}
        source={source}
        assetRevision={props.bibliography.referenceImageGeneration ?? 0}
        sourceEditorView={sourceEditorView}
        {...binding}
        onLoadAsset={props.bibliography.onLoadReferenceImage}
      />
    )) : <HtmlPreviewLoading />
  );
  const structuredFallbacks: Record<Exclude<StructuredDocumentKind, "presentation">, [string, string]> = {
    board: ["board-editor-root", t`Preparing board editor`],
    spreadsheet: ["spreadsheet-editor-root", t`Preparing spreadsheet editor`],
  };
  /** The board or spreadsheet that owns the canvas. (Decks render in their own pool, below.) */
  const structuredEditor = (kind: Exclude<StructuredDocumentKind, "presentation">) => {
    const path = activeFile;
    const source = props.document.source;
    const [fallbackClass, fallbackLabel] = structuredFallbacks[kind];
    const editor = {
      path, source,
      onChange: session.host.onChange,
      onFlushPendingChange: registerPrimaryVisualMarkdownFlush,
    };
    // Remount per file so each board gets a fresh store; local boards serialize
    // back through the source buffer before a document switch.
    return (
      <Suspense fallback={<div className={fallbackClass} aria-busy="true" aria-label={fallbackLabel} />}>
        {kind === "board"
          ? withViewState(path, "board", path, (binding) => <BoardEditor {...editor} theme={props.preferences.theme} {...binding} />)
          : withViewState(path, "spreadsheet", path, (binding) => <SpreadsheetEditor {...editor} onPersist={props.document.onSave} {...binding} />)}
      </Suspense>
    );
  };

  const activatePrimarySurface = () => props.selection.onContextSurfaceActivate(primarySurface);
  /** Leaving `currentTarget` entirely, by pointer or by focus, counts as leaving the editor. */
  const leaveHandlers = {
    onPointerLeave: props.document.onEditorLeave,
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) props.document.onEditorLeave();
    },
  };
  /** Focusing the editor offers its agent surface and makes its source view the insertion target. */
  const focusEditor = () => {
    props.selection.onContextSurfaceActivate(primarySurface);
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
    onOpenProjectPath: props.document.onOpenMarkdownPath,
    workspaceIndex: props.document.workspaceIndex,
    papers: props.bibliography.papers,
    macros: katexMacros,
    onImportAsset: props.assets.onImportAsset,
    onLoadAsset: props.bibliography.onLoadReferenceImage,
    assetRevision: props.bibliography.referenceImageGeneration ?? 0,
    activeEditorCommentId: props.review.activeEditorCommentId,
    // Opens the panel on that thread, like replying from the source editor's tooltip.
    onEditorCommentClick: props.review.onReplyEditorComment,
    onSelectionMarkdown: (value: string) => latestRef.current.selection.setSelection(value),
  };
  /** A visual editor's caret moved to 1-based `line` of `path`. */
  const reportVisualCaret = (path: string, line: number, column: number) => {
    session.setPosition({ line, column });
    props.navigation.onEditorPosition({ path, line, column });
  };
  const markdownPreview = (
    <ScrollArea
      className="markdown-preview"
      data-tour={props.document.activePaper ? "paper-reading-view" : "markdown-visual-editor"}
      // Wide tables, code and formulas own their horizontal overflow; a second
      // root scrollbar made Base UI run another ResizeObserver loop.
      orientation="vertical"
      // Mask gradients repaint the whole editable surface while scrolling in WebKit.
      fadeEdges={false}
      contentClassName="markdown-preview-content"
      viewportClassName="editor-doc-scroll"
      // The visual editor finds its scroller through `.editor-doc-scroll`
      // (block-window.ts, use-near-viewport.ts, document-heading-rail.tsx); the
      // App integration suites find it through this testid.
      viewportProps={{
        "data-testid": "editor-scroll-container",
        onClickCapture: (event) => {
          if (!props.document.activePaper || event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
          const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
          if (!link) return;
          const citation = paperSourceCitation(props.document.activePaper, link.href, link.title);
          if (!citation || !paperPdf.pdfSource) return;
          event.preventDefault();
          event.stopPropagation();
          paperPdf.openPdf({ ...citation, id: crypto.randomUUID() });
        },
        // Split mode has its own scroll coordinator and insertion viewport lock;
        // native anchoring would be a competing scroll writer.
        style: props.document.mode === "split" ? { overflowAnchor: "none" } : undefined,
      }}
      viewportRef={attachMarkdownPreviewViewport}
      onPointerDownCapture={activatePrimarySurface}
      onFocusCapture={activatePrimarySurface}
      {...leaveHandlers}
      onMouseUp={props.document.activePaper ? (event) => {
        const selection = window.getSelection();
        const anchor = selection?.anchorNode;
        props.selection.onPaperTextSelect(anchor && event.currentTarget.contains(anchor) ? selection?.toString() ?? "" : "");
      } : undefined}
    >
      {props.document.activePaper && paperFullTextActive && (
        <header className="paper-visual-header">
          <div>
            {paperVisualEligibilityReason && (
              <InlineMessage level="warning" className="paper-visual-eligibility">
                {paperVisualEligibilityReason}
              </InlineMessage>
            )}
            <h1>{props.document.activePaper.title}</h1>
            {paperAuthors && <p>{paperAuthors}</p>}
          </div>
        </header>
      )}
      <Suspense fallback={props.document.activePaper ? null : <MarkdownPreviewLoading />}>
        <DeferredVisualMarkdownEditor
          {...visualEditorProps}
          text={settledPreviewText}
          activePath={props.document.activeFile}
          projectRoot={props.document.activePaper ? undefined : props.preferences.projectRoot}
          optimizeForReading={Boolean(props.document.activePaper)}
          onEligibilityChange={paperFullTextActive ? reportPaperVisualEligibility : undefined}
          // Split previews keep source labels for scroll sync; pure preview
          // spares the labeling cost while typing.
          synchronizeSourceScroll={props.document.mode === "split" || visualReveal !== null}
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
          overleafTrackChangeActions={props.review.overleafTrackChangeActions}
          editorComments={markdownVisualComments}
          onCreateComment={(from, to, body) => createComment(
            activeFile, props.document.source, markdownPreviewStart + from, markdownPreviewStart + to, body,
          )}
          editable={props.document.editorEditable}
          onCaretChange={(row, column) => reportVisualCaret(activeFile, row + markdownPreviewLineOffset + 1, column)}
        />
      </Suspense>
    </ScrollArea>
  );
  const paperPreview = props.document.activePaper ? (
    <PaperReader
      paper={props.document.activePaper}
      activeFile={activeFile}
      pdf={paperPdf}
      markdown={markdownPreview}
      onOpenMarkdownPath={props.document.onOpenMarkdownPath}
      onContextSurfaceActivate={props.selection.onContextSurfaceActivate}
      onTextSelect={props.selection.onPaperTextSelect}
      pdfViewState={{
        read: savedView(activeFile, "pdf"),
        onViewState: (pdf) => props.navigation.onFileViewState?.(activeFile, { pdf }),
      }}
    />
  ) : markdownPreview;
  const bibPreview = bibDocument ? (
    <div className="bib-preview" onPointerDownCapture={activatePrimarySurface} onFocusCapture={activatePrimarySurface}>
      <Suspense fallback={<MarkdownPreviewLoading />}>
        <BibVisualEditor
          path={activeFile}
          source={props.document.source}
          projectRoot={props.preferences.projectRoot}
          editable={props.document.editorEditable}
          papers={props.bibliography.papers ?? []}
          usageRevision={props.bibliography.citationUsageRevision}
          onChange={replaceBibSource}
          onUndo={undoVisualMarkdown}
          onRedo={redoVisualMarkdown}
          onOpenLine={(path, line) => props.navigation.onTexlabGoto(path, line)}
          onOpenPaper={(paper) => props.bibliography.onOpenPaper?.(paper)}
          onOpenUrl={(url) => props.bibliography.onOpenUrl?.(url)}
          onResolveCitation={(query) => props.bibliography.onResolveCitation?.(query) ?? Promise.reject(new Error(t`Looking up references is not available here.`))}
        />
      </Suspense>
    </div>
  ) : null;
  const carriesFigure = (event: DragEvent) => Array.from(event.dataTransfer.types).includes(PROJECT_FIGURE_DRAG_TYPE);
  // The rail mounts with the editor's view: it reads the viewport from the start.
  const railView = activeFile.endsWith(".tex") ? primaryScrollbarView?.deref() ?? null : null;
  const marginView = primaryScrollbarView?.deref() ?? null;
  const editor = (
    <div className="source-workspace" data-tour="document-editor">
      <div className="source-main">
        <div
          className={`source-editor ${
            figureDropActive || props.assets.nativeFigureDropActive ? "figure-drop-active" : ""
          } ${props.assets.fileDropTargetActive ? "file-drop-active" : ""}`}
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
            label={sourceLabel}
            value={props.document.source}
            editable={props.document.editorEditable}
            park={props.preferences.projectRoot ? { root: props.preferences.projectRoot, path: activeFile } : null}
            {...session.host}
          />
          <CodeMirrorScrollbar view={primaryScrollbarView?.deref() ?? null} />
          {railView && (
            <LatexOutlineRail
              view={railView}
              path={activeFile}
              source={settledSource}
              nodes={outlineNodes}
              rootPath={props.navigation.outlineRootPath ?? ""}
              label={t`Outline`}
              pdfUrl={props.pdf.pdfUrl}
              onSelect={onOutlineNavigate}
            />
          )}
          {marginView && props.review.sourceMargin?.(marginView)}
          <ProofreadLayer
            bridge={proofread}
            projectRoot={props.preferences.projectRoot}
            activeFile={activeFile}
            editorKey={editorKey}
            editable={props.document.editorEditable && isLatexSourcePath(activeFile)}
            viewRef={primaryViewRef}
            englishVariant={props.preferences.englishVariant}
            termRules={props.preferences.termRules}
          />
          <AnnotationReviewLayer
            bridge={props.review.annotationRounds.reviewBridge}
            activeFile={activeFile}
            editorKey={editorKey}
            editable={props.document.editorEditable}
            viewRef={primaryViewRef}
            annotations={editorComments}
            rounds={props.review.annotationRounds}
          />
          <EditorCommentCards
            cards={session.commentCards}
            author={commentAuthor}
            onResolve={props.review.onResolveEditorComment}
            onReply={props.review.onPostEditorCommentReply}
          />
          {commentComposer && (
            <AnnotationComposer
              draft={commentComposer}
              view={session.draftView?.deref() ?? null}
              anchorKey={`${activeFile}\n${editorKey}`}
              canRevise
              onChange={(change) => setCommentComposer((current) => current ? { ...current, ...change } : current)}
              onCancel={dismissCommentComposer}
              onSave={saveCommentComposer}
            />
          )}
        </div>
        {activeFile.endsWith(".tex") && (
          <MathPreview source={editorSource} cursor={session.cursorOffset} macros={katexMacros} />
        )}
        <EditorStatusBar
          position={session.position}
          onGotoLine={onGotoLineRequest}
          keymap={editorKeymap}
          vimMode={session.vimMode}
          breadcrumb={breadcrumb}
          path={activeFile}
          onNavigate={onOutlineNavigate}
          hasDiagnostics={buildDiagnostics.length > 0}
          comments={commentsForActiveFile}
          onOpenComments={onOpenEditorComments}
          todoCount={props.status.todoCount}
          onOpenTodos={props.status.onOpenTodos}
          projectWordCount={props.status.projectWordCount}
          selectedText={selectedText}
          source={settledSource}
          saveSlot={props.status.saveSlot}
        />
      </div>
      {tableGeneratorOpen && <TableGeneratorDialog onClose={() => onTableGeneratorOpenChange(false)} target={() => {
        const view = editorViewRef.current;
        if (!view || !props.document.editorEditable || !isLatexSourcePath(activeFile)) return null;
        const source = view.state.doc.toString();
        const owner = { root: props.preferences.projectRoot, path: activeFile };
        return { source, cursor: view.state.selection.main.head, apply: (from, to, insert) => {
          if (editorViewRef.current !== view || latestRef.current.preferences.projectRoot !== owner.root
            || latestRef.current.document.activeFile !== owner.path || !latestRef.current.document.editorEditable
            || view.state.doc.toString() !== source) return false;
          editAndFocus(view, { changes: { from, to, insert }, selection: { anchor: from + insert.indexOf("\\begin") } });
          return true;
        } };
      }} />}
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
          canProofread={isLatexSourcePath(activeFile) && Boolean(props.preferences.projectRoot)}
          highlight={selectionToolbar.highlight}
          sample={selectedText}
          documentColors={documentColors}
          commentOnly={activeFile.toLocaleLowerCase().endsWith(".md") || !props.document.editorEditable}
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
      props.document.onEditorLeave();
    };
    const activatePdf = () => {
      props.selection.onContextSurfaceActivate("pdf");
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
        {props.pdf.pdfTop}
        <ChunkGate chunk={loadPdfPreviewModule} fallback={<PdfPreviewLoading />}><Suspense fallback={<PdfPreviewLoading />}>
          {/* One viewer per project, across its TeX files: it restores the place it mounts with. */}
          {withViewState(previewPath, "pdf", `project-pdf:${props.preferences.projectRoot}`, (binding) => (
            <PdfPreview
              url={props.pdf.pdfUrl}
              pdfBytes={props.pdf.pdfBytes}
              citations={props.bibliography.citations}
              canOpenCitation={props.bibliography.canOpenCitation}
              onOpenCitation={props.bibliography.onOpenCitation}
              syncTarget={props.pdf.pdfSyncTarget}
              canForwardSync={props.pdf.canForwardSync}
              locatingPdf={props.pdf.locatingPdf}
              onForwardSync={props.pdf.onForwardSync}
              loadErrorHint={t`Try building the project again`}
              onBuild={props.pdf.onBuildProject}
              building={props.pdf.building}
              buildShortcut={props.pdf.buildShortcut}
              // Under Trellis a reverse jump always has a file panel to land in.
              onSource={props.pdf.onPdfSource}
              onTextSelect={props.selection.onPdfTextSelect}
              annotations={editorComments}
              annotationRounds={props.review.annotationRounds}
              onNumPages={props.pdf.onPdfPageCount}
              onPageChange={props.pdf.onPdfPageChange}
              {...binding}
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
          ))}
        </Suspense></ChunkGate>
      </div>
    );
  };
  const preview = props.document.activeAsset ? assetPreview(props.document.activeAsset)
    : bibDocument ? bibPreview
    : markdownDocument ? paperPreview
      : htmlDocument ? htmlPreview(activeFile, props.document.source, props.document.mode === "split" ? primaryScrollbarView?.deref() ?? null : null)
        : projectPdfPreview(activeFile);
  // The file panel shows the document the way its kind is edited; LaTeX
  // and other source files never split here, the PDF is its own panel.
  const { editorHost, pdfHost, editorHibernated, hibernatedPlaceholder } = props.hosts;
  const readable = Boolean(props.document.activePaper) || markdownDocument || htmlDocument || bibDocument;
  const fileContent = props.document.activeAsset ? assetPreview(props.document.activeAsset)
    : primaryKind === "presentation" ? null
    : primaryKind ? (editorHibernated ? hibernatedPlaceholder : structuredEditor(primaryKind))
      : paperPdf.pdfView ? paperPreview
        : !readable || props.document.mode === "source" ? editor
          : bibUnreadable ? (
            <div className="bib-source-fallback">
              <InlineMessage level="warning">
                {t`This bibliography can't be shown as a list until it reads as BibTeX.`} {bibUnreadable}
              </InlineMessage>
              {editor}
            </div>
          )
          : props.document.mode === "pdf" ? preview
            : (
        <div
          ref={splitRef}
          className="split-canvas"
          data-tour="split-workspace"
          data-minimum-workspace-width={splitMinimums.source + splitMinimums.preview + 1}
          style={{
            gridTemplateColumns: splitGridTemplate(splitMinimums),
            "--split-ratio": splitRatio,
          } as CSSProperties}
        >
          {editor}
          {resizer(
            props.document.activeAsset
              ? t`Resize editor and asset preview`
              : markdownDocument
                ? t`Resize editor and Markdown preview`
                : bibDocument ? t`Resize editor and reference list`
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
      <OpenSlideDeckPool
        shared={deckSettings}
        active={activeDeck}
        openPaths={props.document.openPaths}
        hosts={props.hosts.decks}
        getFileViewState={props.navigation.getFileViewState}
        onFileViewState={props.navigation.onFileViewState}
      />
    </>
  );

}

/** The highlight colors a source already uses, most used first, for the custom picker's "In this document". */
function documentHighlightColors(source: string | undefined): string[] {
  if (!source) return [];
  const counts = new Map<string, number>();
  for (const highlight of latexHighlights(source)) {
    const hex = highlight.color?.toUpperCase();
    if (hex && /^#[0-9A-F]{6}$/.test(hex)) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
}
