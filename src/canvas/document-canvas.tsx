import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useLingui } from "@lingui/react/macro";
import { CodeMirrorHost as CodeMirror } from "../editor/codemirror-host";
import { redo as redoCodeMirror, undo as undoCodeMirror } from "@codemirror/commands";
import { forceLinting as refreshLint, linter } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
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
import {
  ArrowLeft,
  Columns2,
  ExternalLink,
  FileCode2,
  FileText,
  Image,
  ListTodo,
  MessageSquareText,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  countWords,
  latexEditorExtensions,
  latexLanguageOptions,
  textEditorExtensions,
  renameEnvironmentAt,
  textStats,
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
import { useNonPassiveWheel } from "../hooks/use-non-passive-wheel";
import { Textarea } from "../components/ui/textarea";
import { Tip } from "../components/icon-tip";
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
  type EditorComment,
  type EditorCommentLocalization,
} from "../editor/comments/editor-comments";
import {
  clamp,
  loadSplitRatio,
  persistSplitRatio,
  loadColumnsPdfRatio,
  persistColumnsPdfRatio,
} from "../settings/app-settings";
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
import { InfinityLoader } from "../components/ui/activity-icons";
import { TableGeneratorDialog } from "../editor/insert/table-generator-dialog";
import type { PdfSyncTarget } from "../pdf/pdf-viewer";
import { pdfBase64ToBytes, pdfBytesToObjectUrl, utf8ToBase64 } from "../pdf/pdf-bytes";
import { SPLIT_PDF_MIN_WIDTH, SPLIT_SOURCE_MIN_WIDTH } from "../app/window-layout";
import { notifyError } from "../telemetry/app-notify";
import type {
  WordCount,
  EditorViewState,
  FileViewState,
  ImageFileViewState,
  ScrollFileViewState,
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
  isPreviewableSourceFilePath,
  markdownFrontmatterEnd,
  PROJECT_FIGURE_DRAG_TYPE,
} from "../app-utils";
import {
  calculateVerticalScrollGeometry,
  EXTERNAL_SCROLLBAR_TRACK_INSET,
} from "../components/ui/external-scrollbar-geometry";
import type { AgentHostSurface } from "../agent/agent-host-context";
import type { CollabPeer, EditorCollabSession } from "../collab/collab-session";
import { peerCaretOffsetsV2, publishCollabCursorV2 } from "../collab/collab-session";
import { collabEditorExtensions } from "../collab/collab-editor";
import { isSpreadsheetPath } from "../editor/spreadsheet/spreadsheet-types";
import {
  EMPTY_EXTENSIONS,
  immediateTextLanguageExtensions,
  loadTextLanguageExtensions,
} from "../editor/editor-languages";
import {
  isVisualMarkdownEditorWarmed,
  markVisualMarkdownEditorWarmed,
  loadBoardEditorModule,
  loadPdfPreviewModule,
  loadSpreadsheetEditorModule,
  loadVisualMarkdownEditorModule,
} from "./canvas-lazy-modules";

const PdfPreview = lazy(() => loadPdfPreviewModule().then((module) => ({
  default: module.PdfPreview,
})));
const VisualMarkdownEditor = lazy(() => loadVisualMarkdownEditorModule().then((module) => ({
  default: module.VisualMarkdownEditor,
})));
const BoardEditor = lazy(() => loadBoardEditorModule().then((module) => ({
  default: module.BoardEditor,
})));
const SpreadsheetEditor = lazy(() => loadSpreadsheetEditorModule().then((module) => ({
  default: module.SpreadsheetEditor,
})));

function DeferredVisualMarkdownEditor(props: ComponentProps<typeof VisualMarkdownEditor>) {
  const { t } = useLingui();
  const [ready, setReady] = useState(isVisualMarkdownEditorWarmed);
  useEffect(() => {
    if (ready) return;
    const frame = window.requestAnimationFrame(() => setReady(true));
    return () => window.cancelAnimationFrame(frame);
  }, [ready]);
  useEffect(() => {
    if (ready) markVisualMarkdownEditorWarmed();
  }, [ready]);
  if (!ready) {
    return <div className="visual-markdown-preparing" aria-busy="true" aria-label={t`Preparing Markdown editor`} />;
  }
  return <VisualMarkdownEditor {...props} />;
}

const HTML_PREVIEW_OPEN_EXTERNAL = "lattice:html-preview-open-external";
const HTML_PREVIEW_SCROLL = "lattice:html-preview-scroll";
const HTML_PREVIEW_SET_SCROLL_TOP = "lattice:html-preview-set-scroll-top";

const HTML_PREVIEW_SCROLLBAR_STYLES = `
@media (pointer: fine) {
  html, body { scrollbar-width: none; }
  html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; width: 0; height: 0; }
}`;

function HtmlPreview({
  path,
  source,
  initialViewState,
  onViewState,
}: {
  path: string;
  source: string;
  initialViewState?: ScrollFileViewState;
  onViewState?: (state: ScrollFileViewState) => void;
}) {
  const { t } = useLingui();
  const [previewSource, setPreviewSource] = useState(source);
  const [scrollMetrics, setScrollMetrics] = useState({
    clientHeight: 0,
    scrollHeight: 0,
    scrollTop: 0,
  });
  const scrollMetricsRef = useRef(scrollMetrics);
  const [scrollbarHovering, setScrollbarHovering] = useState(false);
  const [scrolling, setScrolling] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scrollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onViewStateRef = useRef(onViewState);
  const [initialScrollTop] = useState(initialViewState?.scrollTop ?? 0);
  // Republishing srcDoc reloads the frame, which drops the reader back to the
  // top of the document. Editing an HTML file therefore threw away the reading
  // position every time typing paused. Carry it across the reload.
  const restoreScrollTopRef = useRef(initialScrollTop);
  const awaitingInitialRestoreRef = useRef(initialScrollTop > 0);
  const dragRef = useRef<{
    pointerId: number;
    scrollPerPixel: number;
    startClientY: number;
    startScrollTop: number;
  } | null>(null);
  const scrollbarRef = useRef<HTMLDivElement | null>(null);
  const scrollGeometry = useMemo(
    () => calculateVerticalScrollGeometry(scrollMetrics),
    [scrollMetrics],
  );

  useLayoutEffect(() => {
    scrollMetricsRef.current = scrollMetrics;
  }, [scrollMetrics]);
  useLayoutEffect(() => {
    onViewStateRef.current = onViewState;
  }, [onViewState]);

  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewSource(source), 180);
    return () => window.clearTimeout(timer);
  }, [source]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || !("type" in data)) return;
      if (
        data.type === HTML_PREVIEW_SCROLL
        && "clientHeight" in data
        && "scrollHeight" in data
        && "scrollTop" in data
        && typeof data.clientHeight === "number"
        && typeof data.scrollHeight === "number"
        && typeof data.scrollTop === "number"
      ) {
        setScrollMetrics({
          clientHeight: data.clientHeight,
          scrollHeight: data.scrollHeight,
          scrollTop: data.scrollTop,
        });
        // A reloaded frame reports 0 before the restore lands; keep the last
        // real position so the restore has something to aim at.
        if (data.scrollTop > 0 || data.scrollHeight <= data.clientHeight) {
          awaitingInitialRestoreRef.current = false;
        }
        if (!awaitingInitialRestoreRef.current) {
          restoreScrollTopRef.current = data.scrollTop;
          onViewStateRef.current?.({
            scrollTop: data.scrollTop,
            scrollRange: Math.max(0, data.scrollHeight - data.clientHeight),
          });
        }
        setScrolling(true);
        if (scrollingTimerRef.current != null) clearTimeout(scrollingTimerRef.current);
        scrollingTimerRef.current = setTimeout(() => {
          scrollingTimerRef.current = null;
          setScrolling(false);
        }, 500);
        return;
      }
      if (data.type !== HTML_PREVIEW_OPEN_EXTERNAL || !("href" in data) || typeof data.href !== "string") return;
      let url: URL;
      try {
        url = new URL(data.href);
      } catch {
        return;
      }
      if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
      void openUrl(url).catch(() => undefined);
    };
    window.addEventListener("message", handleMessage);
    return () => {
      window.removeEventListener("message", handleMessage);
      if (scrollingTimerRef.current != null) clearTimeout(scrollingTimerRef.current);
      const metrics = scrollMetricsRef.current;
      onViewStateRef.current?.({
        scrollTop: restoreScrollTopRef.current,
        scrollRange: Math.max(0, metrics.scrollHeight - metrics.clientHeight),
      });
    };
  }, []);

  const html = useMemo(() => {
    const document = new DOMParser().parseFromString(previewSource, "text/html");
    for (const base of document.querySelectorAll("base")) base.remove();
    const isolatedBase = document.createElement("base");
    isolatedBase.href = "about:blank";
    document.head.prepend(isolatedBase);
    const scrollbarStyles = document.createElement("style");
    scrollbarStyles.dataset.latticePreview = "scrollbar";
    scrollbarStyles.textContent = HTML_PREVIEW_SCROLLBAR_STYLES;
    document.head.append(scrollbarStyles);
    for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      const href = link.getAttribute("href")?.trim() ?? "";
      if (/^(?:#|\/\/|[a-z][a-z0-9+.-]*:)/i.test(href)) continue;
      link.removeAttribute("href");
      if (!link.title) link.title = t`Relative project links are unavailable in this preview`;
    }
    const fragmentNavigation = document.createElement("script");
    fragmentNavigation.dataset.latticePreview = "fragment-navigation";
    fragmentNavigation.textContent = `document.addEventListener("click",(event)=>{const link=event.target instanceof Element?event.target.closest("a[href]"):null;if(!link||event.defaultPrevented||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;const href=link.getAttribute("href");if(!href)return;if(/^(?:https?:|mailto:)/i.test(href)){event.preventDefault();parent.postMessage({type:${JSON.stringify(HTML_PREVIEW_OPEN_EXTERNAL)},href},"*");return}if(href==="#"||!href.startsWith("#"))return;let id;try{id=decodeURIComponent(href.slice(1))}catch{return}const target=document.getElementById(id);if(!target)return;event.preventDefault();target.scrollIntoView()});`;
    document.body.append(fragmentNavigation);
    const scrollbarBridge = document.createElement("script");
    scrollbarBridge.dataset.latticePreview = "scrollbar-bridge";
    scrollbarBridge.textContent = `(()=>{const type=${JSON.stringify(HTML_PREVIEW_SCROLL)};const setType=${JSON.stringify(HTML_PREVIEW_SET_SCROLL_TOP)};let frame=0;const send=()=>{frame=0;const root=document.scrollingElement||document.documentElement;parent.postMessage({type,clientHeight:root.clientHeight,scrollHeight:root.scrollHeight,scrollTop:root.scrollTop},"*")};const schedule=()=>{if(!frame)frame=requestAnimationFrame(send)};window.addEventListener("scroll",schedule,{passive:true});window.addEventListener("resize",schedule,{passive:true});window.addEventListener("message",(event)=>{if(event.source!==parent||!event.data||event.data.type!==setType||typeof event.data.scrollTop!=="number")return;const root=document.scrollingElement||document.documentElement;root.scrollTop=event.data.scrollTop;schedule()});new ResizeObserver(schedule).observe(document.documentElement);new ResizeObserver(schedule).observe(document.body);new MutationObserver(schedule).observe(document.documentElement,{attributes:true,childList:true,subtree:true});schedule()})();`;
    document.body.append(scrollbarBridge);
    return `<!doctype html>${document.documentElement.outerHTML}`;
  }, [previewSource, t]);

  const setScrollTop = (scrollTop: number) => {
    frameRef.current?.contentWindow?.postMessage({
      type: HTML_PREVIEW_SET_SCROLL_TOP,
      scrollTop,
    }, "*");
  };

  const scrollToThumbOffset = (thumbOffset: number) => {
    const availableTrack = Math.max(
      0,
      scrollGeometry.height - EXTERNAL_SCROLLBAR_TRACK_INSET * 2,
    );
    const travel = Math.max(0, availableTrack - scrollGeometry.thumbHeight);
    if (travel <= 0) return;
    setScrollTop(
      scrollGeometry.maxScrollTop
        * (Math.min(Math.max(0, thumbOffset), travel) / travel),
    );
  };

  useNonPassiveWheel(scrollbarRef, (event) => {
    if (!scrollGeometry.overflow) return;
    event.preventDefault();
    setScrollTop(scrollGeometry.scrollTop + event.deltaY);
  });

  return (
    <div className="html-preview" data-tour="document-preview">
      <iframe
        ref={frameRef}
        className="html-preview-frame"
        title={t({ message: `HTML preview for ${{ path }}` })}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        srcDoc={html}
        onLoad={() => {
          if (restoreScrollTopRef.current > 0) setScrollTop(restoreScrollTopRef.current);
        }}
      />
      <div
        ref={scrollbarRef}
        aria-hidden="true"
        className="lattice-scrollbar html-preview-scrollbar"
        data-hovering={scrollbarHovering ? "" : undefined}
        data-orientation="vertical"
        data-overflow-y-end={scrollGeometry.overflow && scrollGeometry.scrollTop < scrollGeometry.maxScrollTop ? "" : undefined}
        data-overflow-y-start={scrollGeometry.overflow && scrollGeometry.scrollTop > 0 ? "" : undefined}
        data-scrolling={scrolling ? "" : undefined}
        onPointerCancel={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          setScrolling(false);
        }}
        onPointerDown={(event) => {
          if (!scrollGeometry.overflow) return;
          event.preventDefault();
          const availableTrack = Math.max(0, scrollGeometry.height - EXTERNAL_SCROLLBAR_TRACK_INSET * 2);
          const travel = Math.max(0, availableTrack - scrollGeometry.thumbHeight);
          const isThumb = event.target instanceof HTMLElement && event.target.dataset.slot === "scroll-area-thumb";
          if (!isThumb) {
            const rect = event.currentTarget.getBoundingClientRect();
            scrollToThumbOffset(
              event.clientY - rect.top - EXTERNAL_SCROLLBAR_TRACK_INSET - scrollGeometry.thumbHeight / 2,
            );
          }
          dragRef.current = {
            pointerId: event.pointerId,
            scrollPerPixel: travel > 0 ? scrollGeometry.maxScrollTop / travel : 0,
            startClientY: event.clientY,
            startScrollTop: scrollGeometry.scrollTop,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          setScrolling(true);
        }}
        onPointerEnter={() => setScrollbarHovering(true)}
        onPointerLeave={() => {
          setScrollbarHovering(false);
          if (!dragRef.current) setScrolling(false);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setScrollTop(
            drag.startScrollTop + (event.clientY - drag.startClientY) * drag.scrollPerPixel,
          );
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          setScrolling(false);
        }}
        style={{ height: scrollGeometry.height }}
      >
        <div
          className="lattice-scrollbar-thumb"
          data-slot="scroll-area-thumb"
          style={{
            height: scrollGeometry.thumbHeight,
            transform: `translate3d(-2px, ${scrollGeometry.thumbOffset}px, 0)`,
          }}
        />
      </div>
    </div>
  );
}

function minimalTextChange(previous: string, next: string, offset: number) {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < next.length - prefix
    && previous[previous.length - suffix - 1] === next[next.length - suffix - 1]
  ) {
    suffix += 1;
  }
  return {
    from: offset + prefix,
    to: offset + previous.length - suffix,
    insert: next.slice(prefix, next.length - suffix),
  };
}

function PdfPreviewLoading() {
  const { t } = useLingui();
  return (
    <div className="pdf-preview">
      <div className="pdf-placeholder">
        <FileText size={28} />
        <p>{t`Preparing PDF preview…`}</p>
      </div>
    </div>
  );
}

function MarkdownPreviewLoading() {
  const { t } = useLingui();
  return (
    <div className="markdown-preview-loading" role="status" aria-live="polite">
      <InfinityLoader size={20} />
      <span>{t`Preparing preview…`}</span>
    </div>
  );
}

type PaperPdfView =
  | { arxivId: string; status: "loading"; initialPage: number }
  | {
      arxivId: string;
      status: "ready";
      url: string;
      objectUrl: string | null;
      bytes: ArrayBuffer | null;
      initialPage: number;
    };

function normalizedArxivId(value: string): string {
  const candidate = value.trim();
  return /^(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?$/i.test(candidate)
    ? candidate
    : "";
}

function encodedArxivPath(arxivId: string): string {
  return arxivId.split("/").map(encodeURIComponent).join("/");
}

function arxivPdfUrl(arxivId: string): string {
  return `https://arxiv.org/pdf/${encodedArxivPath(arxivId)}`;
}

function paperBrowserUrl(paper: PaperSummary): string | null {
  const arxivId = normalizedArxivId(paper.arxivId);
  if (arxivId) return arxivPdfUrl(arxivId);
  if (paper.url) {
    try {
      const parsed = new URL(paper.url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") return parsed.href;
    } catch {
      // Do not hand a malformed or unsafe bibliography URL to the OS opener.
    }
  }
  return null;
}

function HtmlPreviewLoading() {
  const { t } = useLingui();
  return (
    <div className="html-preview">
      <div className="pdf-placeholder">
        <FileCode2 size={28} />
        <p>{t`Preparing HTML preview…`}</p>
      </div>
    </div>
  );
}

/**
 * Trailing edge of the source → preview handoff.
 *
 * Handing the preview a new document costs a full Markdown parse plus a
 * serialize round trip, so publishing every source keystroke makes typing in
 * split mode scale with document length (~90ms per parse at 40KB, several
 * times that once reconciliation runs). External edits — the source pane, a
 * collaborator, an agent write — are therefore published on the same idle
 * budget the preview already spends on the opposite direction.
 *
 * `immediate` bypasses the wait for documents the preview itself just wrote.
 * Settling those would leave the preview's accepted document behind the real
 * source for the length of the budget, and an edit landing in that window is
 * rejected against the stale text and surfaces as a spurious conflict draft.
 */
function useSettledPreviewText(
  text: string,
  immediate: boolean,
  resetKey: string,
  idleMs: number,
  maxMs: number,
): string {
  const [settled, setSettled] = useState(text);
  const [settledKey, setSettledKey] = useState(resetKey);
  const latestTextRef = useRef(text);
  const maxTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Opening another file, and the preview's own echo, land in the same commit
  // as the source they came from. Adjusting state during render re-runs this
  // component before the commit, so no frame can observe the stale document.
  if (settledKey !== resetKey || (immediate && settled !== text)) {
    setSettledKey(resetKey);
    setSettled(text);
  }

  useEffect(() => {
    // Refreshed here rather than during render so the max timer below, which
    // outlives the commit that armed it, publishes the newest document.
    latestTextRef.current = text;
    if (settled === text) {
      if (maxTimerRef.current) {
        clearTimeout(maxTimerRef.current);
        maxTimerRef.current = null;
      }
      return;
    }
    const publish = () => {
      if (maxTimerRef.current) {
        clearTimeout(maxTimerRef.current);
        maxTimerRef.current = null;
      }
      setSettled(latestTextRef.current);
    };
    // A max timer keeps continuous typing from starving the preview entirely;
    // it is armed once per burst and cleared when the preview catches up.
    if (maxTimerRef.current == null) maxTimerRef.current = setTimeout(publish, maxMs);
    const idle = setTimeout(publish, idleMs);
    return () => clearTimeout(idle);
  }, [idleMs, maxMs, settled, text]);

  useEffect(() => () => {
    if (maxTimerRef.current) clearTimeout(maxTimerRef.current);
  }, []);

  return settled;
}

function SecondaryMarkdownPreview(props: {
  path: string;
  source: string;
  onChange: (next: string) => void;
  onFlushPendingChange: (flush: (() => boolean) | null) => void;
  onEditSource: () => void;
  onOpenProjectPath: (path: string) => void;
  workspaceIndex?: MarkdownWorkspaceIndex | null;
  papers?: PaperSummary[];
  macros: Record<string, string>;
  onImportAsset?: (file: File) => Promise<string | null>;
  onLoadAsset: (path: string) => Promise<string | null>;
  editable: boolean;
  onCaretChange: (row: number, column: number) => void;
  onSelectionMarkdown: (value: string) => void;
}) {
  const sourceRef = useRef(props.source);
  const onChangeRef = useRef(props.onChange);
  const [visualEchoSource, setVisualEchoSource] = useState<string | null>(null);
  const historyRef = useRef<{ undo: string[]; redo: string[] }>({ undo: [], redo: [] });
  useLayoutEffect(() => {
    sourceRef.current = props.source;
    onChangeRef.current = props.onChange;
  }, [props.onChange, props.source]);

  const previewStart = markdownFrontmatterEnd(props.source);
  const previewText = props.source.slice(previewStart);
  const syncPolicy = markdownPreviewSyncPolicy(previewText.length);
  const settledText = useSettledPreviewText(
    previewText,
    props.source === visualEchoSource,
    props.path,
    syncPolicy.publicationIdleMs,
    syncPolicy.publicationMaxMs,
  );
  const lineOffset = props.source.slice(0, previewStart).split("\n").length - 1;

  const publishSource = useCallback((nextSource: string) => {
    sourceRef.current = nextSource;
    setVisualEchoSource(nextSource);
    onChangeRef.current(nextSource);
  }, []);
  const replaceMarkdown = useCallback((nextBody: string, expectedBody: string) => {
    const source = sourceRef.current;
    const from = markdownFrontmatterEnd(source);
    if (source.slice(from) !== expectedBody) return false;
    const insert = expectedBody.includes("\r\n")
      ? nextBody.replace(/\r?\n/g, "\r\n")
      : nextBody;
    const prefix = source.slice(0, from);
    const separator = expectedBody === "" && insert !== "" && prefix !== "" && !/\r?\n$/.test(prefix)
      ? (source.includes("\r\n") ? "\r\n" : "\n")
      : "";
    const nextSource = `${prefix}${separator}${insert}`;
    historyRef.current.undo.push(source);
    historyRef.current.redo = [];
    publishSource(nextSource);
    return true;
  }, [publishSource]);
  const undo = useCallback(() => {
    const previous = historyRef.current.undo.pop();
    if (previous === undefined) return false;
    historyRef.current.redo.push(sourceRef.current);
    publishSource(previous);
    return true;
  }, [publishSource]);
  const redo = useCallback(() => {
    const next = historyRef.current.redo.pop();
    if (next === undefined) return false;
    historyRef.current.undo.push(sourceRef.current);
    publishSource(next);
    return true;
  }, [publishSource]);

  return (
    <ScrollArea
      className="markdown-preview secondary-markdown-preview"
      orientation="vertical"
      fadeEdges={false}
      contentClassName="markdown-preview-content"
      viewportClassName="editor-doc-scroll"
      viewportProps={{ "data-testid": "editor-scroll-container" }}
    >
      <Suspense fallback={<MarkdownPreviewLoading />}>
        <DeferredVisualMarkdownEditor
          text={settledText}
          activePath={props.path}
          synchronizeSourceScroll={false}
          onOpenProjectPath={props.onOpenProjectPath}
          workspaceIndex={props.workspaceIndex}
          papers={props.papers}
          macros={props.macros}
          onChangeMarkdown={replaceMarkdown}
          onFlushPendingChange={props.onFlushPendingChange}
          onUndo={undo}
          onRedo={redo}
          onEditSource={props.onEditSource}
          onViewInSource={props.onEditSource}
          onImportAsset={props.onImportAsset}
          onLoadAsset={props.onLoadAsset}
          editable={props.editable}
          onCaretChange={(row, column) => props.onCaretChange(row + lineOffset, column)}
          onSelectionMarkdown={props.onSelectionMarkdown}
        />
      </Suspense>
    </ScrollArea>
  );
}

function interpolateScrollAnchors(
  value: number,
  pairs: Array<{ from: number; to: number }>,
  fromMin: number,
  fromMax: number,
  toMin: number,
  toMax: number,
) {
  const bound = (target: number, key: "from" | "to", upper: boolean, low = 0, high = pairs.length) => {
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      const candidate = pairs[middle][key];
      if (candidate < target || (upper && candidate === target)) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const firstInterior = Math.max(
    bound(fromMin, "from", true),
    bound(toMin, "to", true),
  );
  const afterInterior = Math.min(
    bound(fromMax, "from", false, firstInterior),
    bound(toMax, "to", false, firstInterior),
  );
  const insertion = bound(value, "from", false, firstInterior, afterInterior);
  const lower = insertion > firstInterior
    ? pairs[insertion - 1]
    : { from: fromMin, to: toMin };
  const upper = insertion < afterInterior
    ? pairs[insertion]
    : { from: fromMax, to: toMax };
  const span = upper.from - lower.from;
  const progress = span > 0 ? (value - lower.from) / span : 0;
  return clamp(lower.to + progress * (upper.to - lower.to), toMin, toMax);
}

type ViewportSnapshot = {
  scrollTop: number;
  scrollRange: number;
};

type PreviewViewportSnapshot = ViewportSnapshot & {
  blockIndex?: number;
  blockViewportTop?: number;
  blockSourceOffset?: number;
  chunkId?: string;
  chunkBlockIndex?: number;
};

type MarkdownModeViewportHandoff = {
  path: string;
  mode: CanvasMode;
  source?: ViewportSnapshot;
  preview?: PreviewViewportSnapshot;
};

function captureViewport(viewport: HTMLElement): ViewportSnapshot {
  return {
    scrollTop: viewport.scrollTop,
    scrollRange: Math.max(0, viewport.scrollHeight - viewport.clientHeight),
  };
}

function previewViewportBlocks(viewport: HTMLElement): HTMLElement[] {
  return Array.from(viewport.querySelectorAll<HTMLElement>(".ProseMirror")).flatMap(
    (proseMirror) => Array.from(proseMirror.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    ),
  );
}

function capturePreviewViewport(viewport: HTMLElement): PreviewViewportSnapshot {
  const snapshot: PreviewViewportSnapshot = captureViewport(viewport);
  const blocks = previewViewportBlocks(viewport);
  const viewportRect = viewport.getBoundingClientRect();
  const blockIndex = blocks.findIndex((block) => (
    block.getBoundingClientRect().bottom > viewportRect.top
  ));
  const block = blocks[blockIndex];
  if (!block) return snapshot;
  const sourceOffset = Number(block.dataset.sourceOffset);
  const chunk = block.closest<HTMLElement>("[data-visual-chunk-id]");
  const chunkBlocks = chunk
    ? Array.from(chunk.querySelector<HTMLElement>(".ProseMirror")?.children ?? [])
    : [];
  return {
    ...snapshot,
    blockIndex,
    blockViewportTop: block.getBoundingClientRect().top - viewportRect.top,
    ...(Number.isFinite(sourceOffset) ? { blockSourceOffset: sourceOffset } : {}),
    ...(chunk?.dataset.visualChunkId ? {
      chunkId: chunk.dataset.visualChunkId,
      chunkBlockIndex: chunkBlocks.indexOf(block),
    } : {}),
  };
}

function restoreViewport(
  viewport: HTMLElement,
  snapshot: ViewportSnapshot,
): boolean {
  const targetRange = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  viewport.scrollTop = snapshot.scrollRange > 0 && targetRange > 0
    ? (snapshot.scrollTop / snapshot.scrollRange) * targetRange
    : snapshot.scrollTop;
  return snapshot.scrollTop <= 0 || snapshot.scrollRange <= 0 || targetRange > 0;
}

function restorePreviewViewport(
  viewport: HTMLElement,
  snapshot: PreviewViewportSnapshot,
): boolean {
  const viewportReady = restoreViewport(viewport, snapshot);
  if (snapshot.blockIndex == null || snapshot.blockViewportTop == null) return viewportReady;
  const blocks = previewViewportBlocks(viewport);
  let block = snapshot.blockSourceOffset == null
    ? null
    : blocks.find((candidate) => Number(candidate.dataset.sourceOffset) === snapshot.blockSourceOffset) ?? null;
  if (!block && snapshot.chunkId != null && snapshot.chunkBlockIndex != null) {
    const chunk = Array.from(
      viewport.querySelectorAll<HTMLElement>("[data-visual-chunk-id]"),
    ).find((candidate) => candidate.dataset.visualChunkId === snapshot.chunkId);
    const candidate = chunk?.querySelector<HTMLElement>(".ProseMirror")
      ?.children[snapshot.chunkBlockIndex];
    if (candidate instanceof HTMLElement) block = candidate;
  }
  if (!block && snapshot.chunkId != null) return false;
  block ??= blocks[snapshot.blockIndex] ?? null;
  if (!block) return false;
  const blockViewportTop = block.getBoundingClientRect().top
    - viewport.getBoundingClientRect().top;
  if (Number.isFinite(blockViewportTop)) {
    viewport.scrollTop += blockViewportTop - snapshot.blockViewportTop;
  }
  return viewportReady;
}

function isLatexSourcePath(path: string): boolean {
  return /\.(?:tex|sty|cls)$/i.test(path);
}

function useTextLanguageExtensions(path: string): Extension[] {
  const [loaded, setLoaded] = useState<{ path: string; extensions: Extension[] }>(() => ({
    path,
    extensions: immediateTextLanguageExtensions(path),
  }));

  useEffect(() => {
    // Only the asynchronous resolution needs to reach React. Re-seeding state
    // with the synchronous answer committed one extra render of the whole app
    // per file switch, and handed CodeMirror an equal-but-new extension array
    // that made it reconfigure the view it had just created.
    if (!path || immediateTextLanguageExtensions(path).length > 0) return;
    let disposed = false;
    void loadTextLanguageExtensions(path).then((extensions) => {
      if (!disposed) setLoaded({ path, extensions });
    });
    return () => { disposed = true; };
  }, [path]);

  return loaded.path === path ? loaded.extensions : immediateTextLanguageExtensions(path);
}

type VimGetCM = typeof import("@replit/codemirror-vim").getCM;

function readVimMode(cm: ReturnType<VimGetCM>): string {
  const state = cm?.state.vim;
  if (state?.insertMode) return "insert";
  return state?.mode ?? "normal";
}

function vimModeExtension(getCM: VimGetCM, onModeChange: (mode: string) => void): Extension {
  return ViewPlugin.fromClass(class {
    private readonly cm: ReturnType<VimGetCM>;
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

// Hoisted loaders: inline `import()` expressions inside a hook make the React
// Compiler bail out of it (the same pattern App.tsx uses for lazy panels).
const loadVimKeymapExtensions = (onVimModeChange: (mode: string) => void) =>
  import("@replit/codemirror-vim").then((module) => [
    module.vim({ status: false }),
    vimModeExtension(module.getCM, onVimModeChange),
  ]);
const loadEmacsKeymapExtensions = () =>
  import("@replit/codemirror-emacs").then((module) => [module.emacs()]);

/**
 * Vim/Emacs keymaps, loaded on demand.
 *
 * `onVimModeChange` must be referentially stable — the callers pass
 * `reportPrimaryVimMode`/`reportSecondaryVimMode`, which are `useCallback`s for
 * this reason. The effect below lists it as a dependency and unconditionally
 * calls `setLoaded` with a freshly allocated object, so an inline lambda at the
 * call site turns this into an infinite render loop rather than one extra
 * render. This hook is compiled by the React Compiler (DocumentCanvas itself is
 * not), so nothing else absorbs the mistake.
 */
function useOptionalKeymapExtensions(
  keymap: EditorKeymap,
  onVimModeChange: (mode: string) => void,
): Extension[] {
  const [loaded, setLoaded] = useState<{ keymap: EditorKeymap; extensions: Extension[] }>({
    keymap: "default",
    extensions: EMPTY_EXTENSIONS,
  });

  useEffect(() => {
    let disposed = false;
    if (keymap === "default") {
      setLoaded({ keymap, extensions: EMPTY_EXTENSIONS });
      return () => { disposed = true; };
    }

    const loading = keymap === "vim"
      ? loadVimKeymapExtensions(onVimModeChange)
      : loadEmacsKeymapExtensions();
    void loading.then((extensions) => {
      if (!disposed) setLoaded({ keymap, extensions });
    });
    return () => { disposed = true; };
  }, [keymap, onVimModeChange]);

  return loaded.keymap === keymap ? loaded.extensions : EMPTY_EXTENSIONS;
}

export function DocumentCanvas(props: {
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
  pdfUrl: string | null;
  pdfBase64: string | null;
  pdfBytes?: ArrayBuffer | null;
  pdfTop?: ReactNode;
  activePaper: PaperSummary | null;
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
    collabSession,
    collabReady,
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
    getFileViewState,
    onFileViewState,
  } = props;
  const { i18n, t } = useLingui();
  const editorCommentLocalizationRef = useRef<EditorCommentLocalization>({
    locale: i18n.locale,
    anonymous: t`Anonymous`,
    noCommentText: t`(no comment text)`,
    reopen: t`Reopen`,
    resolve: t`Resolve comment`,
    reply: t`Reply`,
  });
  useEffect(() => {
    editorCommentLocalizationRef.current = {
      locale: i18n.locale,
      anonymous: t`Anonymous`,
      noCommentText: t`(no comment text)`,
      reopen: t`Reopen`,
      resolve: t`Resolve comment`,
      reply: t`Reply`,
    };
  }, [i18n.locale, t]);
  const primaryVisualMarkdownFlushRef = useRef<(() => boolean) | null>(null);
  const secondaryVisualMarkdownFlushRef = useRef<(() => boolean) | null>(null);
  const registerPrimaryVisualMarkdownFlush = useCallback((flush: (() => boolean) | null) => {
    primaryVisualMarkdownFlushRef.current = flush;
  }, []);
  const registerSecondaryVisualMarkdownFlush = useCallback((flush: (() => boolean) | null) => {
    secondaryVisualMarkdownFlushRef.current = flush;
  }, []);
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
  const activePaperArxivId = normalizedArxivId(props.activePaper?.arxivId ?? "");
  const activePaperBrowserUrl = useMemo(
    () => props.activePaper ? paperBrowserUrl(props.activePaper) : null,
    [props.activePaper],
  );
  const [paperPdfView, setPaperPdfView] = useState<PaperPdfView | null>(null);
  const paperPdfRequestGenerationRef = useRef(0);
  const paperPdfPagesRef = useRef(new Map<string, number>());
  useEffect(() => {
    paperPdfRequestGenerationRef.current += 1;
    setPaperPdfView((current) => current?.arxivId === activePaperArxivId ? current : null);
  }, [activePaperArxivId]);
  useEffect(() => {
    // Blog/Paper and Edit/Split/Preview remain the owners of Markdown state.
    // Choosing one while the PDF is open exits the alternate PDF surface.
    paperPdfRequestGenerationRef.current += 1;
    setPaperPdfView(null);
  }, [activeFile, props.mode]);
  const paperPdfObjectUrl = paperPdfView?.status === "ready" ? paperPdfView.objectUrl : null;
  useEffect(() => () => {
    if (paperPdfObjectUrl) URL.revokeObjectURL(paperPdfObjectUrl);
  }, [paperPdfObjectUrl]);
  const openPaperPdf = useCallback(() => {
    if (!activePaperArxivId) return;
    const generation = ++paperPdfRequestGenerationRef.current;
    const remoteUrl = arxivPdfUrl(activePaperArxivId);
    const initialPage = paperPdfPagesRef.current.get(activePaperArxivId) ?? 1;
    setPaperPdfView({ arxivId: activePaperArxivId, status: "loading", initialPage });
    void invoke<ArrayBuffer>("read_cached_paper_pdf", { arxivId: activePaperArxivId })
      .then((bytes) => {
        if (paperPdfRequestGenerationRef.current !== generation) return;
        if (bytes.byteLength > 0) {
          const objectUrl = pdfBytesToObjectUrl(bytes);
          setPaperPdfView({
            arxivId: activePaperArxivId,
            status: "ready",
            url: objectUrl,
            objectUrl,
            bytes,
            initialPage,
          });
          return;
        }
        setPaperPdfView({
          arxivId: activePaperArxivId,
          status: "ready",
          url: remoteUrl,
          objectUrl: null,
          bytes: null,
          initialPage,
        });
      })
      .catch(() => {
        // Cache availability never gates reading. A miss or cache-directory
        // failure falls back to arXiv's ranged, CORS-enabled PDF response.
        if (paperPdfRequestGenerationRef.current === generation) {
          setPaperPdfView({
            arxivId: activePaperArxivId,
            status: "ready",
            url: remoteUrl,
            objectUrl: null,
            bytes: null,
            initialPage,
          });
        }
      });
  }, [activePaperArxivId]);
  const closePaperPdf = useCallback(() => {
    paperPdfRequestGenerationRef.current += 1;
    setPaperPdfView(null);
  }, []);
  const cacheActivePaperPdf = useCallback((bytes: ArrayBuffer) => {
    if (
      !activePaperArxivId
      || paperPdfView?.status !== "ready"
      || paperPdfView.objectUrl
    ) {
      return;
    }
    setPaperPdfView((current) => (
      current?.status === "ready"
      && current.arxivId === activePaperArxivId
      && !current.objectUrl
        ? { ...current, bytes }
        : current
    ));
    void invoke<void>("cache_paper_pdf", bytes, {
      headers: { "x-arxiv-id": utf8ToBase64(activePaperArxivId) },
    }).catch(() => undefined);
  }, [activePaperArxivId, paperPdfView]);
  const rememberPaperPdfPage = useCallback((page: number) => {
    if (activePaperArxivId) paperPdfPagesRef.current.set(activePaperArxivId, page);
  }, [activePaperArxivId]);
  const openActivePaperInBrowser = useCallback(() => {
    if (!activePaperBrowserUrl) return;
    void openUrl(activePaperBrowserUrl).catch((reason) => {
      notifyError(t`Papers`, t`Could not open the article in your browser`, {
        detail: reason instanceof Error ? reason.message : String(reason),
      });
    });
  }, [activePaperBrowserUrl, t]);
  const markdownDocument = Boolean(props.activePaper) || activeFile.toLocaleLowerCase().endsWith(".md");
  const htmlDocument = !props.activePaper && isHtmlFilePath(activeFile);
  const boardDocument = !props.activePaper && activeFile.toLocaleLowerCase().endsWith(".tldr");
  const spreadsheetDocument = !props.activePaper && isSpreadsheetPath(activeFile);
  const explicitPreviewStart = props.markdownPreviewSource !== undefined && props.source.endsWith(props.markdownPreviewSource)
    ? props.source.length - props.markdownPreviewSource.length
    : 0;
  const markdownPreviewStart = props.markdownPreviewSource !== undefined
    ? explicitPreviewStart
    : markdownDocument
      ? markdownFrontmatterEnd(props.source)
      : 0;
  const markdownPreviewText = props.markdownPreviewSource ?? props.source.slice(markdownPreviewStart);
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
  const markdownPreviewLineOffset = props.source.slice(0, markdownPreviewStart).split("\n").length - 1;
  const markdownVisualCursors = useMemo(
    () => props.overleafPresenceCursors
      .filter((cursor) => cursor.row >= markdownPreviewLineOffset)
      .map((cursor) => ({ ...cursor, row: cursor.row - markdownPreviewLineOffset })),
    [markdownPreviewLineOffset, props.overleafPresenceCursors],
  );
  const markdownVisualChanges = useMemo(() => {
    const previewEnd = markdownPreviewStart + markdownPreviewText.length;
    return props.overleafChanges.flatMap((change) => {
      const changeEnd = change.deletion ? change.position : change.position + change.text.length;
      return change.position < markdownPreviewStart || changeEnd > previewEnd
        ? []
        : [{ ...change, position: change.position - markdownPreviewStart }];
    });
  }, [markdownPreviewStart, markdownPreviewText.length, props.overleafChanges]);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const primaryViewRef = useRef<EditorView | null>(null);
  const primaryViewPathRef = useRef("");
  const secondaryViewRef = useRef<EditorView | null>(null);
  const [primaryScrollbarView, setPrimaryScrollbarView] = useState<EditorView | null>(null);
  const [secondaryScrollbarView, setSecondaryScrollbarView] = useState<EditorView | null>(null);
  const [markdownPreviewViewport, setMarkdownPreviewViewport] = useState<HTMLDivElement | null>(null);
  const markdownPreviewViewportRef = useRef<HTMLDivElement | null>(null);
  const markdownPreviewPersistenceCleanupRef = useRef<(() => void) | null>(null);
  const markdownScrollSyncSuppressedRef = useRef(false);
  const markdownModeViewportHandoffRef = useRef<MarkdownModeViewportHandoff | null>(null);
  const markdownModeViewportRestoreGenerationRef = useRef(0);
  const explicitViewInSourceTransitionRef = useRef(false);
  const explicitViewInSourceGenerationRef = useRef(0);
  const explicitViewInSourcePendingGenerationRef = useRef<number | null>(null);
  const markdownModeIdentityRef = useRef({ path: activeFile, mode: props.mode });
  const markdownPreviewViewportLockRef = useRef(0);
  // Populated by the split scroll coordinator; poked from the primary
  // editor's update listener so cursor motion can reveal the matching
  // preview block (VS Code-style cursor-driven synchronization).
  const markdownCursorRevealRef = useRef<(() => void) | null>(null);
  const markdownPreviewReconcileFromSourceRef = useRef<(() => void) | null>(null);
  const markdownPreviewOverflowAnchorRef = useRef("");
  const lastInsertionPositionRef = useRef(0);
  const pendingFigureCursorRef = useRef<{ pane: EditorPaneId; cursor: number } | null>(null);
  const [splitRatio, setSplitRatio] = useState(loadSplitRatio);
  const handledDualRatioResetRef = useRef(props.dualRatioResetGeneration);
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
    path: string;
    from: number;
    to: number;
    quote: string;
    prefix: string;
    suffix: string;
    body: string;
    error: string | null;
  } | null>(null);
  const commentComposerViewRef = useRef<EditorView | null>(null);
  // Identity of the preview column. It renders the project's compiled PDF, not
  // a preview of whatever the editor holds, so a file with no preview of its
  // own — a .bib reached by double-clicking a citation, a .sty reached from a
  // macro — must not remount the viewer under a new key and restore that file's
  // empty page and zoom. It keeps the last file that does own a preview; a
  // previewable file is its own identity, so this only ever lags for files that
  // would have thrown the reader's place away.
  const [previewIdentity, setPreviewIdentity] = useState(activeFile);
  useEffect(() => {
    const owner = isPreviewableSourceFilePath(activeFile)
      ? activeFile
      : secondaryFile && isPreviewableSourceFilePath(secondaryFile)
        ? secondaryFile
        : null;
    if (owner) setPreviewIdentity(owner);
  }, [activeFile, secondaryFile]);

  const captureMarkdownModeViewport = useCallback(() => {
    const markdownMode = props.mode === "source" || props.mode === "split" || props.mode === "pdf";
    if (!markdownDocument || !markdownMode) return;
    const currentSourceView = primaryViewRef.current?.dom.isConnected
      && primaryViewPathRef.current === activeFile
      ? primaryViewRef.current
      : null;
    const currentPreview = markdownPreviewViewportRef.current?.isConnected
      ? markdownPreviewViewportRef.current
      : null;
    if (!currentSourceView && !currentPreview) return;
    markdownModeViewportHandoffRef.current = {
      path: activeFile,
      mode: props.mode,
      ...(currentSourceView ? { source: captureViewport(currentSourceView.scrollDOM) } : {}),
      ...(currentPreview ? { preview: capturePreviewViewport(currentPreview) } : {}),
    };
  }, [activeFile, markdownDocument, props.mode]);

  useLayoutEffect(() => {
    const register = props.onMarkdownModeViewportCaptureChange;
    if (!register) return;
    register(captureMarkdownModeViewport);
    return () => register(null);
  }, [captureMarkdownModeViewport, props.onMarkdownModeViewportCaptureChange]);

  useLayoutEffect(() => {
    if (
      props.mode !== "dual"
      || handledDualRatioResetRef.current === props.dualRatioResetGeneration
    ) return;
    handledDualRatioResetRef.current = props.dualRatioResetGeneration;
    setSplitRatio(0.5);
    persistSplitRatio(0.5);
  }, [props.dualRatioResetGeneration, props.mode]);

  useLayoutEffect(() => {
    const restoreGeneration = ++markdownModeViewportRestoreGenerationRef.current;
    const markdownMode = props.mode === "source" || props.mode === "split" || props.mode === "pdf";
    const explicitViewInSource = Boolean(
      markdownDocument && markdownMode && explicitViewInSourceTransitionRef.current,
    );
    const previousIdentity = markdownModeIdentityRef.current;
    const modeOrPathChanged = previousIdentity.path !== activeFile
      || previousIdentity.mode !== props.mode;
    markdownModeIdentityRef.current = { path: activeFile, mode: props.mode };
    explicitViewInSourceTransitionRef.current = false;
    if (modeOrPathChanged && !explicitViewInSource) {
      explicitViewInSourceGenerationRef.current += 1;
      explicitViewInSourcePendingGenerationRef.current = null;
    }
    if (!markdownDocument || !markdownMode) {
      markdownModeViewportHandoffRef.current = null;
      markdownScrollSyncSuppressedRef.current = false;
      return;
    }

    const handoff = markdownModeViewportHandoffRef.current;
    if (explicitViewInSource) markdownModeViewportHandoffRef.current = null;
    let restoreFrame: number | null = null;

    const shouldRestoreHandoff = Boolean(
      handoff
      && handoff.path === activeFile
      && handoff.mode !== props.mode
      && !explicitViewInSource
    );
    if (shouldRestoreHandoff && handoff) {
      markdownScrollSyncSuppressedRef.current = true;
      const restore = () => {
        if (markdownModeViewportRestoreGenerationRef.current !== restoreGeneration) return false;
        const currentSourceView = primaryViewRef.current?.dom.isConnected
          && primaryViewPathRef.current === activeFile
          ? primaryViewRef.current
          : null;
        const currentPreview = markdownPreviewViewportRef.current;
        let ready = true;
        if (props.mode !== "pdf") {
          const sourceSnapshot = handoff.source ?? handoff.preview;
          ready = Boolean(currentSourceView && sourceSnapshot
            && restoreViewport(currentSourceView.scrollDOM, sourceSnapshot)) && ready;
        }
        if (props.mode !== "source") {
          ready = Boolean(currentPreview && (
            handoff.preview
              ? restorePreviewViewport(currentPreview, handoff.preview)
              : handoff.source && restoreViewport(currentPreview, handoff.source)
          )) && ready;
        }
        return ready;
      };
      let attempts = 0;
      let stableRestores = 0;
      const restoreWhenReady = () => {
        restoreFrame = null;
        stableRestores = restore() ? stableRestores + 1 : 0;
        attempts += 1;
        if (stableRestores >= 3 || attempts >= 30) {
          if (stableRestores >= 3 && markdownModeViewportHandoffRef.current === handoff) {
            markdownModeViewportHandoffRef.current = null;
          }
          if (!explicitViewInSourceTransitionRef.current) {
            markdownScrollSyncSuppressedRef.current = false;
          }
          return;
        }
        restoreFrame = window.requestAnimationFrame(restoreWhenReady);
      };
      restoreWhenReady();
    } else if (!explicitViewInSource && explicitViewInSourcePendingGenerationRef.current == null) {
      markdownScrollSyncSuppressedRef.current = false;
    }

    return () => {
      markdownModeViewportRestoreGenerationRef.current += 1;
      if (restoreFrame != null) window.cancelAnimationFrame(restoreFrame);
    };
  }, [activeFile, markdownDocument, markdownPreviewViewport, primaryScrollbarView, props.mode]);

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

  /**
   * Comments rebased into the preview's own coordinates. The preview may render
   * a slice of the file, and anchors are resolved against the text it was given
   * — offsets from the whole document would land in the wrong prose or nowhere.
   * A comment straddling the slice boundary is dropped rather than mispainted.
   */
  const markdownVisualComments = useMemo(() => {
    const previewEnd = markdownPreviewStart + markdownPreviewText.length;
    return commentsForActiveFile.flatMap((comment) => (
      comment.from < markdownPreviewStart || comment.to > previewEnd
        ? []
        : [{
            ...comment,
            from: comment.from - markdownPreviewStart,
            to: comment.to - markdownPreviewStart,
          }]
    ));
  }, [commentsForActiveFile, markdownPreviewStart, markdownPreviewText.length]);
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
  const dismissSelectionToolbar = useCallback(() => {
    selectionToolbarOwnerRef.current = null;
    setSelectionToolbarPane(null);
    setSelectionToolbarPosition(null);
  }, []);
  // reportEditorPosition is assigned below after its useCallback.

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
      setSourceRef.current(next);
    };
    ytext.observe(syncPreviewSource);
    syncPreviewSource();
    return () => ytext.unobserve(syncPreviewSource);
  }, [activeFile, collabLive, collabSession, props.mode]);

  // Stable callbacks. CodeMirrorHost reads handlers through refs, so identity
  // churn no longer forces a reconfigure (the old wrapper destroyed yCollab +
  // comment fields on any handler identity change) — kept stable regardless.
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
    markdownCursorRevealRef.current?.();
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
    if (range.empty || (!path.endsWith(".tex") && !path.toLocaleLowerCase().endsWith(".md"))) {
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
    if (props.mode === "pdf" || props.mode === "asset") {
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
    if (!props.editorEditable) return;
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
  }, [openCommentComposer, props.editorEditable, updateSelectionToolbar]);

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
  const primaryKeymapExtensions = useOptionalKeymapExtensions(editorKeymap, reportPrimaryVimMode);
  const secondaryKeymapExtensions = useOptionalKeymapExtensions(editorKeymap, reportSecondaryVimMode);
  const primaryTextLanguageExtensions = useTextLanguageExtensions(
    isLatexSourcePath(activeFile) ? "" : activeFile,
  );
  const secondaryTextLanguageExtensions = useTextLanguageExtensions(
    secondaryFile && !isLatexSourcePath(secondaryFile) ? secondaryFile : "",
  );
  const focusedVimMode = focusedPane === "secondary" && secondaryFile
    ? vimModes.secondary
    : vimModes.primary;
  reportEditorPositionRef.current = reportEditorPosition;
  const editorExtensions = useMemo(
    () => [
      ...primaryKeymapExtensions,
      ...(isLatexSourcePath(activeFile) ? [
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
          editorSpellcheck && isHarperProseFilePath(activeFile),
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
      ] : [
        ...primaryTextLanguageExtensions,
        ...textEditorExtensions(
          editorSpellcheck && isHarperProseFilePath(activeFile),
          latexLiveRef,
          onPasteImageFile,
        ),
      ]),
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
        getLocalization: () => editorCommentLocalizationRef.current,
        currentAuthorId: commentAuthorId,
        onResolve: (id) => resolveEditorCommentRef.current(id),
        onReply: (comment) => replyEditorCommentRef.current(comment.id),
      }),
      linter((view) => editorDiagnosticsForFile(diagnosticsRef.current.build, activeFile, view.state.doc), {
        delay: 150,
      }),
      ...(isLatexSourcePath(activeFile) ? [linter(
        (view) => editorTexlabDiagnosticsForFile(diagnosticsRef.current.texlab, activeFile, view.state.doc),
        { delay: 200 },
      )] : []),
    ],
    // Volatile macros/diagnostics/comments are read via refs so this array stays
    // stable across keystrokes — otherwise reconfigure kills yCollab carets.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional stability
    [activeFile, collabExtensions, editorSpellcheck, primaryKeymapExtensions, primaryTextLanguageExtensions],
  );
  const secondaryEditorExtensions = useMemo(
    () => {
      if (!secondaryFile) return [];
      return [
        ...secondaryKeymapExtensions,
        ...(isLatexSourcePath(secondaryFile) ? [
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
            editorSpellcheck && isHarperProseFilePath(secondaryFile),
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
        ] : [
          ...secondaryTextLanguageExtensions,
          ...textEditorExtensions(
            editorSpellcheck && isHarperProseFilePath(secondaryFile),
            latexLiveRef,
            onPasteImageFile,
          ),
        ]),
        linter((view) => editorDiagnosticsForFile(diagnosticsRef.current.build, secondaryFile, view.state.doc), {
          delay: 150,
        }),
        ...(isLatexSourcePath(secondaryFile) ? [linter(
          (view) => editorTexlabDiagnosticsForFile(diagnosticsRef.current.texlab, secondaryFile, view.state.doc),
          { delay: 200 },
        )] : []),
      ];
    },
    // Mirror the primary editor's contract above: volatile inputs (macros,
    // graphics roots, citations/references, App-provided lambdas) are
    // captured at reconfigure time and refreshed on file switch. Listing them
    // here handed the memo a fresh identity every keystroke, and
    // CodeMirrorHost (like the wrapper it replaced) answers a changed
    // extensions identity with a full StateEffect.reconfigure — which would
    // tear down the entire secondary editor (language, linters, autocomplete)
    // per character in dual/split mode.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional stability
    [editorSpellcheck, secondaryFile, secondaryKeymapExtensions, secondaryTextLanguageExtensions],
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
    const editorVisible = props.mode !== "pdf" && props.mode !== "asset";
    const candidateView = editorVisible
      ? request.path === secondaryFile
        ? secondaryViewRef.current
        : request.path === activeFile
          ? primaryViewRef.current ?? editorViewRef.current
          : null
      : null;
    // Refs can be assigned just before CodeMirror's DOM reports connected.
    // Treat the view as ready here; otherwise a one-shot navigation can be
    // missed because the later ref attachment does not itself rerun this effect.
    const view = candidateView;
    const preview = request.path === activeFile && markdownDocument
      ? markdownPreviewViewport
      : null;
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
        ? request.path === secondaryFile
          ? secondaryViewRef.current
          : primaryViewRef.current ?? editorViewRef.current
        : null;
      if (currentView) {
        const currentSource = request.path === secondaryFile ? secondarySource : editorSource;
        if (
          currentView.state.doc.toString() !== currentSource
          && performance.now() < staleDocumentDeadline
        ) {
          frame = window.requestAnimationFrame(navigate);
          return;
        }
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

  const replaceVisualMarkdown = useCallback((nextBody: string, expectedBody: string) => {
    // VisualMarkdownEditor retains the previous publisher until its layout
    // flush. The host normally flushes before switching, but never let a late
    // callback mutate refs or setters once another document owns the canvas.
    if (activeFileRefEditor.current !== activeFile) return false;
    const storedView = primaryViewRef.current;
    const view = storedView?.dom.isConnected && primaryViewPathRef.current === activeFile
      ? storedView
      : null;
    const ytext = collabReady && collabSession?.activePath === activeFile
      ? collabSession.ytext
      : null;
    const source = view?.state.doc.toString() ?? ytext?.toString() ?? mountSourceRef.current;
    const from = markdownPreviewStart;
    if (source.slice(from) !== expectedBody) return false;
    const insert = expectedBody.includes("\r\n")
      ? nextBody.replace(/\r?\n/g, "\r\n")
      : nextBody;
    const prefix = source.slice(0, from);
    const separator = expectedBody === "" && insert !== "" && from === source.length && prefix !== "" && !/\r?\n$/.test(prefix)
      ? (source.includes("\r\n") ? "\r\n" : "\n")
      : "";
    const insertedSource = `${separator}${insert}`;
    const nextSource = `${prefix}${insertedSource}`;
    const change = minimalTextChange(expectedBody, insertedSource, from);
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
  }, [
    activeFile,
    collabReady,
    collabSession,
    markdownPreviewStart,
    props.setSource,
  ]);

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
    const saved = getFileViewState?.(path)?.visualMarkdown;
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
        const ready = restoreViewport(viewport, {
          scrollTop: saved.scrollTop,
          scrollRange: saved.scrollRange ?? 0,
        });
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
  }, [activeFile, getFileViewState, onFileViewState]);

  const undoVisualMarkdown = useCallback(() => {
    const storedView = primaryViewRef.current;
    const view = storedView?.dom.isConnected && primaryViewPathRef.current === activeFile ? storedView : null;
    if (collabReady && collabSession?.activePath === activeFile) {
      const before = collabSession.ytext.toString();
      collabSession.undoManager.undo();
      const after = collabSession.ytext.toString();
      setVisualEchoSource(after);
      return after !== before;
    }
    if (view) {
      const undone = undoCodeMirror(view);
      // History commands are the preview's own edits: settling them would
      // leave the user staring at pre-undo content for the idle window.
      if (undone) setVisualEchoSource(view.state.doc.toString());
      return undone;
    }
    const history = visualSourceHistoryRef.current;
    if (history.path !== activeFile) return false;
    const previous = history.undo.pop();
    if (previous == null) return false;
    history.redo.push(mountSourceRef.current);
    mountSourceRef.current = previous;
    setVisualEchoSource(previous);
    setSourceRef.current(previous);
    return true;
  }, [activeFile, collabReady, collabSession]);

  const onViewMarkdownSource = props.onViewMarkdownSource;
  const viewMarkdownSource = useCallback((sourceOffset: number) => {
    // This is an explicit cross-pane reveal. Preview-only and Split have
    // different React roots, and the narrower Split preview reflows prose, so
    // coordinates from the old Preview cannot be carried across reliably.
    // Once both panes exist, center the same source-backed block in each pane.
    if (props.mode !== "split") explicitViewInSourceTransitionRef.current = true;
    const revealGeneration = ++explicitViewInSourceGenerationRef.current;
    explicitViewInSourcePendingGenerationRef.current = revealGeneration;
    const revealIsCurrent = () => (
      explicitViewInSourceGenerationRef.current === revealGeneration
      && explicitViewInSourcePendingGenerationRef.current === revealGeneration
      && activeFileRefEditor.current === activeFile
    );
    markdownScrollSyncSuppressedRef.current = true;
    onViewMarkdownSource();

    let attempts = 0;
    const releaseScrollSync = () => {
      window.requestAnimationFrame(() => {
        if (!revealIsCurrent()) return;
        window.requestAnimationFrame(() => {
          if (revealIsCurrent() && markdownModeIdentityRef.current.mode === "split") {
            explicitViewInSourcePendingGenerationRef.current = null;
            markdownScrollSyncSuppressedRef.current = false;
            // The split coordinator's initial pass ran while the explicit
            // two-pane centering was in progress, so it was intentionally
            // blocked. Reconcile once against that final geometry now;
            // otherwise the first tiny source scroll performs this alignment
            // and visibly nudges the other pane.
            markdownPreviewReconcileFromSourceRef.current?.();
          }
        });
      });
    };
    const focusSource = () => {
      if (!revealIsCurrent()) return;
      const view = primaryViewRef.current;
      const preview = markdownPreviewViewportRef.current;
      const target = preview
        ? Array.from(preview.querySelectorAll<HTMLElement>("[data-source-offset]"))
            .filter((element) => {
              const from = Number(element.dataset.sourceOffset);
              const to = Number(element.dataset.sourceEndOffset);
              return Number.isFinite(from)
                && Number.isFinite(to)
                && sourceOffset >= from
                && sourceOffset <= to;
            })
            .sort((left, right) => (
              Number(left.dataset.sourceEndOffset) - Number(left.dataset.sourceOffset)
              - (Number(right.dataset.sourceEndOffset) - Number(right.dataset.sourceOffset))
            ))[0] ?? null
        : null;
      if (
        markdownModeIdentityRef.current.mode !== "split"
        || !view?.dom.isConnected
        || !preview?.isConnected
        || !target
      ) {
        if (attempts++ < 30) window.requestAnimationFrame(focusSource);
        else {
          // Source reveal remains useful even if a malformed document never
          // receives source labels. Stop suppressing normal split scrolling.
          if (revealIsCurrent()) {
            explicitViewInSourcePendingGenerationRef.current = null;
            markdownScrollSyncSuppressedRef.current = false;
          }
        }
        return;
      }
      const cursor = clamp(markdownPreviewStart + sourceOffset, 0, view.state.doc.length);
      view.dispatch({ selection: { anchor: cursor } });
      const previewFrom = Number(target.dataset.sourceOffset);
      const previewTo = Number(target.dataset.sourceEndOffset);
      const sourceFrom = clamp(markdownPreviewStart + previewFrom, 0, view.state.doc.length);
      const sourceTo = clamp(
        markdownPreviewStart + Math.max(previewFrom, previewTo - 1),
        sourceFrom,
        view.state.doc.length,
      );
      const sourceStartBlock = view.lineBlockAt(sourceFrom);
      const sourceEndBlock = view.lineBlockAt(sourceTo);
      const sourceCenter = (sourceStartBlock.top + sourceEndBlock.bottom) / 2;
      const sourceMaxScroll = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight);
      view.scrollDOM.scrollTop = clamp(
        sourceCenter - view.scrollDOM.clientHeight / 2,
        0,
        sourceMaxScroll,
      );
      const previewRect = preview.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const previewCenter = preview.scrollTop
        + targetRect.top - previewRect.top
        + targetRect.height / 2;
      const previewMaxScroll = Math.max(0, preview.scrollHeight - preview.clientHeight);
      preview.scrollTop = clamp(
        previewCenter - preview.clientHeight / 2,
        0,
        previewMaxScroll,
      );
      view.focus();
      releaseScrollSync();
    };
    window.requestAnimationFrame(focusSource);
  }, [activeFile, markdownPreviewStart, onViewMarkdownSource, props.mode]);

  const redoVisualMarkdown = useCallback(() => {
    const storedView = primaryViewRef.current;
    const view = storedView?.dom.isConnected && primaryViewPathRef.current === activeFile ? storedView : null;
    if (collabReady && collabSession?.activePath === activeFile) {
      const before = collabSession.ytext.toString();
      collabSession.undoManager.redo();
      const after = collabSession.ytext.toString();
      setVisualEchoSource(after);
      return after !== before;
    }
    if (view) {
      const redone = redoCodeMirror(view);
      if (redone) setVisualEchoSource(view.state.doc.toString());
      return redone;
    }
    const history = visualSourceHistoryRef.current;
    if (history.path !== activeFile) return false;
    const next = history.redo.pop();
    if (next == null) return false;
    history.undo.push(mountSourceRef.current);
    mountSourceRef.current = next;
    setVisualEchoSource(next);
    setSourceRef.current(next);
    return true;
  }, [activeFile, collabReady, collabSession]);

  useEffect(() => {
    const view = primaryScrollbarView;
    const preview = markdownPreviewViewport;
    if (!view || !preview || !markdownDocument || props.mode !== "split") return;

    let ignoreEditorScroll = false;
    let ignorePreviewScroll = false;
    let editorFrame: number | null = null;
    let editorFrameMeasureAnchors = false;
    let previewFrame: number | null = null;
    let previewFrameMeasureAnchors = false;
    let settledSyncTimer: number | null = null;
    let settledSyncOwner: "editor" | "preview" = "editor";
    let activeScrollOwner: "editor" | "preview" | null = null;
    let scrollOwnerTimer: number | null = null;
    let anchorsDirty = true;
    let cachedEditorToPreview: Array<{ from: number; to: number }> = [];
    let cachedPreviewToEditor: Array<{ from: number; to: number }> = [];
    let cachedAnchorRanges: Array<{ from: number; to: number; element: HTMLElement }> = [];
    const scrollRanges = () => ({
      editor: Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight),
      preview: Math.max(0, preview.scrollHeight - preview.clientHeight),
    });
    const scrollSyncBlocked = () => markdownScrollSyncSuppressedRef.current
      || markdownPreviewViewportLockRef.current !== 0;
    const holdScrollOwnership = (owner: "editor" | "preview") => {
      activeScrollOwner = owner;
      if (scrollOwnerTimer != null) window.clearTimeout(scrollOwnerTimer);
      scrollOwnerTimer = window.setTimeout(() => {
        scrollOwnerTimer = null;
        activeScrollOwner = null;
      }, 200);
    };
    const rebuildAnchorPairs = () => {
      const sourceAnchors = Array.from(
        preview.querySelectorAll<HTMLElement>("[data-source-offset]"),
      );
      const previewRect = preview.getBoundingClientRect();
      const pairs: Array<{ editor: number; preview: number }> = [];
      const ranges: Array<{ from: number; to: number; element: HTMLElement }> = [];
      for (const anchor of sourceAnchors) {
        const previewFrom = Number(anchor.dataset.sourceOffset);
        const previewTo = Number(anchor.dataset.sourceEndOffset);
        if (!Number.isFinite(previewFrom) || !Number.isFinite(previewTo)) continue;
        ranges.push({ from: previewFrom, to: previewTo, element: anchor });
        const sourceFrom = clamp(markdownPreviewStart + previewFrom, 0, view.state.doc.length);
        const sourceTo = clamp(
          markdownPreviewStart + Math.max(previewFrom, previewTo - 1),
          sourceFrom,
          view.state.doc.length,
        );
        const sourceStartBlock = view.lineBlockAt(sourceFrom);
        const sourceEndBlock = view.lineBlockAt(sourceTo);
        const anchorRect = anchor.getBoundingClientRect();
        const pair = {
          editor: (sourceStartBlock.top + sourceEndBlock.bottom) / 2,
          preview: Math.max(
            0,
            preview.scrollTop + anchorRect.top - previewRect.top + anchorRect.height / 2,
          ),
        };
        const previous = pairs.at(-1);
        if (!previous || (pair.editor > previous.editor && pair.preview > previous.preview)) {
          pairs.push(pair);
        }
      }
      cachedEditorToPreview = pairs.map((pair) => ({ from: pair.editor, to: pair.preview }));
      cachedPreviewToEditor = pairs.map((pair) => ({ from: pair.preview, to: pair.editor }));
      cachedAnchorRanges = ranges;
      anchorsDirty = false;
    };
    const refreshAnchorsIfNeeded = () => {
      if (anchorsDirty) rebuildAnchorPairs();
    };
    // Measuring every anchor is O(document) and lands as a dropped frame when
    // it runs on the scroll path. Rebuild the map ahead of time once the DOM
    // quiets down after a publication, in idle time where available, so a
    // burst's throttled follows can interpolate from a fresh cache and the
    // lazy rebuild remains only a fallback.
    let anchorPrebuild: number | null = null;
    const usesIdleCallback = typeof window.requestIdleCallback === "function";
    const cancelAnchorPrebuild = () => {
      if (anchorPrebuild == null) return;
      if (usesIdleCallback) window.cancelIdleCallback(anchorPrebuild);
      else window.clearTimeout(anchorPrebuild);
      anchorPrebuild = null;
    };
    const scheduleAnchorPrebuild = () => {
      cancelAnchorPrebuild();
      const run = () => {
        anchorPrebuild = null;
        if (anchorsDirty) rebuildAnchorPairs();
      };
      anchorPrebuild = usesIdleCallback
        ? window.requestIdleCallback(run, { timeout: 1_000 })
        : window.setTimeout(run, 200);
    };
    const syncPreviewFromEditor = (measureAnchors = true) => {
      if (ignoreEditorScroll) {
        ignoreEditorScroll = false;
        return;
      }
      if (scrollSyncBlocked() || activeScrollOwner === "preview") return;
      if (measureAnchors) refreshAnchorsIfNeeded();
      const ranges = scrollRanges();
      const editorHalf = view.scrollDOM.clientHeight / 2;
      const previewHalf = preview.clientHeight / 2;
      const targetCenter = interpolateScrollAnchors(
        view.scrollDOM.scrollTop + editorHalf,
        cachedEditorToPreview,
        editorHalf,
        ranges.editor + editorHalf,
        previewHalf,
        ranges.preview + previewHalf,
      );
      const nextTop = targetCenter - previewHalf;
      if (Math.abs(preview.scrollTop - nextTop) <= 1) return;
      ignorePreviewScroll = true;
      preview.scrollTop = nextTop;
    };
    const reconcilePreviewFromSource = () => {
      // Split changes the Preview width, so discard measurements from its
      // initial mount and align with the final source/Preview geometry.
      anchorsDirty = true;
      syncPreviewFromEditor();
    };
    markdownPreviewReconcileFromSourceRef.current = reconcilePreviewFromSource;
    const syncEditorFromPreview = (measureAnchors = true) => {
      if (ignorePreviewScroll) {
        ignorePreviewScroll = false;
        return;
      }
      if (scrollSyncBlocked() || activeScrollOwner === "editor") return;
      if (measureAnchors) refreshAnchorsIfNeeded();
      const ranges = scrollRanges();
      const editorHalf = view.scrollDOM.clientHeight / 2;
      const previewHalf = preview.clientHeight / 2;
      const targetCenter = interpolateScrollAnchors(
        preview.scrollTop + previewHalf,
        cachedPreviewToEditor,
        previewHalf,
        ranges.preview + previewHalf,
        editorHalf,
        ranges.editor + editorHalf,
      );
      const nextTop = targetCenter - editorHalf;
      if (Math.abs(view.scrollDOM.scrollTop - nextTop) <= 1) return;
      ignoreEditorScroll = true;
      view.scrollDOM.scrollTop = nextTop;
    };

    // Cursor-driven reveal, VS Code style: when the source cursor lands on a
    // block that is not visible in the preview (a click far away, a find
    // jump, typing below the fold), bring that block to the middle of the
    // preview viewport. A partially visible block is left alone — nudging it
    // would fight the user's own preview scrolling, and it already shows the
    // text being edited. Scroll gestures never arrive here; the coordinator
    // above owns those.
    let lastRevealHead = view.state.selection.main.head;
    let revealTimer: number | null = null;
    const revealPreviewAtCursor = () => {
      if (scrollSyncBlocked()) return;
      refreshAnchorsIfNeeded();
      const offset = view.state.selection.main.head - markdownPreviewStart;
      let best: { from: number; to: number; element: HTMLElement } | null = null;
      for (const range of cachedAnchorRanges) {
        // Half-open with a floor of one character, so a cursor on an empty
        // block still matches it; prefer the tightest enclosing block.
        if (offset < range.from || offset >= Math.max(range.to, range.from + 1)) continue;
        if (!best || range.to - range.from <= best.to - best.from) best = range;
      }
      if (!best) return;
      const rect = best.element.getBoundingClientRect();
      const previewRect = preview.getBoundingClientRect();
      if (rect.bottom > previewRect.top + 8 && rect.top < previewRect.bottom - 8) return;
      const maxScroll = Math.max(0, preview.scrollHeight - preview.clientHeight);
      const target = clamp(
        preview.scrollTop + rect.top - previewRect.top - (preview.clientHeight - rect.height) / 2,
        0,
        maxScroll,
      );
      if (Math.abs(preview.scrollTop - target) <= 1) return;
      ignorePreviewScroll = true;
      preview.scrollTop = target;
    };
    const scheduleCursorReveal = () => {
      const head = view.state.selection.main.head;
      if (head === lastRevealHead) return;
      lastRevealHead = head;
      // Only cursor motion the user made in the source pane reveals; caret
      // restores on unfocused editors (file switches, programmatic
      // selection) must not move the preview.
      if (!view.hasFocus) return;
      if (revealTimer != null) window.clearTimeout(revealTimer);
      revealTimer = window.setTimeout(revealPreviewAtCursor, 80);
    };
    markdownCursorRevealRef.current = scheduleCursorReveal;

    // Trackpad input can deliver several scroll events before the browser
    // paints. Synchronizing both panes for every event repeatedly walks and
    // measures the Markdown DOM, so coalesce each direction to one pass per
    // animation frame.
    const schedulePreviewFromEditor = (measureAnchors = true) => {
      editorFrameMeasureAnchors ||= measureAnchors;
      if (editorFrame != null) return;
      editorFrame = window.requestAnimationFrame(() => {
        editorFrame = null;
        const shouldMeasure = editorFrameMeasureAnchors;
        editorFrameMeasureAnchors = false;
        syncPreviewFromEditor(shouldMeasure);
      });
    };
    const scheduleEditorFromPreview = (measureAnchors = true) => {
      previewFrameMeasureAnchors ||= measureAnchors;
      if (previewFrame != null) return;
      previewFrame = window.requestAnimationFrame(() => {
        previewFrame = null;
        const shouldMeasure = previewFrameMeasureAnchors;
        previewFrameMeasureAnchors = false;
        syncEditorFromPreview(shouldMeasure);
      });
    };

    // Large Markdown places two expensive, independently painted documents
    // beside each other (the split preview is a full editable ProseMirror
    // tree, which cannot use content-visibility culling — see
    // editor-globals.css on .ok-chunk-wrapper). The peer still follows every
    // animation frame — anything sparser reads as stuttering during trackpad
    // momentum — but burst follows interpolate purely from the cached anchor
    // map, so the scroll path performs no DOM measurement. The one exact,
    // freshly measured reconciliation runs after the gesture settles.
    // Smaller documents may measure lazily on the scroll path itself,
    // regardless of whether they are Paper/Blog or ordinary project Markdown.
    const followPeer = (owner: "editor" | "preview") => {
      settledSyncOwner = owner;
      if (owner === "editor") schedulePreviewFromEditor(false);
      else scheduleEditorFromPreview(false);
      if (settledSyncTimer != null) window.clearTimeout(settledSyncTimer);
      settledSyncTimer = window.setTimeout(() => {
        settledSyncTimer = null;
        if (settledSyncOwner === "editor") syncPreviewFromEditor();
        else syncEditorFromPreview();
      }, markdownSyncPolicy.peerScrollSettleMs);
    };

    const ownEditorScroll = () => {
      // scrollTop writes can coalesce into fewer events or arrive after the
      // next frame. The one-shot ignore flag handles the normal reciprocal
      // event; ownership also rejects a late/coalesced peer event so it cannot
      // seize control and write back into the scrollbar the user is dragging.
      if (ignoreEditorScroll) {
        ignoreEditorScroll = false;
        return;
      }
      if (scrollSyncBlocked()) return;
      if (activeScrollOwner === "preview") return;
      holdScrollOwnership("editor");
      if (markdownSyncPolicy.peerScrollSettleMs > 0) {
        followPeer("editor");
      } else {
        schedulePreviewFromEditor();
      }
    };
    const ownPreviewScroll = () => {
      if (ignorePreviewScroll) {
        ignorePreviewScroll = false;
        return;
      }
      if (scrollSyncBlocked()) return;
      if (activeScrollOwner === "editor") return;
      holdScrollOwnership("preview");
      if (markdownSyncPolicy.peerScrollSettleMs > 0) {
        followPeer("preview");
      } else {
        scheduleEditorFromPreview();
      }
    };
    const editorInteraction = () => {
      ignoreEditorScroll = false;
      holdScrollOwnership("editor");
    };
    const previewInteraction = () => {
      ignorePreviewScroll = false;
      holdScrollOwnership("preview");
    };
    const editorRoot = view.scrollDOM.closest<HTMLElement>(".source-editor") ?? view.scrollDOM;
    const previewRoot = preview.closest<HTMLElement>("[data-slot='scroll-area']");
    view.scrollDOM.addEventListener("scroll", ownEditorScroll, { passive: true });
    preview.addEventListener("scroll", ownPreviewScroll, { passive: true });
    view.scrollDOM.addEventListener("wheel", editorInteraction, { passive: true });
    editorRoot.addEventListener("pointerdown", editorInteraction, { capture: true, passive: true });
    view.scrollDOM.addEventListener("keydown", editorInteraction);
    previewRoot?.addEventListener("wheel", previewInteraction, { passive: true });
    previewRoot?.addEventListener("pointerdown", previewInteraction, { capture: true, passive: true });
    previewRoot?.addEventListener("keydown", previewInteraction);
    const observer = new MutationObserver(() => {
      // Source labels and child nodes change after every settled visual edit.
      // Measuring every block here forces a full layout after each source
      // publication. Mark the map stale and remeasure once the mutations
      // stop, off the scroll path.
      anchorsDirty = true;
      scheduleAnchorPrebuild();
    });
    observer.observe(preview, {
      attributes: true,
      attributeFilter: ["data-source-offset", "data-source-end-offset"],
      childList: true,
      subtree: true,
    });
    const resizeObserver = new ResizeObserver(() => {
      anchorsDirty = true;
      scheduleAnchorPrebuild();
    });
    resizeObserver.observe(preview);
    const previewContent = preview.firstElementChild;
    if (previewContent instanceof HTMLElement) resizeObserver.observe(previewContent);
    // Initial alignment uses the proportional fallback. Exact block geometry
    // is measured lazily on the first real scroll after labels are available.
    schedulePreviewFromEditor(false);
    return () => {
      markdownCursorRevealRef.current = null;
      if (markdownPreviewReconcileFromSourceRef.current === reconcilePreviewFromSource) {
        markdownPreviewReconcileFromSourceRef.current = null;
      }
      if (revealTimer != null) window.clearTimeout(revealTimer);
      if (editorFrame != null) window.cancelAnimationFrame(editorFrame);
      if (previewFrame != null) window.cancelAnimationFrame(previewFrame);
      if (settledSyncTimer != null) window.clearTimeout(settledSyncTimer);
      if (scrollOwnerTimer != null) window.clearTimeout(scrollOwnerTimer);
      cancelAnchorPrebuild();
      observer.disconnect();
      resizeObserver.disconnect();
      view.scrollDOM.removeEventListener("scroll", ownEditorScroll);
      preview.removeEventListener("scroll", ownPreviewScroll);
      view.scrollDOM.removeEventListener("wheel", editorInteraction);
      editorRoot.removeEventListener("pointerdown", editorInteraction, true);
      view.scrollDOM.removeEventListener("keydown", editorInteraction);
      previewRoot?.removeEventListener("wheel", previewInteraction);
      previewRoot?.removeEventListener("pointerdown", previewInteraction, true);
      previewRoot?.removeEventListener("keydown", previewInteraction);
    };
  }, [
    markdownDocument,
    markdownPreviewStart,
    markdownPreviewViewport,
    markdownSyncPolicy.peerScrollSettleMs,
    primaryScrollbarView,
    props.mode,
  ]);

  if (props.mode === "asset" && props.activeAsset) {
    return (
      <ProjectAssetPreview
        key={props.activeAsset.path}
        asset={props.activeAsset}
        viewState={props.getFileViewState?.(props.activeAsset.path)}
        onViewState={(update) => props.onFileViewState?.(props.activeAsset!.path, update)}
      />
    );
  }
  const paperFullTextHeader = props.activePaper
    && activeFile.replace(/\\/g, "/").toLocaleLowerCase().endsWith("/paper.md") ? (
      <header className="paper-visual-header editor-content-aligned">
        <div>
          <h1>{props.activePaper.title}</h1>
          {props.activePaper.authors?.trim() && (
            <p>{props.activePaper.authors.trim().replace(/\s+and\s+/gi, " · ")}</p>
          )}
        </div>
      </header>
    ) : null;
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
        // Split mode has an explicit source/preview scroll coordinator and
        // insertion viewport lock. Native anchoring is a competing scroll
        // writer when media above the viewport resolves or remounts.
        style: props.mode === "split" ? { overflowAnchor: "none" } : undefined,
      }}
      viewportRef={attachMarkdownPreviewViewport}
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
      {paperFullTextHeader}
      <Suspense fallback={props.activePaper ? null : (
        <MarkdownPreviewLoading />
      )}>
        <DeferredVisualMarkdownEditor
          text={settledPreviewText}
          activePath={props.activeFile}
          optimizeForReading={Boolean(props.activePaper)}
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
          presenceCursors={allMarkdownVisualCursors}
          overleafChanges={markdownVisualChanges}
          overleafTrackChangeActions={props.overleafTrackChangeActions}
          editorComments={markdownVisualComments}
          activeEditorCommentId={props.activeEditorCommentId}
          // Opens the panel focused on that thread — the same thing replying
          // from the source editor's tooltip does.
          onEditorCommentClick={props.onReplyEditorComment}
          onCreateComment={(from, to, body) => {
            const comment = createEditorComment({
              path: activeFile,
              source: props.source,
              from: markdownPreviewStart + from,
              to: markdownPreviewStart + to,
              body,
              authorId: commentAuthorId,
              authorName: commentAuthorName,
            });
            if (comment) onCreateEditorComment(comment);
          }}
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
          onSelectionMarkdown={(value) => setSelectionRef.current(value)}
        />
      </Suspense>
    </ScrollArea>
  );
  const paperPdfActive = Boolean(
    props.activePaper
    && paperPdfView
    && paperPdfView.arxivId === activePaperArxivId,
  );
  const paperReturnLabel = activeFile.toLocaleLowerCase().endsWith("/blog.md") ? t`Blog` : t`Paper`;
  const paperBrowserActionLabel = activePaperArxivId
    ? t`Open PDF in browser`
    : t`Open article in browser`;
  const paperActions = props.activePaper && !paperPdfActive ? (
    <div className="paper-local-actions" aria-label={t`Paper actions`} data-tour="paper-actions">
      {activePaperArxivId ? (
        <button
          type="button"
          className="paper-local-action"
          aria-label={t`View original PDF`}
          onClick={openPaperPdf}
        >
          <FileText size={14} aria-hidden="true" />
          <span>{t`PDF`}</span>
        </button>
      ) : null}
      {activePaperBrowserUrl ? (
        <Tip label={paperBrowserActionLabel}>
          <button
            type="button"
            className="paper-local-action paper-local-action-icon"
            onClick={openActivePaperInBrowser}
          >
            <ExternalLink size={14} aria-hidden="true" />
          </button>
        </Tip>
      ) : null}
    </div>
  ) : null;
  const paperPdfPreview = paperPdfActive ? (
    paperPdfView?.status === "ready" ? (
      <div
        className="paper-pdf-preview"
        onPointerDownCapture={() => props.onContextSurfaceActivate("paper")}
        onFocusCapture={() => props.onContextSurfaceActivate("paper")}
      >
        <Suspense fallback={<PdfPreviewLoading />}>
          <PdfPreview
            key={`paper-pdf:${paperPdfView.arxivId}`}
            url={paperPdfView.url}
            pdfBase64={null}
            pdfBytes={paperPdfView.bytes}
            fileName={`${paperPdfView.arxivId.replace("/", "-")}.pdf`}
            initialPage={paperPdfView.initialPage}
            saveLabel={t`Download PDF`}
            timeoutMessage={t`The PDF took too long to load. Try again, or open the article in your browser.`}
            onTextSelect={props.onPaperTextSelect}
            onPageChange={rememberPaperPdfPage}
            initialViewState={props.getFileViewState?.(activeFile)?.pdf}
            onViewState={(pdf) => props.onFileViewState?.(activeFile, { pdf })}
            onDocumentData={paperPdfView.objectUrl ? undefined : cacheActivePaperPdf}
            toolbarStart={(
              <Tip label={t({ message: `Back to ${{ view: paperReturnLabel }}` })}>
                <button type="button" onClick={closePaperPdf}>
                  <ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />
                </button>
              </Tip>
            )}
            toolbarEnd={activePaperBrowserUrl ? (
              <Tip label={paperBrowserActionLabel}>
                <button type="button" onClick={openActivePaperInBrowser}>
                  <ExternalLink size={14} aria-hidden="true" />
                </button>
              </Tip>
            ) : undefined}
          />
        </Suspense>
      </div>
    ) : <PdfPreviewLoading />
  ) : null;
  const paperPreview = props.activePaper ? (
    <section className="paper-reader-shell" aria-label={t({ message: `${{ title: props.activePaper.title }} paper reader` })}>
      {!paperPdfActive && <header className="paper-reader-header">{paperActions}</header>}
      {paperPdfPreview ?? markdownPreview}
    </section>
  ) : markdownPreview;
  const showTexChrome = activeFile.endsWith(".tex");
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
            <div
              className="editor-comment-popover"
              role="dialog"
              aria-label={t`Add comment`}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <p className="editor-comment-quote">{commentComposer.quote}</p>
              <Textarea
                autoFocus
                rows={3}
                placeholder={t`Leave a comment for collaborators…`}
                value={commentComposer.body}
                onChange={(event) => setCommentComposer((current) => (
                  current ? { ...current, body: event.target.value } : current
                ))}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeCommentComposer();
                  }
                  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                    event.preventDefault();
                    saveCommentComposer();
                  }
                }}
              />
              {commentComposer.error && <p role="alert" className="visual-node-source-error">{commentComposer.error}</p>}
              <div className="editor-comment-popover-actions">
                <button type="button" onClick={closeCommentComposer}>{t`Cancel`}</button>
                <button
                  type="button"
                  className="primary"
                  disabled={!commentComposer.body.trim()}
                  onClick={saveCommentComposer}
                >
                  {t`Add comment`}
                </button>
              </div>
            </div>
          )}
        </div>
        {showTexChrome && focusedPane === "primary" && (
          <MathPreview source={focusedSource} cursor={cursorOffset} macros={katexMacros} />
        )}
        <div className="editor-status-bar" aria-label={t`Editor status`}>
          <button type="button" className="status-goto" title={t`Go to line (⌘G)`} onClick={onGotoLineRequest}>
            {t({ message: `Ln ${{ line: statusPosition.line }}, Col ${{ column: statusPosition.column + 1 }}` })}
          </button>
          {editorKeymap === "vim" && (
            <span className="status-vim-mode" aria-live="polite" title={t`Vim mode`}>
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
                    title={t({ message: `Go to ${{ title: node.title }}` })}
                    onClick={() => onOutlineNavigate(node.path || focusedPath, node.line)}
                  >
                    {node.title}
                  </button>
                </span>
              ))}
            </span>
          )}
          <span className="status-hint" title={t`Editor shortcuts`}>
            {buildDiagnostics.length > 0
              ? <><kbd>F8</kbd> {t`next`} · <kbd>⇧F8</kbd> {t`previous`}</>
              : <><kbd>⌘F</kbd> {t`find`} · <kbd>⌘/</kbd> {t`comment`} · <kbd>⌘⇧I</kbd> {t`insert`}</>}
          </span>
          <button
            type="button"
            className={`status-todos status-comments${commentsForActiveFile.some((comment) => !comment.resolved) ? " has-todos" : ""}`}
            title={t`Editor comments`}
            onClick={onOpenEditorComments}
          >
            <MessageSquareText size={12} />
            {commentsForActiveFile.filter((comment) => !comment.resolved).length
              ? t({ message: `${{ count: commentsForActiveFile.filter((comment) => !comment.resolved).length }} comments` })
              : t`Comments`}
          </button>
          <button
            type="button"
            className={`status-todos status-manuscript-todos${props.todoCount ? " has-todos" : ""}`}
            title={t`Manuscript TODOs`}
            onClick={props.onOpenTodos}
          >
            <ListTodo size={12} />
            {props.todoCount ? t({ message: `${{ count: props.todoCount }} TODO` }) : t`TODOs`}
          </button>
          <span
            className="status-body-words"
            title={props.projectWordCount
              ? t({ message: `Body words (${{ source: props.projectWordCount.source === "texcount" ? "texcount" : t`estimate` }}): text ${{ text: props.projectWordCount.text }}, headers ${{ headers: props.projectWordCount.headers }}, captions ${{ captions: props.projectWordCount.captions }}` })
              : t`Body word count unavailable`}
          >
            {selectedText
              ? t({ message: `Sel ${{ words: selectionStats.words.toLocaleString() }} words · ${{ chars: selectionStats.chars.toLocaleString() }} chars · ${{ lines: selectionStats.lines.toLocaleString() }} lines` })
              : props.projectWordCount
                ? t({ message: `Body ${{ body: props.projectWordCount.total.toLocaleString() }} · raw ${{ raw: wordCount.toLocaleString() }} · ${{ chars: focusedSource.length.toLocaleString() }} chars` })
                : t({ message: `${{ words: wordCount.toLocaleString() }} words · ${{ chars: focusedSource.length.toLocaleString() }} chars` })}
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
          commentOnly={activeFile.toLocaleLowerCase().endsWith(".md") || !props.editorEditable}
          onAction={applySelectionAction}
          onDismiss={dismissSelectionToolbar}
        />
      )}
    </div>
  );
  const projectPdfPreview = (requestedPath: string) => {
    const previewPath = isPreviewableSourceFilePath(requestedPath)
      ? requestedPath
      : previewIdentity;
    return (
    <div
      className="pdf-column"
      data-tour="document-preview"
      onPointerDownCapture={() => props.onContextSurfaceActivate("pdf")}
      onFocusCapture={() => props.onContextSurfaceActivate("pdf")}
    >
      {props.pdfTop}
      <Suspense fallback={<PdfPreviewLoading />}>
        <PdfPreview
          key={`project-pdf:${previewPath}`}
          url={props.pdfUrl}
          pdfBase64={props.pdfBase64}
          pdfBytes={props.pdfBytes}
          syncTarget={props.pdfSyncTarget}
          canForwardSync={props.canForwardSync}
          locatingPdf={props.locatingPdf}
          onForwardSync={props.onForwardSync}
          // Reverse-jump to source needs an editor to land in. PDF-only view has
          // none, and neither does a dual layout whose panes are both previews
          // (or whose only other pane is an asset); those clicks stay inert and
          // the synctex cursor is off. With one pane still holding an editor the
          // jump goes there — App picks the pane, since it owns that state.
          onSource={props.mode === "pdf" || !props.canRevealPdfSource
            ? undefined
            : props.onPdfSource}
          onTextSelect={props.onPdfTextSelect}
          onNumPages={props.onPdfPageCount}
          onPageChange={props.onPdfPageChange}
          initialViewState={props.getFileViewState?.(previewPath)?.pdf}
          onViewState={(pdf) => props.onFileViewState?.(previewPath, { pdf })}
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
  const preview = props.activeAsset ? (
    <ProjectAssetPreview
      key={props.activeAsset.path}
      asset={props.activeAsset}
      viewState={props.getFileViewState?.(props.activeAsset.path)}
      onViewState={(update) => props.onFileViewState?.(props.activeAsset!.path, update)}
    />
  ) : markdownDocument ? paperPreview : htmlDocument ? (
    props.interactivePreviewsEnabled
      ? (
        <HtmlPreview
          key={activeFile}
          path={activeFile}
          source={props.source}
          initialViewState={props.getFileViewState?.(activeFile)?.html}
          onViewState={(html) => props.onFileViewState?.(activeFile, { html })}
        />
      )
      : <HtmlPreviewLoading />
  ) : projectPdfPreview(activeFile);
  const boardCollabForPath = (path: string) => {
    const session = props.collabSession;
    if (!props.collabReady || !session?.boardPresenceUser) return null;
    const sideloaded = session.boardDocumentForPath?.(path);
    if (sideloaded) {
      return {
        ...sideloaded,
        user: session.boardPresenceUser,
      };
    }
    return session.activePath === path
      ? {
        doc: session.doc,
        awareness: session.provider.awareness,
        user: session.boardPresenceUser,
        canWrite: session.canWrite !== false,
      }
      : null;
  };
  const spreadsheetCollabForPath = (path: string) => {
    const session = props.collabSession;
    if (!props.collabReady || !session?.boardPresenceUser) return null;
    const commit = async () => {
      await session.settled?.();
      await session.flush?.();
    };
    const sideloaded = session.spreadsheetDocumentForPath?.(path);
    if (sideloaded) {
      return {
        ...sideloaded,
        user: session.boardPresenceUser,
        commit,
      };
    }
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
  if (boardDocument && props.mode !== "dual" && props.mode !== "columns") {
    // Remount per file so each board gets a fresh store. In v2 collaboration
    // the path-specific Y.Doc carries records; local and v1 boards serialize
    // back through the source buffer before a document switch.
    return (
      <Suspense fallback={<div className="board-editor-root" aria-busy="true" aria-label={t`Preparing board editor`} />}>
        <BoardEditor
          key={activeFile}
          path={activeFile}
          source={props.source}
          onChange={(next) => setSourceRef.current(next)}
          collab={boardCollabForPath(activeFile)}
            initialViewState={props.getFileViewState?.(activeFile)?.board}
            onViewState={(board) => props.onFileViewState?.(activeFile, { board })}
          onFlushPendingChange={registerPrimaryVisualMarkdownFlush}
        />
      </Suspense>
    );
  }
  if (spreadsheetDocument && props.mode !== "dual" && props.mode !== "columns") {
    return (
      <Suspense fallback={<div className="spreadsheet-editor-root" aria-busy="true" aria-label={t`Preparing spreadsheet editor`} />}>
        <SpreadsheetEditor
          key={activeFile}
          path={activeFile}
          source={props.source}
          onChange={(next) => setSourceRef.current(next)}
          onPersist={props.onSave}
          collab={spreadsheetCollabForPath(activeFile)}
            initialViewState={props.getFileViewState?.(activeFile)?.spreadsheet}
            onViewState={(spreadsheet) => props.onFileViewState?.(activeFile, { spreadsheet })}
          onFlushPendingChange={registerPrimaryVisualMarkdownFlush}
        />
      </Suspense>
    );
  }
  if (paperPdfActive) return paperPreview;
  if (props.mode === "source") return editor;
  if (props.mode === "pdf") return preview;
  if (props.mode === "dual" || props.mode === "columns") {
    const focusSecondaryPane = () => {
      props.onContextSurfaceActivate("editor");
      if (selectionToolbarOwnerRef.current?.pane !== "secondary") {
        selectionToolbarOwnerRef.current = null;
        setSelectionToolbarPane(null);
        setSelectionToolbarPosition(null);
      }
      focusedPaneRef.current = "secondary";
      onFocusPane("secondary");
    };
    const dualSecondary = props.secondaryAsset ? (
      <div
        className={`dual-pane asset-pane ${focusedPane === "secondary" ? "focused" : ""}`}
        data-editor-pane="secondary"
        tabIndex={0}
        onPointerDownCapture={focusSecondaryPane}
        onFocus={focusSecondaryPane}
      >
        <ProjectAssetPreview
          key={props.secondaryAsset.path}
          asset={props.secondaryAsset}
          viewState={props.getFileViewState?.(props.secondaryAsset.path)}
          onViewState={(update) => props.onFileViewState?.(props.secondaryAsset!.path, update)}
        />
      </div>
    ) : secondaryFile?.toLocaleLowerCase().endsWith(".tldr") ? (
      <div
        className={`dual-pane ${focusedPane === "secondary" ? "focused" : ""}`}
        data-editor-pane="secondary"
        tabIndex={0}
        onPointerDownCapture={focusSecondaryPane}
        onFocusCapture={focusSecondaryPane}
      >
        <Suspense fallback={<div className="board-editor-root" aria-busy="true" aria-label={t`Preparing board editor`} />}>
          <BoardEditor
            key={secondaryFile}
            path={secondaryFile}
            source={secondarySource}
            onChange={(next) => setSecondarySourceRef.current(next)}
            collab={boardCollabForPath(secondaryFile)}
            initialViewState={props.getFileViewState?.(secondaryFile)?.board}
            onViewState={(board) => props.onFileViewState?.(secondaryFile, { board })}
            onFlushPendingChange={registerSecondaryVisualMarkdownFlush}
            active={focusedPane === "secondary"}
          />
        </Suspense>
      </div>
    ) : secondaryFile && isSpreadsheetPath(secondaryFile) ? (
      <div
        className={`dual-pane ${focusedPane === "secondary" ? "focused" : ""}`}
        data-editor-pane="secondary"
        tabIndex={0}
        onPointerDownCapture={focusSecondaryPane}
        onFocusCapture={focusSecondaryPane}
      >
        <Suspense fallback={<div className="spreadsheet-editor-root" aria-busy="true" aria-label={t`Preparing spreadsheet editor`} />}>
          <SpreadsheetEditor
            key={secondaryFile}
            path={secondaryFile}
            source={secondarySource}
            onChange={(next) => setSecondarySourceRef.current(next)}
            onPersist={props.onSave}
            collab={spreadsheetCollabForPath(secondaryFile)}
            initialViewState={props.getFileViewState?.(secondaryFile)?.spreadsheet}
            onViewState={(spreadsheet) => props.onFileViewState?.(secondaryFile, { spreadsheet })}
            onFlushPendingChange={registerSecondaryVisualMarkdownFlush}
            active={focusedPane === "secondary"}
          />
        </Suspense>
      </div>
    ) : secondaryFile ? (
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
        <div
          className={`source-editor ${props.fileDropTargetPane === "secondary" ? "file-drop-active" : ""}`}
          data-editor-pane="secondary"
        >
          <CodeMirror
            className="code-editor-root"
            value={secondarySource}
            extensions={secondaryEditorExtensions}
            onCreateEditor={(view) => {
              secondaryViewRef.current = view;
              setSecondaryScrollbarView(view);
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
        className={`dual-empty ${focusedPane === "secondary" ? "focused" : ""}`}
        data-editor-pane="secondary"
        tabIndex={0}
        aria-label={t`Empty secondary editor`}
        onPointerDownCapture={focusSecondaryPane}
        onFocus={focusSecondaryPane}
      >
        <Columns2 size={18} />
        <p>{t`Open or drag a file here.`}</p>
      </div>
    );
    const secondaryPreviewContent = secondaryFile?.toLocaleLowerCase().endsWith(".md") ? (
      <SecondaryMarkdownPreview
        key={secondaryFile}
        path={secondaryFile}
        source={secondarySource}
        onChange={(next) => setSecondarySourceRef.current(next)}
        onFlushPendingChange={registerSecondaryVisualMarkdownFlush}
        onEditSource={props.onViewMarkdownSource}
        onOpenProjectPath={props.onOpenMarkdownPath}
        workspaceIndex={props.workspaceIndex}
        papers={props.papers}
        macros={katexMacros}
        onImportAsset={props.onImportAsset}
        onLoadAsset={props.onLoadReferenceImage}
        editable={props.editorEditable}
        onSelectionMarkdown={(value) => setSelectionRef.current(value)}
        onCaretChange={(row, column) => {
          const line = row + 1;
          setStatusPosition({ line, column });
          props.onEditorPosition({ path: secondaryFile, line, column });
        }}
      />
    ) : secondaryFile && isHtmlFilePath(secondaryFile) ? (
      props.interactivePreviewsEnabled
        ? (
          <HtmlPreview
            key={secondaryFile}
            path={secondaryFile}
            source={secondarySource}
            initialViewState={props.getFileViewState?.(secondaryFile)?.html}
            onViewState={(html) => props.onFileViewState?.(secondaryFile, { html })}
          />
        )
        : <HtmlPreviewLoading />
    ) : projectPdfPreview(secondaryFile ?? activeFile);
    const dualSecondaryPreview = (
      <div
        className={`dual-pane-preview dual-pane ${focusedPane === "secondary" ? "focused" : ""}`}
        data-editor-pane="secondary"
        tabIndex={0}
        onPointerDownCapture={focusSecondaryPane}
        onFocusCapture={focusSecondaryPane}
      >
        {secondaryPreviewContent}
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
    const primaryPane = props.activeAsset ? (
      <div
        className={`dual-primary asset-pane ${focusedPane === "primary" ? "focused" : ""}`}
        data-editor-pane="primary"
        tabIndex={0}
        onPointerDownCapture={() => {
          props.onContextSurfaceActivate("editor");
          onFocusPane("primary");
        }}
        onFocus={() => {
          props.onContextSurfaceActivate("editor");
          onFocusPane("primary");
        }}
      >
        <ProjectAssetPreview
          key={props.activeAsset.path}
          asset={props.activeAsset}
          viewState={props.getFileViewState?.(props.activeAsset.path)}
          onViewState={(update) => props.onFileViewState?.(props.activeAsset!.path, update)}
        />
      </div>
    ) : boardDocument || spreadsheetDocument ? (
      <div
        className={`dual-primary ${focusedPane === "primary" ? "focused" : ""}`}
        data-editor-pane="primary"
        tabIndex={0}
        onPointerDownCapture={() => {
          props.onContextSurfaceActivate("editor");
          focusedPaneRef.current = "primary";
          onFocusPane("primary");
        }}
        onFocusCapture={() => {
          props.onContextSurfaceActivate("editor");
          focusedPaneRef.current = "primary";
          onFocusPane("primary");
        }}
      >
        <Suspense fallback={<div className={boardDocument ? "board-editor-root" : "spreadsheet-editor-root"} aria-busy="true" aria-label={boardDocument ? t`Preparing board editor` : t`Preparing spreadsheet editor`} />}>
          {boardDocument ? (
            <BoardEditor
              key={activeFile}
              path={activeFile}
              source={props.source}
              onChange={(next) => setSourceRef.current(next)}
              collab={boardCollabForPath(activeFile)}
              initialViewState={props.getFileViewState?.(activeFile)?.board}
              onViewState={(board) => props.onFileViewState?.(activeFile, { board })}
              onFlushPendingChange={registerPrimaryVisualMarkdownFlush}
              active={focusedPane === "primary"}
            />
          ) : (
            <SpreadsheetEditor
              key={activeFile}
              path={activeFile}
              source={props.source}
              onChange={(next) => setSourceRef.current(next)}
              onPersist={props.onSave}
              collab={spreadsheetCollabForPath(activeFile)}
              initialViewState={props.getFileViewState?.(activeFile)?.spreadsheet}
              onViewState={(spreadsheet) => props.onFileViewState?.(activeFile, { spreadsheet })}
              onFlushPendingChange={registerPrimaryVisualMarkdownFlush}
              active={focusedPane === "primary"}
            />
          )}
        </Suspense>
      </div>
    ) : (
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
    const dualPrimaryPreview = (
      <div
        className={`dual-pane-preview dual-primary ${focusedPane === "primary" ? "focused" : ""}`}
        data-editor-pane="primary"
        tabIndex={0}
        onPointerDownCapture={() => {
          focusedPaneRef.current = "primary";
          onFocusPane("primary");
        }}
        onFocusCapture={() => {
          focusedPaneRef.current = "primary";
          onFocusPane("primary");
        }}
      >
        {preview}
      </div>
    );
    const visiblePrimaryPane = props.dualPreviewPanes?.primary ? dualPrimaryPreview : primaryPane;
    const visibleSecondaryPane = props.dualPreviewPanes?.secondary
      ? dualSecondaryPreview
      : dualSecondary;
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
      return (
        <div
          ref={splitRef}
          className="split-canvas dual-canvas columns-canvas"
          style={{
            gridTemplateColumns: `minmax(160px, ${splitRatio * editorsShare}fr) 1px minmax(160px, ${(1 - splitRatio) * editorsShare}fr) 1px minmax(${SPLIT_PDF_MIN_WIDTH}px, ${columnsPdfRatio}fr)`,
          }}
        >
          {visiblePrimaryPane}
          {editorResizer}
          {visibleSecondaryPane}
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
        {visiblePrimaryPane}
        {editorResizer}
        {visibleSecondaryPane}
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
  const thumbFrameRef = useRef<number | null>(null);
  const scrollingTimerRef = useRef<number | null>(null);
  const lastScrollAtRef = useRef(0);
  const scrollingActiveRef = useRef(false);
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
    const nextHeight = `${thumbHeight}px`;
    const nextTransform = `translateY(${top}px)`;
    if (thumb.style.height !== nextHeight) thumb.style.height = nextHeight;
    if (thumb.style.transform !== nextTransform) thumb.style.transform = nextTransform;
  }, [view]);

  useEffect(() => {
    const scroller = view?.scrollDOM;
    if (!scroller) return;
    const scheduleThumbUpdate = () => {
      if (thumbFrameRef.current != null) return;
      thumbFrameRef.current = window.requestAnimationFrame(() => {
        thumbFrameRef.current = null;
        updateThumb();
      });
    };
    const finishScrolling = () => {
      const remaining = 180 - (performance.now() - lastScrollAtRef.current);
      if (remaining > 0) {
        scrollingTimerRef.current = window.setTimeout(finishScrolling, remaining);
        return;
      }
      scrollingTimerRef.current = null;
      scrollingActiveRef.current = false;
      setScrolling(false);
    };
    const handleScroll = () => {
      scheduleThumbUpdate();
      if (!scrollingActiveRef.current) {
        scrollingActiveRef.current = true;
        setScrolling(true);
      }
      lastScrollAtRef.current = performance.now();
      scrollingTimerRef.current ??= window.setTimeout(finishScrolling, 180);
    };
    const resizeObserver = new ResizeObserver(scheduleThumbUpdate);
    resizeObserver.observe(scroller);
    resizeObserver.observe(view.contentDOM);
    scroller.addEventListener("scroll", handleScroll, { passive: true });
    updateThumb();
    return () => {
      resizeObserver.disconnect();
      scroller.removeEventListener("scroll", handleScroll);
      if (thumbFrameRef.current != null) window.cancelAnimationFrame(thumbFrameRef.current);
      thumbFrameRef.current = null;
      if (scrollingTimerRef.current) window.clearTimeout(scrollingTimerRef.current);
      scrollingTimerRef.current = null;
      scrollingActiveRef.current = false;
    };
  }, [updateThumb, view]);

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    scrollingActiveRef.current = false;
    setScrolling(false);
  };

  return (
    <div
      className="cm-overlay-scrollbar"
      data-overflow={hasOverflow || undefined}
      data-scrolling={scrolling || undefined}
      aria-hidden="true"
      onPointerDown={(event) => {
        const scroller = event.currentTarget.parentElement
          ?.querySelector<HTMLElement>(".cm-scroller");
        if (!scroller || !hasOverflow) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        scrollingActiveRef.current = true;
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
        const scroller = event.currentTarget.parentElement
          ?.querySelector<HTMLElement>(".cm-scroller");
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

function ProjectAssetPreview({
  asset,
  viewState,
  onViewState,
}: {
  asset: AssetPreview;
  viewState?: FileViewState;
  onViewState?: (update: Partial<FileViewState>) => void;
}) {
  const { t } = useLingui();
  const url = `data:${asset.mimeType};base64,${asset.base64}`;
  const [initialImageViewState] = useState(viewState?.image);
  const [scale, setScale] = useState(initialImageViewState?.scale ?? 1);
  const scaleRef = useRef(scale);
  const onViewStateRef = useRef(onViewState);
  const [zoomDraft, setZoomDraft] = useState("100");
  const [zoomEditing, setZoomEditing] = useState(false);
  const imageMinScale = 0.3;
  const imageMaxScale = 5;
  const updateScale = (next: number | ((current: number) => number)) => {
    setScale((current) => clamp(
      typeof next === "function" ? next(current) : next,
      imageMinScale,
      imageMaxScale,
    ));
  };
  const commitZoomDraft = () => {
    const percent = Number(zoomDraft.trim().replace(/%$/, ""));
    if (Number.isFinite(percent) && percent > 0) updateScale(percent / 100);
    setZoomEditing(false);
  };
  const zoomLabelRef = useRef<HTMLLabelElement | null>(null);
  const stageViewportRef = useRef<HTMLDivElement | null>(null);
  const imageViewRestoredRef = useRef(false);
  useLayoutEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
  useLayoutEffect(() => {
    onViewStateRef.current = onViewState;
  }, [onViewState]);
  useLayoutEffect(() => {
    if (asset.mimeType === "application/pdf") return;
    const viewport = stageViewportRef.current;
    if (!viewport) return;
    const frame = window.requestAnimationFrame(() => {
      if (initialImageViewState) {
        viewport.scrollTop = initialImageViewState.scrollTop;
        viewport.scrollLeft = initialImageViewState.scrollLeft ?? 0;
      }
      imageViewRestoredRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [asset.mimeType, initialImageViewState]);
  useEffect(() => {
    if (!imageViewRestoredRef.current || asset.mimeType === "application/pdf") return;
    const viewport = stageViewportRef.current;
    onViewStateRef.current?.({
      image: {
        scale,
        scrollTop: viewport?.scrollTop ?? 0,
        scrollLeft: viewport?.scrollLeft ?? 0,
      },
    });
  }, [asset.mimeType, scale]);
  useEffect(() => () => {
    const viewport = stageViewportRef.current;
    if (!imageViewRestoredRef.current || asset.mimeType === "application/pdf") return;
    onViewStateRef.current?.({
      image: {
        scale: scaleRef.current,
        scrollTop: viewport?.scrollTop ?? 0,
        scrollLeft: viewport?.scrollLeft ?? 0,
      },
    });
  }, [asset.mimeType]);
  useNonPassiveWheel(zoomLabelRef, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!event.deltaY) return;
    updateScale((current) => Number((current + (event.deltaY < 0 ? 0.1 : -0.1)).toFixed(1)));
  });
  useNonPassiveWheel(stageViewportRef, (event) => {
    if (!(event.metaKey || event.ctrlKey) || !event.deltaY) return;
    event.preventDefault();
    updateScale((current) => Number((current * Math.exp(-event.deltaY * 0.01)).toFixed(3)));
  });
  if (asset.mimeType === "application/pdf") {
    const pdfBytes = pdfBase64ToBytes(asset.base64);
    return (
      <Suspense fallback={<PdfPreviewLoading />}>
        <PdfPreview
          key={url}
          url={url}
          pdfBase64={asset.base64}
          pdfBytes={pdfBytes.buffer}
          fileName={asset.path.split("/").pop() ?? "figure.pdf"}
          initialViewState={viewState?.pdf}
          onViewState={(pdf) => onViewStateRef.current?.({ pdf })}
        />
      </Suspense>
    );
  }
  return (
    <div className="asset-preview">
      <div className="asset-preview-heading">
        <Image size={14} />
        <span>{asset.path}</span>
        <small>{t`Drop project files here to open them, or drag this into a TeX or Markdown editor to insert it.`}</small>
        {asset.mimeType.startsWith("image/") && (
          <div className="asset-preview-zoom-controls">
            <Tip label={t`Zoom out`}>
              <button
                type="button"
                disabled={scale <= imageMinScale}
                onClick={() => updateScale((current) => Number((current - 0.1).toFixed(1)))}
              >
                <ZoomOut size={14} aria-hidden="true" />
              </button>
            </Tip>
            <label
              ref={zoomLabelRef}
              className="asset-preview-zoom-value"
              title={t`Enter a zoom percentage or scroll to zoom`}
            >
              <input
                aria-label={t`Image zoom percentage`}
                inputMode="decimal"
                value={zoomEditing ? zoomDraft : String(Math.round(scale * 100))}
                onFocus={(event) => {
                  const input = event.currentTarget;
                  setZoomEditing(true);
                  setZoomDraft(String(Math.round(scale * 100)));
                  requestAnimationFrame(() => input.select());
                }}
                onChange={(event) => setZoomDraft(event.target.value)}
                onBlur={commitZoomDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <span aria-hidden="true">%</span>
            </label>
            <Tip label={t`Zoom in`}>
              <button
                type="button"
                disabled={scale >= imageMaxScale}
                onClick={() => updateScale((current) => Number((current + 0.1).toFixed(1)))}
              >
                <ZoomIn size={14} aria-hidden="true" />
              </button>
            </Tip>
          </div>
        )}
      </div>
      <ScrollArea
        className="asset-preview-stage"
        orientation="both"
        contentClassName="asset-preview-stage-content"
        viewportRef={stageViewportRef}
        viewportProps={{
          onScroll: (event) => {
            if (!imageViewRestoredRef.current) return;
            const viewport = event.currentTarget;
            onViewStateRef.current?.({
              image: {
                scale: scaleRef.current,
                scrollTop: viewport.scrollTop,
                scrollLeft: viewport.scrollLeft,
              } satisfies ImageFileViewState,
            });
          },
        }}
      >
        {asset.mimeType.startsWith("image/")
          ? <img src={url} alt={t({ message: `Preview of ${{ path: asset.path }}` })} style={{ zoom: scale }} />
          : <div className="asset-preview-unsupported"><FileText size={28} /><p>{t`This format cannot be rendered in the preview.`}</p></div>}
      </ScrollArea>
    </div>
  );
}
