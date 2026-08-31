import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
// The *legacy* build, deliberately. pdf.js's default build targets engines
// newer than the WKWebView on supported macOS versions; there it silently fails
// to decode embedded Type1 font programs, reports every font as `missingFile`,
// and falls back to `sans-serif` — a LaTeX paper renders in Helvetica instead of
// its embedded Times. The legacy build decodes the same fonts correctly.
import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import pdfWorker from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Download,
  FileText,
  LocateFixed,
  RectangleHorizontal,
  RectangleVertical,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Tip } from "../components/icon-tip";
import { InfinityLoader } from "../components/ui/activity-icons";
import { ScrollArea } from "../components/ui/scroll-area";
import { SearchField } from "../components/ui/search-field";
import {
  pdfBase64Fingerprint,
  pdfBase64ToBytes,
  pdfBytesFingerprint,
  utf8ToBase64,
} from "./pdf-bytes";
import { MotionButton } from "../components/ui/motion";
import { installPdfTextLayerSelection } from "./pdf-text-layer-selection";
import {
  annotationBounds,
  closestPdfPageIndex,
  findPdfMatches,
  fitPdfScale,
  layoutPdfPages,
  normalizePdfSelection,
  parsePdfZoomPercent,
  pdfPageWindow,
  PdfCooperativeRenderQueue,
  PdfRenderQueue,
  pdfChromiumRenderPixelRatio,
  pdfRenderPixelRatio,
  PDF_CMAP_URL,
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  PDF_RENDER_PRIORITY,
  PDF_STANDARD_FONT_DATA_URL,
  type PdfPageSize,
  type PdfRenderCancellation,
} from "./pdf-viewer-utils";
import "./pdf-viewer.css";
import { logAction, notifyError } from "../telemetry/app-notify";
import type { PdfFileViewState } from "../app-types";
import { useNonPassiveWheel } from "../hooks/use-non-passive-wheel";
import { isBundledChromium } from "../platform/browser-runtime";

/** Notification source label for the PDF preview. */
const PDF_SOURCE = "PDF";

GlobalWorkerOptions.workerSrc = pdfWorker;

const PDF_LOAD_TIMEOUT_MS = 45_000;
const PDF_VIEW_PREFERENCE_KEY = "lattice.pdf-view-preference.v1";
/** Quiet period a fit-mode resize waits for before re-rasterizing pages. */
const PDF_REFIT_SETTLE_MS = 120;
/** Keep expensive full-resolution refinement off the scrolling hot path. */
const PDF_SCROLL_REFINE_SETTLE_MS = 120;
/** Every quick first paint outranks every full-resolution refinement. */
const PDF_PREVIEW_PRIORITY_OFFSET = PDF_RENDER_PRIORITY.current + 1;
const PDF_PAGE_GAP = 18;

type PdfViewPreference = {
  fitMode: "width" | "height" | null;
  scale: number;
};

function loadPdfViewPreference(): PdfViewPreference {
  try {
    const stored = JSON.parse(localStorage.getItem(PDF_VIEW_PREFERENCE_KEY) ?? "null") as unknown;
    if (!stored || typeof stored !== "object") return { fitMode: "width", scale: 1.1 };
    const candidate = stored as Partial<PdfViewPreference>;
    const fitMode = candidate.fitMode === "height" || candidate.fitMode === null ? candidate.fitMode : "width";
    const scale = typeof candidate.scale === "number" && Number.isFinite(candidate.scale)
      ? clamp(candidate.scale, PDF_MIN_SCALE, PDF_MAX_SCALE)
      : 1.1;
    return { fitMode, scale };
  } catch {
    return { fitMode: "width", scale: 1.1 };
  }
}

export type PdfSyncTarget = {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

type PdfAnnotation = {
  id?: string;
  subtype?: string;
  rect?: number[];
  url?: string;
  unsafeUrl?: string;
  dest?: string | unknown[];
  title?: string;
};

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function textFromContent(content: Awaited<ReturnType<PDFPageProxy["getTextContent"]>>) {
  return content.items
    .flatMap((item) => ("str" in item && typeof item.str === "string" ? [item.str] : []))
    .join(" ");
}

function highlightTextLayer(
  container: HTMLElement,
  rawQuery: string,
  selectedOccurrence: number | null,
) {
  for (const mark of container.querySelectorAll<HTMLElement>("mark.pdf-text-match")) {
    const parent = mark.parentNode;
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
    parent?.normalize();
  }
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return;

  let occurrence = 0;
  let selectedMark: HTMLElement | null = null;
  const spans = Array.from(container.querySelectorAll<HTMLElement>("span"))
    .filter((span) => !span.querySelector("span"));
  for (const span of spans) {
    const text = span.textContent ?? "";
    const normalized = text.toLocaleLowerCase();
    let from = 0;
    const parts: Node[] = [];
    while (from <= normalized.length - query.length) {
      const index = normalized.indexOf(query, from);
      if (index < 0) break;
      if (index > from) parts.push(document.createTextNode(text.slice(from, index)));
      const mark = document.createElement("mark");
      mark.className = "pdf-text-match";
      mark.textContent = text.slice(index, index + query.length);
      if (occurrence === selectedOccurrence) {
        mark.classList.add("selected");
        selectedMark = mark;
      }
      parts.push(mark);
      occurrence += 1;
      from = index + query.length;
    }
    if (parts.length) {
      if (from < text.length) parts.push(document.createTextNode(text.slice(from)));
      span.replaceChildren(...parts);
    }
  }
  if (selectedMark && typeof selectedMark.scrollIntoView === "function") {
    selectedMark.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
  }
}

function PdfLinkLayer({
  annotations,
  onDestination,
}: {
  annotations: PdfAnnotation[];
  onDestination: (destination: string | unknown[]) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="pdf-annotation-layer" aria-label={t`PDF links`}>
      {annotations.flatMap((annotation, index) => {
        const bounds = annotation.rect ? annotationBounds(annotation.rect, 1) : null;
        if (!bounds || bounds.width <= 0 || bounds.height <= 0) return [];
        const style = {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        };
        const url = annotation.url ?? annotation.unsafeUrl;
        if (url) {
          return [(
            <a
              key={annotation.id ?? index}
              className="pdf-link-annotation"
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              title={annotation.title ?? url}
              style={style}
            />
          )];
        }
        if (annotation.dest) {
          return [(
            <button
              key={annotation.id ?? index}
              className="pdf-link-annotation"
              title={annotation.title ?? t`Go to linked PDF location`}
              style={style}
              onClick={() => onDestination(annotation.dest!)}
            />
          )];
        }
        return [];
      })}
    </div>
  );
}

/** Hoisted out of the component: try/finally bodies make the React Compiler bail out. */
async function downloadCompiledPdf(
  pdfBytes: ArrayBuffer,
  fileName: string,
  setSavingPdf: (value: boolean) => void,
  labels: {
    title: string;
    document: string;
    action: string;
    saved: (path: string) => string;
  },
): Promise<void> {
  const trace = logAction(PDF_SOURCE, labels.action, fileName);
  try {
    const destination = await saveDialog({
      title: labels.title,
      defaultPath: fileName,
      filters: [{ name: labels.document, extensions: ["pdf"] }],
    });
    if (!destination) return;
    const savedPath = await invoke<string>("save_compiled_pdf", pdfBytes, {
      headers: { "x-pdf-destination": utf8ToBase64(destination) },
    });
    trace.ok(labels.saved(savedPath));
  } catch (reason) {
    trace.fail(reason);
  } finally {
    setSavingPdf(false);
  }
}

type PdfPageViewport = ReturnType<PDFPageProxy["getViewport"]>;

async function renderPdfPageCanvas(ctx: {
  page: PDFPageProxy;
  canvas: HTMLCanvasElement;
  pixelRatio: number;
  cssViewport: PdfPageViewport;
  holdRenderTask: (task: RenderTask) => void;
}) {
  const { page, canvas, pixelRatio, cssViewport } = ctx;
  canvas.width = Math.floor(cssViewport.width * pixelRatio);
  canvas.height = Math.floor(cssViewport.height * pixelRatio);
  canvas.style.width = `${Math.floor(cssViewport.width)}px`;
  canvas.style.height = `${Math.floor(cssViewport.height)}px`;
  const context = canvas.getContext("2d", { alpha: false });
  if (context) {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.fillStyle = "#F9F9FA";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const renderTask = page.render({
    canvasContext: context as CanvasRenderingContext2D,
    // Match PDF.js's desktop viewer: keep layout in CSS-pixel coordinates and
    // apply output scale at the canvas boundary. Chromium can then raster once
    // at device resolution instead of painting and replacing a 1× bitmap.
    transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
    viewport: cssViewport,
    intent: "display",
  });
  ctx.holdRenderTask(renderTask);
  await renderTask.promise;
}

/**
 * Produce the first complete canvas. Chromium paints it directly at output
 * scale; WKWebView paints a CSS-pixel preview and refines it after scrolling.
 * Search, selection, links, and SyncTeX use separate DOM layers in both paths.
 */
async function renderContinuousPagePreview(ctx: {
  page: PDFPageProxy;
  canvas: HTMLCanvasElement;
  textContainer: HTMLDivElement;
  scale: number;
  pixelRatio: number;
  pageNumber: number;
  isAlive: () => boolean;
  holdRenderTask: (task: RenderTask) => void;
  holdTextLayer: (layer: TextLayer) => void;
  setRendering: (value: boolean) => void;
  setPageError: (value: string) => void;
  setAnnotations: (items: PdfAnnotation[]) => void;
  onTextLayerText: (page: number, text: string) => void;
  onTextLayerRendered: (container: HTMLDivElement) => void;
  bumpTextLayerVersion: () => void;
}): Promise<boolean> {
  const { page, canvas, textContainer, scale, pixelRatio, pageNumber } = ctx;
  ctx.setRendering(true);
  ctx.setPageError("");
  try {
    const cssViewport = page.getViewport({ scale });
    textContainer.replaceChildren();
    void page.getAnnotations({ intent: "display" }).then((items) => {
      if (!ctx.isAlive()) return;
      ctx.setAnnotations((items as PdfAnnotation[]).map((annotation) => ({
        ...annotation,
        rect: annotation.rect
          ? [
              ...cssViewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]),
              ...cssViewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]),
            ]
          : undefined,
      })));
    }).catch(() => {
      if (ctx.isAlive()) ctx.setAnnotations([]);
    });
    await renderPdfPageCanvas({
      page,
      canvas,
      pixelRatio,
      cssViewport,
      holdRenderTask: ctx.holdRenderTask,
    });
    if (!ctx.isAlive()) return false;
    ctx.setRendering(false);

    // A selectable text layer is useful, but it must not hold a scarce
    // canvas-render slot or keep a completed page hidden behind its loader.
    const textLayer = new TextLayer({
      textContentSource: page.streamTextContent(),
      container: textContainer,
      viewport: cssViewport,
    });
    ctx.holdTextLayer(textLayer);
    void textLayer.render()
      .then(() => {
        if (!ctx.isAlive()) return;
        ctx.onTextLayerRendered(textContainer);
        ctx.onTextLayerText(pageNumber, textContainer.textContent ?? "");
        ctx.bumpTextLayerVersion();
      })
      .catch(() => {
        // A cancelled or malformed text layer must not hide a valid canvas.
      });
    return true;
  } catch (reason) {
    if (!ctx.isAlive()) return false;
    const detail = message(reason);
    const errorName = reason && typeof reason === "object" && "name" in reason
      ? String(reason.name)
      : "";
    if (
      errorName !== "RenderingCancelledException"
      && !/messageHandler|worker is being destroyed/i.test(detail)
    ) {
      ctx.setPageError(detail);
    }
    return false;
  } finally {
    if (ctx.isAlive()) ctx.setRendering(false);
  }
}

/** Render high-DPI pixels offscreen, then replace the preview in one paint. */
async function refineContinuousPage(ctx: {
  page: PDFPageProxy;
  canvas: HTMLCanvasElement;
  scale: number;
  pixelRatio: number;
  isAlive: () => boolean;
  holdRenderTask: (task: RenderTask) => void;
}): Promise<void> {
  const offscreen = document.createElement("canvas");
  try {
    const cssViewport = ctx.page.getViewport({ scale: ctx.scale });
    await renderPdfPageCanvas({
      page: ctx.page,
      canvas: offscreen,
      pixelRatio: ctx.pixelRatio,
      cssViewport,
      holdRenderTask: ctx.holdRenderTask,
    });
    if (!ctx.isAlive()) return;
    const context = ctx.canvas.getContext("2d", { alpha: false });
    if (!context) return;
    // Resizing and copying happen in the same main-thread task, so the browser
    // presents either the preview or the complete refined bitmap, never a blank
    // or partially drawn high-resolution canvas.
    ctx.canvas.width = offscreen.width;
    ctx.canvas.height = offscreen.height;
    ctx.canvas.style.width = offscreen.style.width;
    ctx.canvas.style.height = offscreen.style.height;
    context.drawImage(offscreen, 0, 0);
  } catch {
    // A valid preview is already visible. Cancellation or refinement failure
    // must not replace it with an error or disturb its interaction layers.
  } finally {
    offscreen.width = 0;
    offscreen.height = 0;
  }
}

/** Keep cancellation try/catch out of the hot page component for React Compiler. */
function cancelContinuousPageWork(
  renderTask: RenderTask | null,
  textLayer: TextLayer | null,
) {
  try {
    renderTask?.cancel();
    textLayer?.cancel();
  } catch {
    // Worker may already be gone during PDF rebuilds.
  }
}

const ContinuousPdfPage = memo(function ContinuousPdfPage({
  documentProxy,
  pageNumber,
  scale,
  current,
  scrolling,
  bundledChromium,
  pageAcquireQueue,
  renderQueue,
  searchQuery,
  selectedSearchOccurrence,
  syncTarget,
  onPageSize,
  onTextLayerText,
  onSource,
  onDestination,
}: {
  documentProxy: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  current: boolean;
  scrolling: boolean;
  bundledChromium: boolean;
  pageAcquireQueue: PdfRenderQueue;
  renderQueue: PdfCooperativeRenderQueue;
  searchQuery: string;
  selectedSearchOccurrence: number | null;
  syncTarget: PdfSyncTarget | null;
  onPageSize: (page: number, size: PdfPageSize) => void;
  onTextLayerText: (page: number, text: string) => void;
  onSource?: (page: number, x: number, y: number) => void;
  onDestination: (destination: string | unknown[]) => void;
}) {
  const { t } = useLingui();
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  // Inactive canvases are cleared to release their backing stores. Keep their
  // next activation in loading state so a fast scroll never exposes that zero-
  // sized canvas while its queued render is waiting to start.
  const [rendering, setRendering] = useState(true);
  const [previewScale, setPreviewScale] = useState<number | null>(null);
  const [refinedScale, setRefinedScale] = useState<number | null>(null);
  const [textLayerVersion, setTextLayerVersion] = useState(0);
  const [pageError, setPageError] = useState("");
  const initialPriority = current ? PDF_RENDER_PRIORITY.current : PDF_RENDER_PRIORITY.nearby;
  const priorityRef = useRef(initialPriority);
  const acquireJobRef = useRef<PdfRenderCancellation | null>(null);
  const previewJobRef = useRef<PdfRenderCancellation | null>(null);
  const refinementJobRef = useRef<PdfRenderCancellation | null>(null);

  useEffect(() => {
    const priority = current ? PDF_RENDER_PRIORITY.current : PDF_RENDER_PRIORITY.nearby;
    priorityRef.current = priority;
    acquireJobRef.current?.setPriority(priority);
    previewJobRef.current?.setPriority(PDF_PREVIEW_PRIORITY_OFFSET + priority);
    refinementJobRef.current?.setPriority(priority);
  }, [current]);

  useEffect(() => {
    if (page) return;
    let alive = true;
    const cancelQueuedAcquire = pageAcquireQueue.enqueue(async () => {
      try {
        const nextPage = await documentProxy.getPage(pageNumber);
        if (alive) {
          const viewport = nextPage.getViewport({ scale: 1 });
          onPageSize(pageNumber, { width: viewport.width, height: viewport.height });
          setPage(nextPage);
        }
      } catch (reason) {
        if (!alive) return;
        // Destroyed workers surface as messageHandler null — treat as cancelled.
        const detail = message(reason);
        if (/messageHandler|worker is being destroyed|RenderingCancelled/i.test(detail)) {
          setRendering(false);
          return;
        }
        setPageError(detail);
        setRendering(false);
      }
    }, priorityRef.current);
    acquireJobRef.current = cancelQueuedAcquire;
    return () => {
      alive = false;
      if (acquireJobRef.current === cancelQueuedAcquire) acquireJobRef.current = null;
      cancelQueuedAcquire();
    };
  }, [documentProxy, onPageSize, page, pageAcquireQueue, pageNumber]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textContainer = textLayerRef.current;
    if (!page || !canvas || !textContainer) return;
    let alive = true;
    let previewTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    let uninstallTextSelection: (() => void) | null = null;
    const cssViewport = page.getViewport({ scale });
    const fullPixelRatio = bundledChromium
      ? pdfChromiumRenderPixelRatio(window.devicePixelRatio || 1, cssViewport)
      : pdfRenderPixelRatio(window.devicePixelRatio || 1, cssViewport);
    // Chromium follows the PDF.js desktop viewer and paints once at output
    // scale. WK keeps the progressive first paint that avoids scroll stalls on
    // the fallback renderer.
    const previewPixelRatio = bundledChromium ? fullPixelRatio : Math.min(1, fullPixelRatio);
    const cancelQueuedPreview = renderQueue.enqueue(async (onContinue) => {
      if (!alive) return;
      const completed = await renderContinuousPagePreview({
        page,
        canvas,
        textContainer,
        scale,
        pixelRatio: previewPixelRatio,
        pageNumber,
        isAlive: () => alive,
        holdRenderTask: (task) => {
          previewTask = task;
          task.onContinue = (continuation: () => void) => {
            onContinue(continuation);
          };
        },
        holdTextLayer: (layer) => { textLayer = layer; },
        setRendering,
        setPageError,
        setAnnotations,
        onTextLayerText,
        onTextLayerRendered: (container) => {
          uninstallTextSelection?.();
          uninstallTextSelection = installPdfTextLayerSelection(container);
        },
        bumpTextLayerVersion: () => setTextLayerVersion((version) => version + 1),
      });
      if (!alive || !completed) return;
      setPreviewScale(scale);
      if (fullPixelRatio <= previewPixelRatio) setRefinedScale(scale);
    }, PDF_PREVIEW_PRIORITY_OFFSET + priorityRef.current);
    previewJobRef.current = cancelQueuedPreview;
    return () => {
      alive = false;
      if (previewJobRef.current === cancelQueuedPreview) previewJobRef.current = null;
      cancelQueuedPreview();
      uninstallTextSelection?.();
      uninstallTextSelection = null;
      cancelContinuousPageWork(previewTask, textLayer);
    };
  }, [bundledChromium, onTextLayerText, page, pageNumber, renderQueue, scale]);

  useEffect(() => {
    if (
      bundledChromium
      || scrolling
      || previewScale !== scale
      || refinedScale === scale
    ) return;
    const canvas = canvasRef.current;
    if (!page || !canvas) return;
    const cssViewport = page.getViewport({ scale });
    const fullPixelRatio = pdfRenderPixelRatio(window.devicePixelRatio || 1, cssViewport);
    if (fullPixelRatio <= 1) return;
    let alive = true;
    let refinementSettled = false;
    let refinementTask: RenderTask | null = null;
    const cancelQueuedRefinement = renderQueue.enqueue(async (onContinue) => {
      await refineContinuousPage({
        page,
        canvas,
        scale,
        pixelRatio: fullPixelRatio,
        isAlive: () => alive,
        holdRenderTask: (task) => {
          refinementTask = task;
          task.onContinue = (continuation: () => void) => {
            onContinue(continuation);
          };
        },
      });
      refinementSettled = true;
      // A failed refinement leaves the valid preview in place. Record the
      // attempt so a malformed page cannot retry forever while it is visible.
      if (alive) setRefinedScale(scale);
    }, priorityRef.current);
    refinementJobRef.current = cancelQueuedRefinement;
    return () => {
      alive = false;
      if (refinementJobRef.current === cancelQueuedRefinement) refinementJobRef.current = null;
      cancelQueuedRefinement();
      if (!refinementSettled) cancelContinuousPageWork(refinementTask, null);
    };
  }, [bundledChromium, current, page, previewScale, refinedScale, renderQueue, scale, scrolling]);

  useEffect(() => {
    const container = textLayerRef.current;
    if (container) {
      highlightTextLayer(
        container,
        searchQuery,
        selectedSearchOccurrence,
      );
    }
  }, [searchQuery, selectedSearchOccurrence, textLayerVersion]);

  useEffect(() => () => {
    if (page && typeof page.cleanup === "function") page.cleanup();
  }, [page]);

  const revealSourceAt = (clientX: number, clientY: number) => {
    if (!onSource || !shellRef.current) return;
    const bounds = shellRef.current.getBoundingClientRect();
    onSource(
      pageNumber,
      Number(((clientX - bounds.left) / scale).toFixed(3)),
      Number(((clientY - bounds.top) / scale).toFixed(3)),
    );
  };
  const revealSourceFromCanvas = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSource) return;
    revealSourceAt(event.clientX, event.clientY);
  };
  const revealSourceFromText = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!onSource) return;
    // Double-click to jump, so single-click and drag stay free for selecting and
    // copying text. A double-click auto-selects the word under it, so don't treat
    // that selection as a reason to skip the jump.
    event.preventDefault();
    revealSourceAt(event.clientX, event.clientY);
  };
  const pageSyncTarget = syncTarget?.page === pageNumber ? syncTarget : null;

  return (
    <div
      ref={shellRef}
      className="pdf-page-content"
      style={{
        "--scale-factor": scale,
        "--total-scale-factor": scale,
      } as React.CSSProperties}
      aria-busy={rendering}
    >
      <canvas
        ref={canvasRef}
        className={onSource ? "synctex-enabled" : ""}
        onDoubleClick={revealSourceFromCanvas}
        aria-label={t`PDF page ${pageNumber}`}
      />
      <div
        ref={textLayerRef}
        className="textLayer pdf-text-layer"
        onDoubleClick={revealSourceFromText}
      />
      <PdfLinkLayer annotations={annotations} onDestination={onDestination} />
      {pageSyncTarget && (
        <div
          key={pageSyncTarget.id}
          className="pdf-synctex-highlight"
          style={{
            left: pageSyncTarget.x * scale,
            top: pageSyncTarget.y * scale,
            width: Math.max(18, pageSyncTarget.width * scale),
            height: Math.max(12, pageSyncTarget.height * scale),
          }}
          aria-label={t`Source location in PDF`}
        />
      )}
      {rendering && <div className="pdf-page-skeleton" aria-hidden="true" />}
      {pageError && <div className="pdf-page-error">{t`Could not render page ${pageNumber}. ${pageError}`}</div>}
    </div>
  );
});

export function PdfPreview({
  url,
  pdfBase64,
  pdfBytes = null,
  fileName = "paper.pdf",
  syncTarget = null,
  onSource,
  canForwardSync = false,
  locatingPdf = false,
  onForwardSync,
  onTextSelect,
  onNumPages,
  onPageChange,
  onDocumentData,
  initialPage = 1,
  initialViewState,
  onViewState,
  showSave = true,
  saveLabel,
  timeoutMessage,
  outline,
  toolbarStart,
  toolbarEnd,
}: {
  url: string | null;
  pdfBase64: string | null;
  pdfBytes?: ArrayBuffer | null;
  fileName?: string;
  syncTarget?: PdfSyncTarget | null;
  onSource?: (page: number, x: number, y: number) => void;
  canForwardSync?: boolean;
  locatingPdf?: boolean;
  onForwardSync?: () => void;
  onTextSelect?: (text: string) => void;
  onNumPages?: (pages: number | null) => void;
  onPageChange?: (page: number) => void;
  /** Complete bytes assembled by PDF.js after a URL load, suitable for caching. */
  onDocumentData?: (bytes: ArrayBuffer) => void;
  initialPage?: number;
  initialViewState?: PdfFileViewState;
  onViewState?: (state: PdfFileViewState) => void;
  showSave?: boolean;
  saveLabel?: string;
  timeoutMessage?: string;
  outline?: ReactNode;
  /** Context-specific actions rendered before the page controls. */
  toolbarStart?: ReactNode;
  /** Context-specific icon actions rendered before the save control. */
  toolbarEnd?: ReactNode;
}) {
  const { t } = useLingui();
  const bundledChromium = isBundledChromium();
  const effectiveSaveLabel = saveLabel ?? t`Save PDF as…`;
  const effectiveTimeoutMessage = timeoutMessage ?? t`PDF preview timed out. Click Build again, or open the PDF in Preview.`;
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const onTextSelectRef = useRef(onTextSelect);
  const onNumPagesRef = useRef(onNumPages);
  const onPageChangeRef = useRef(onPageChange);
  const onDocumentDataRef = useRef(onDocumentData);
  const onViewStateRef = useRef(onViewState);
  const [initialViewStateSnapshot] = useState(initialViewState);
  useLayoutEffect(() => {
    onTextSelectRef.current = onTextSelect;
    onNumPagesRef.current = onNumPages;
    onPageChangeRef.current = onPageChange;
    onDocumentDataRef.current = onDocumentData;
    onViewStateRef.current = onViewState;
  }, [onDocumentData, onNumPages, onPageChange, onTextSelect, onViewState]);
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [documentGeneration, setDocumentGeneration] = useState(0);
  const [pageNumber, setPageNumber] = useState(() => Math.max(
    1,
    Math.floor(initialViewStateSnapshot?.page ?? initialPage),
  ));
  const pageNumberRef = useRef(pageNumber);
  useEffect(() => {
    pageNumberRef.current = pageNumber;
    onPageChangeRef.current?.(pageNumber);
  }, [pageNumber]);
  const [pageEditing, setPageEditing] = useState(false);
  const [pageDraft, setPageDraft] = useState("");
  const cancelPageEditRef = useRef(false);
  const [initialViewPreference] = useState(() => {
    const saved = initialViewStateSnapshot;
    return saved
      ? {
          fitMode: saved.fitMode,
          scale: clamp(saved.scale, PDF_MIN_SCALE, PDF_MAX_SCALE),
        }
      : loadPdfViewPreference();
  });
  const [scale, setScale] = useState(initialViewPreference.scale);
  const [fitMode, setFitMode] = useState<"width" | "height" | null>(initialViewPreference.fitMode);
  const [pageSize, setPageSize] = useState<PdfPageSize | null>(null);
  const [pageSizes, setPageSizes] = useState<ReadonlyMap<number, PdfPageSize>>(() => new Map());
  const pageGeometry = useMemo(() => layoutPdfPages(
    documentProxy?.numPages ?? 0,
    pageSizes,
    { width: 612, height: 792 },
    scale,
    PDF_PAGE_GAP,
  ), [documentProxy, pageSizes, scale]);
  const pageGeometryRef = useRef(pageGeometry);
  useLayoutEffect(() => {
    pageGeometryRef.current = pageGeometry;
  }, [pageGeometry]);
  const [mountedPageWindow, setMountedPageWindow] = useState({ start: 0, end: 1 });
  const pendingGeometryAnchorRef = useRef<{ pageIndex: number; offset: number } | null>(null);
  // Canvas2D executes on the WebView thread. Keep one page painting at a time
  // so pre-rendering cannot contend with compositor scrolling; metadata/page
  // acquisition stays two-wide because that work is handled by the PDF worker.
  const [renderQueue] = useState(() => new PdfCooperativeRenderQueue());
  const pageAcquireQueue = useMemo(() => {
    // A newly loaded PDF must not wait behind page acquisitions for the old one.
    void documentGeneration;
    return new PdfRenderQueue(2);
  }, [documentGeneration]);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState("");
  const [savingPdf, setSavingPdf] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndexRequested, setSearchIndexRequested] = useState(false);
  const [pageTexts, setPageTexts] = useState<string[]>([]);
  const pageTextsRef = useRef<string[]>([]);
  pageTextsRef.current = pageTexts;
  const [searchError, setSearchError] = useState("");
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [zoomEditing, setZoomEditing] = useState(false);
  const [zoomDraft, setZoomDraft] = useState("");
  const scaleRef = useRef(scale);
  const fitModeRef = useRef(fitMode);
  const viewStateFrameRef = useRef<number | null>(null);
  const viewStateReadyRef = useRef(!initialViewStateSnapshot);
  useLayoutEffect(() => {
    scaleRef.current = scale;
    fitModeRef.current = fitMode;
  }, [fitMode, scale]);
  const reportViewState = useCallback(() => {
    viewStateFrameRef.current = null;
    if (!viewStateReadyRef.current) return;
    const area = scrollAreaRef.current;
    onViewStateRef.current?.({
      page: pageNumberRef.current,
      scale: scaleRef.current,
      fitMode: fitModeRef.current,
      scrollTop: area?.scrollTop ?? 0,
      scrollLeft: area?.scrollLeft ?? 0,
    });
  }, []);
  const scheduleViewState = useCallback(() => {
    if (viewStateFrameRef.current === null) {
      viewStateFrameRef.current = window.requestAnimationFrame(reportViewState);
    }
  }, [reportViewState]);
  useEffect(() => scheduleViewState(), [pageNumber, scheduleViewState]);
  useEffect(() => {
    try {
      localStorage.setItem(PDF_VIEW_PREFERENCE_KEY, JSON.stringify({ fitMode, scale }));
    } catch {
      // The current viewer still works when preference storage is unavailable.
    }
    scheduleViewState();
  }, [fitMode, scale, scheduleViewState]);
  const updateManualScale = useCallback((update: (current: number) => number) => {
    setFitMode(null);
    setScale(update);
  }, []);
  const zoomValueLabelRef = useRef<HTMLLabelElement | null>(null);
  useNonPassiveWheel(zoomValueLabelRef, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!event.deltaY) return;
    updateManualScale((value) => clamp(
      Number((value + (event.deltaY < 0 ? 0.1 : -0.1)).toFixed(1)),
      PDF_MIN_SCALE,
      PDF_MAX_SCALE,
    ));
  });
  // Trackpad pinch on macOS (and ctrl+scroll) arrives as a wheel event with
  // ctrlKey set. Zoom continuously and keep the point under the cursor fixed.
  const pendingZoomAnchorRef = useRef<{ x: number; y: number; prevScale: number } | null>(null);
  // Live pinch state: a factor applied as a CSS transform until the gesture
  // settles, plus where the fingers started so the page stays put under them.
  const [zoomFactor, setZoomFactor] = useState(1);
  const zoomFactorRef = useRef(1);
  const gestureAnchorRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const desiredScrollRef = useRef<{ left: number; top: number } | null>(null);
  const commitZoomTimerRef = useRef<number | null>(null);
  useEffect(() => {
    const area = scrollAreaRef.current;
    if (!area) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const prev = scaleRef.current;
      const next = clamp(Number((prev * Math.exp(-event.deltaY * 0.01)).toFixed(3)), PDF_MIN_SCALE, PDF_MAX_SCALE);
      if (next === prev) return;
      setFitMode(null);
      const rect = area.getBoundingClientRect();
      pendingZoomAnchorRef.current = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        prevScale: prev,
      };
      setScale(next);
    };
    // Passive:false so preventDefault stops the webview's own page zoom.
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => area.removeEventListener("wheel", onWheel);
  }, []);
  // Neither the ctrl+wheel path above nor WebKit's gesture events below are
  // actually delivered for a trackpad pinch in this embedded webview, so the
  // Rust side watches AppKit's raw magnify events and forwards them here.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen<{ magnification: number; x: number; y: number }>("trackpad-magnify", (event) => {
      const area = scrollAreaRef.current;
      if (!area) return;
      const rect = area.getBoundingClientRect();
      const { magnification, x, y } = event.payload;
      // The monitor is app-wide, so only zoom when the pinch is over the PDF.
      if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
      setFitMode(null);
      // A pinch fires dozens of times a second, and every committed scale
      // change cancels and restarts the page render — that restart loop is
      // what made zooming stutter. Scale the pixels we already have (cheap,
      // and the browser does it on the GPU) and re-render once at the end.
      if (!gestureAnchorRef.current) {
        gestureAnchorRef.current = {
          x: x - rect.left,
          y: y - rect.top,
          scrollLeft: area.scrollLeft,
          scrollTop: area.scrollTop,
        };
      }
      const anchor = gestureAnchorRef.current;
      const committed = scaleRef.current;
      const factor = zoomFactorRef.current * (1 + magnification);
      // Keep the total zoom inside the same bounds the buttons use.
      const bounded = clamp(committed * factor, PDF_MIN_SCALE, PDF_MAX_SCALE) / committed;
      zoomFactorRef.current = bounded;
      setZoomFactor(bounded);
      // The transform scales content the same way a real re-render will, so
      // the scroll offset that keeps the pinch point still is the final one.
      desiredScrollRef.current = {
        left: (anchor.scrollLeft + anchor.x) * bounded - anchor.x,
        top: (anchor.scrollTop + anchor.y) * bounded - anchor.y,
      };
      area.scrollLeft = desiredScrollRef.current.left;
      area.scrollTop = desiredScrollRef.current.top;

      if (commitZoomTimerRef.current) window.clearTimeout(commitZoomTimerRef.current);
      commitZoomTimerRef.current = window.setTimeout(() => {
        commitZoomTimerRef.current = null;
        const factorNow = zoomFactorRef.current;
        gestureAnchorRef.current = null;
        zoomFactorRef.current = 1;
        setZoomFactor(1);
        if (factorNow === 1) return;
        setScale((current) => clamp(Number((current * factorNow).toFixed(3)), PDF_MIN_SCALE, PDF_MAX_SCALE));
      }, 160);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
  // Kept as a fallback for platforms where WebKit does deliver gesture events.
  useEffect(() => {
    const area = scrollAreaRef.current;
    if (!area) return;
    // `scale` on a gesture event is cumulative since gesturestart, so zooming
    // is anchored to the scale the pinch began at rather than compounding.
    let startScale = scaleRef.current;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      startScale = scaleRef.current;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      if (typeof gesture.scale !== "number") return;
      const prev = scaleRef.current;
      const next = clamp(Number((startScale * gesture.scale).toFixed(3)), PDF_MIN_SCALE, PDF_MAX_SCALE);
      if (next === prev) return;
      setFitMode(null);
      const rect = area.getBoundingClientRect();
      pendingZoomAnchorRef.current = {
        x: (gesture.clientX ?? rect.left + rect.width / 2) - rect.left,
        y: (gesture.clientY ?? rect.top + rect.height / 2) - rect.top,
        prevScale: prev,
      };
      setScale(next);
    };
    const onGestureEnd = (event: Event) => event.preventDefault();
    area.addEventListener("gesturestart", onGestureStart, { passive: false });
    area.addEventListener("gesturechange", onGestureChange, { passive: false });
    area.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      area.removeEventListener("gesturestart", onGestureStart);
      area.removeEventListener("gesturechange", onGestureChange);
      area.removeEventListener("gestureend", onGestureEnd);
    };
  }, []);
  useLayoutEffect(() => {
    const area = scrollAreaRef.current;
    if (!area) return;
    // A pinch already scrolled to the right place, but a transform does not
    // grow the scrollable area, so the browser clamped it. Now that the pages
    // really are bigger, put it exactly where the gesture asked for.
    const desired = desiredScrollRef.current;
    if (desired) {
      desiredScrollRef.current = null;
      pendingZoomAnchorRef.current = null;
      area.scrollLeft = desired.left;
      area.scrollTop = desired.top;
      return;
    }
    const anchor = pendingZoomAnchorRef.current;
    if (!anchor) return;
    pendingZoomAnchorRef.current = null;
    const ratio = scale / anchor.prevScale;
    area.scrollLeft = (area.scrollLeft + anchor.x) * ratio - anchor.x;
    area.scrollTop = (area.scrollTop + anchor.y) * ratio - anchor.y;
  }, [scale]);

  // Local PDFs already have complete bytes. Avoid asking an older WKWebView
  // worker to fetch the blob: URL; remote URLs must stay URL-backed so PDF.js
  // can keep using range requests and stream the first page.
  const byteSource = pdfBytes && (!url || url.startsWith("blob:")) ? pdfBytes : null;
  const loadKey = byteSource
    ? `bytes:${pdfBytesFingerprint(byteSource)}`
    : pdfBase64
      ? `b64:${pdfBase64Fingerprint(pdfBase64)}`
      : (url ? `url:${url}` : "");
  const documentProxyRef = useRef<PDFDocumentProxy | null>(null);
  documentProxyRef.current = documentProxy;
  const pdfSourceRef = useRef({ byteSource, pdfBase64, url });
  pdfSourceRef.current = { byteSource, pdfBase64, url };
  // Coalesce rapid rebuild fingerprints before calling getDocument — otherwise
  // each latexmk metadata change cancels the previous load and the first paint
  // never finishes (“Rendering PDF…” forever).
  const [stableLoadKey, setStableLoadKey] = useState("");
  useEffect(() => {
    if (!loadKey) {
      setStableLoadKey("");
      return;
    }
    const delayMs = documentProxyRef.current ? 900 : 120;
    const timer = window.setTimeout(() => setStableLoadKey(loadKey), delayMs);
    return () => window.clearTimeout(timer);
  }, [loadKey]);

  useEffect(() => {
    if (!stableLoadKey) {
      const previous = documentProxyRef.current;
      documentProxyRef.current = null;
      setDocumentProxy(null);
      setPageSize(null);
      setPageSizes(new Map());
      setLoadedUrl(null);
      onNumPagesRef.current?.(null);
      void previous?.cleanup();
      return;
    }
    let active = true;
    let dataTimer: number | null = null;
    const {
      byteSource: currentBytes,
      pdfBase64: currentBase64,
      url: currentUrl,
    } = pdfSourceRef.current;
    const source = currentBytes
      // PDF.js transfers this buffer to its worker. Send a copy so saving the
      // PDF later does not receive a detached, zero-byte original.
      ? { data: new Uint8Array(currentBytes.slice(0)) }
      : currentBase64
        ? { data: pdfBase64ToBytes(currentBase64) }
        : { url: currentUrl! };
    const loadingTask = getDocument({
      ...source,
      cMapUrl: PDF_CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
      // WKWebView can accept an embedded Type 1 font through FontFace but then
      // paint none of its glyphs. PDF.js sees a successful font load, so the
      // page completes without an error and only non-text vectors remain.
      // Drawing the embedded glyph outlines bypasses that native font path while
      // preserving the separate selectable text layer.
      disableFontFace: true,
      useSystemFonts: false,
    });
    const timeout = window.setTimeout(() => {
      if (!active) return;
      // Keep any already-visible PDF; only surface the error if we have nothing.
      if (!documentProxyRef.current) {
        setPdfError(effectiveTimeoutMessage);
      }
      setLoadedUrl(stableLoadKey);
      void Promise.resolve(loadingTask.destroy()).catch(() => undefined);
    }, PDF_LOAD_TIMEOUT_MS);
    void loadingTask.promise
      .then(async (pdf) => {
        if (!active) {
          void pdf.cleanup();
          return;
        }
        const previous = documentProxyRef.current;
        const retainedPage = Math.min(pageNumberRef.current, pdf.numPages);
        documentProxyRef.current = pdf;
        const initialWindowStart = Math.max(0, Math.min(pdf.numPages - 10, retainedPage - 5));
        setMountedPageWindow({
          start: initialWindowStart,
          end: Math.min(pdf.numPages, initialWindowStart + 10),
        });
        setPageSizes(new Map());
        setDocumentGeneration((generation) => generation + 1);
        setDocumentProxy(pdf);
        if (previous && previous !== pdf) {
          void previous.cleanup();
        }
        setPageTexts([]);
        setSearchError("");
        setPageNumber(retainedPage);
        setPdfError("");
        onNumPagesRef.current?.(pdf.numPages);
        try {
          const first = await pdf.getPage(1);
          if (!active) return;
          const viewport = first.getViewport({ scale: 1 });
          const firstSize = { width: viewport.width, height: viewport.height };
          setPageSize(firstSize);
          setPageSizes((current) => new Map(current).set(1, firstSize));
          if (!currentBytes && !currentBase64 && onDocumentDataRef.current) {
            // Let the first page win the network/render queue. PDF.js then
            // assembles the remaining ranged response once and hands those
            // same bytes to the app cache — no second download.
            dataTimer = window.setTimeout(() => {
              void pdf.getData()
                .then((data) => {
                  if (!active) return;
                  onDocumentDataRef.current?.(new Uint8Array(data).buffer);
                })
                .catch(() => undefined);
            }, 750);
          }
        } catch {
          if (active) setPageSize(null);
        }
      })
      .catch((reason) => {
        if (!active) return;
        // Do not blank an already-visible preview on a failed refresh.
        if (!documentProxyRef.current) {
          setPdfError(message(reason));
          onNumPagesRef.current?.(null);
        }
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (active) setLoadedUrl(stableLoadKey);
      });
    return () => {
      active = false;
      window.clearTimeout(timeout);
      if (dataTimer !== null) window.clearTimeout(dataTimer);
      // Keep the current document on screen while a newer load is cancelled —
      // clearing it here caused endless “Rendering PDF…” during autosave builds.
      void Promise.resolve(loadingTask.destroy()).catch(() => undefined);
    };
  }, [stableLoadKey, effectiveTimeoutMessage]);

  const applyFit = useCallback((mode: "width" | "height") => {
    const area = scrollAreaRef.current;
    if (!area || !pageSize) return;
    setScale(fitPdfScale(mode, pageSize, {
      width: area.clientWidth,
      height: area.clientHeight,
    }));
  }, [pageSize]);

  const toggleFit = useCallback((mode: "width" | "height") => {
    if (fitMode === mode) {
      setFitMode(null);
      return;
    }
    setFitMode(mode);
    applyFit(mode);
  }, [applyFit, fitMode]);

  useEffect(() => {
    const area = scrollAreaRef.current;
    if (!area || !fitMode || typeof ResizeObserver === "undefined") return;
    let settle: ReturnType<typeof setTimeout> | null = null;
    // Dragging the split divider resizes this element on every pointer frame,
    // and the fitted scale is quantized to 1%, so a single drag walks through
    // dozens of distinct scales. Each one reallocates and re-rasterizes the
    // canvas of every page near the viewport, all of it discarded by the next
    // frame — the divider itself deliberately stays out of React for the same
    // reason. Let the width settle, then fit once.
    const observer = new ResizeObserver(() => {
      if (settle) clearTimeout(settle);
      settle = setTimeout(() => {
        settle = null;
        applyFit(fitMode);
      }, PDF_REFIT_SETTLE_MS);
    });
    observer.observe(area);
    applyFit(fitMode);
    return () => {
      observer.disconnect();
      if (settle) clearTimeout(settle);
    };
  }, [applyFit, fitMode]);

  const commitZoomDraft = () => {
    const next = parsePdfZoomPercent(zoomDraft);
    if (next !== null) updateManualScale(() => next);
    setZoomEditing(false);
    setZoomDraft("");
  };

  const fittedPageSizeRef = useRef<PdfPageSize | null>(null);
  useEffect(() => {
    if (!pageSize || !loadedUrl || !fitMode) return;
    const previous = fittedPageSizeRef.current;
    if (
      previous
      && Math.abs(previous.width - pageSize.width) < 0.5
      && Math.abs(previous.height - pageSize.height) < 0.5
    ) {
      return;
    }
    let cancelled = false;
    let attempts = 0;
    const tryFit = () => {
      if (cancelled) return;
      const area = scrollAreaRef.current;
      if (!area || area.clientWidth < 8) {
        if (attempts < 40) {
          attempts += 1;
          requestAnimationFrame(tryFit);
        }
        return;
      }
      fittedPageSizeRef.current = pageSize;
      applyFit(fitMode);
    };
    const frame = requestAnimationFrame(tryFit);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [applyFit, fitMode, loadedUrl, pageSize]);

  useEffect(() => {
    if (!documentProxy || !searchIndexRequested) return;
    let active = true;
    // Index only after search is used. Eager extraction competes with visible
    // canvas work on the same PDF.js worker during ordinary scrolling.
    const timer = window.setTimeout(() => {
      // Read pages sequentially. Asking one worker to extract every page at
      // once can reject the whole index while its text layers still render.
      void (async () => {
        const results: PromiseSettledResult<string>[] = [];
        for (let index = 0; index < documentProxy.numPages; index += 1) {
          try {
            const page = await documentProxy.getPage(index + 1);
            results.push({ status: "fulfilled", value: textFromContent(await page.getTextContent()) });
          } catch (reason) {
            results.push({ status: "rejected", reason });
          }
        }
        return results;
      })()
        .then((results) => {
          if (!active) return;
          // A rendered text layer is a valid fallback when direct extraction
          // failed; this also keeps the counter consistent with visible yellow
          // highlights instead of incorrectly reporting "Unavailable".
          const texts = results.map((result, index) => (
            result.status === "fulfilled" && result.value.trim()
              ? result.value
              : (pageTextsRef.current[index] ?? "")
          ));
          pageTextsRef.current = texts;
          setPageTexts(texts);
          const firstFailure = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (firstFailure && !texts.some((text) => text.trim())) {
            setSearchError(t`Search unavailable: ${message(firstFailure.reason)}`);
          } else {
            // A malformed page must not disable search for every other page.
            setSearchError("");
          }
        })
        .catch((reason) => {
          if (!active) return;
          const detail = message(reason);
          if (/messageHandler|worker is being destroyed/i.test(detail)) return;
          setPageTexts(Array.from({ length: documentProxy.numPages }, () => ""));
          setSearchError(t`Search unavailable: ${detail}`);
        });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [documentProxy, searchIndexRequested, t]);

  const storeRenderedPageText = useCallback((page: number, text: string) => {
    if (!documentProxy || !text.trim()) return;
    const texts = pageTextsRef.current.length === documentProxy.numPages
      ? [...pageTextsRef.current]
      : Array.from({ length: documentProxy.numPages }, (_, index) => pageTextsRef.current[index] ?? "");
    texts[page - 1] = text;
    pageTextsRef.current = texts;
    setPageTexts(texts);
    setSearchError("");
  }, [documentProxy]);

  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;
    let lastReported = "";
    const reportFromSelection = () => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        if (lastReported) {
          lastReported = "";
          onTextSelectRef.current?.("");
        }
        return;
      }
      const anchor = selection.anchorNode;
      if (!anchor || !root.contains(anchor)) return;
      const next = normalizePdfSelection(selection.toString());
      if (next !== lastReported) {
        lastReported = next;
        onTextSelectRef.current?.(next);
      }
    };
    const onMouseUp = () => {
      window.requestAnimationFrame(reportFromSelection);
    };
    root.addEventListener("mouseup", onMouseUp);
    root.addEventListener("keyup", reportFromSelection);
    document.addEventListener("selectionchange", reportFromSelection);
    return () => {
      root.removeEventListener("mouseup", onMouseUp);
      root.removeEventListener("keyup", reportFromSelection);
      document.removeEventListener("selectionchange", reportFromSelection);
    };
  }, [onTextSelect, loadedUrl, documentProxy]);

  const matches = useMemo(
    () => findPdfMatches(pageTexts, searchQuery),
    [pageTexts, searchQuery],
  );
  const selectedMatchIndex = clamp(searchMatchIndex, 0, Math.max(0, matches.length - 1));
  const selectedMatch = matches[selectedMatchIndex] ?? null;
  const loading = Boolean(loadKey && loadedUrl !== loadKey);
  const showBlockingLoader = loading && !documentProxy;
  const searchIndexing = Boolean(documentProxy && pageTexts.length !== documentProxy.numPages);

  const [pdfScrolling, setPdfScrolling] = useState(false);
  const pdfScrollingRef = useRef(false);
  const scrollIdleTimerRef = useRef<number | null>(null);
  const currentPageFrameRef = useRef<number | null>(null);
  const pageContentTop = useCallback(() => {
    const firstPage = pagesRef.current?.firstElementChild as HTMLElement | null;
    return firstPage?.offsetTop ?? 0;
  }, []);
  const storePageSize = useCallback((page: number, size: PdfPageSize) => {
    setPageSizes((current) => {
      const previous = current.get(page);
      if (
        previous
        && Math.abs(previous.width - size.width) < 0.01
        && Math.abs(previous.height - size.height) < 0.01
      ) return current;
      const area = scrollAreaRef.current;
      const geometry = pageGeometryRef.current.pages;
      if (area && geometry.length) {
        const viewportTop = area.scrollTop - pageContentTop();
        const anchor = closestPdfPageIndex(
          geometry.length,
          (index) => geometry[index],
          viewportTop,
        );
        pendingGeometryAnchorRef.current = {
          pageIndex: anchor,
          offset: viewportTop - geometry[anchor].top,
        };
      }
      const next = new Map(current);
      next.set(page, size);
      return next;
    });
  }, [pageContentTop]);
  useLayoutEffect(() => {
    const anchor = pendingGeometryAnchorRef.current;
    const area = scrollAreaRef.current;
    const geometry = pageGeometry.pages[anchor?.pageIndex ?? -1];
    if (!anchor || !area || !geometry) return;
    pendingGeometryAnchorRef.current = null;
    area.scrollTop = pageContentTop() + geometry.top + anchor.offset;
  }, [pageContentTop, pageGeometry]);
  const findCurrentPage = useCallback(() => {
    currentPageFrameRef.current = null;
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;
    const geometry = pageGeometryRef.current.pages;
    if (!geometry.length) return;
    const viewportTop = scrollArea.scrollTop - pageContentTop();
    const marker = viewportTop + Math.min(scrollArea.clientHeight * 0.35, 240);
    const index = closestPdfPageIndex(geometry.length, (candidate) => geometry[candidate], marker);
    if (index >= 0) {
      const nextPage = index + 1;
      setPageNumber((current) => current === nextPage ? current : nextPage);
      const nextWindow = pdfPageWindow(
        geometry,
        viewportTop,
        scrollArea.clientHeight,
        index,
      );
      setMountedPageWindow((current) => (
        current.start === nextWindow.start && current.end === nextWindow.end ? current : nextWindow
      ));
    }
  }, [pageContentTop]);
  const updateCurrentPage = useCallback(() => {
    scheduleViewState();
    if (!pdfScrollingRef.current) {
      pdfScrollingRef.current = true;
      setPdfScrolling(true);
    }
    if (scrollIdleTimerRef.current !== null) {
      window.clearTimeout(scrollIdleTimerRef.current);
    }
    scrollIdleTimerRef.current = window.setTimeout(() => {
      scrollIdleTimerRef.current = null;
      pdfScrollingRef.current = false;
      setPdfScrolling(false);
    }, PDF_SCROLL_REFINE_SETTLE_MS);
    if (currentPageFrameRef.current !== null) return;
    currentPageFrameRef.current = window.requestAnimationFrame(findCurrentPage);
  }, [findCurrentPage, scheduleViewState]);
  useEffect(() => () => {
    if (scrollIdleTimerRef.current !== null) {
      window.clearTimeout(scrollIdleTimerRef.current);
      scrollIdleTimerRef.current = null;
    }
    if (currentPageFrameRef.current !== null) {
      window.cancelAnimationFrame(currentPageFrameRef.current);
      currentPageFrameRef.current = null;
    }
    if (viewStateFrameRef.current !== null) {
      window.cancelAnimationFrame(viewStateFrameRef.current);
      viewStateFrameRef.current = null;
    }
    reportViewState();
  }, [reportViewState]);

  const scrollToPage = useCallback((nextPage: number, behavior: ScrollBehavior = "smooth") => {
    const scrollArea = scrollAreaRef.current;
    const geometry = pageGeometryRef.current.pages[nextPage - 1];
    if (!scrollArea || !geometry) return;
    setPageNumber(nextPage);
    setMountedPageWindow(pdfPageWindow(
      pageGeometryRef.current.pages,
      geometry.top,
      scrollArea.clientHeight,
      nextPage - 1,
    ));
    const top = Math.max(0, pageContentTop() + geometry.top - 20);
    if (typeof scrollArea.scrollTo === "function") {
      scrollArea.scrollTo({ top, behavior });
    } else {
      scrollArea.scrollTop = top;
    }
  }, [pageContentTop]);

  useEffect(() => {
    const requestedPage = initialViewStateSnapshot?.page ?? initialPage;
    if (!documentProxy || requestedPage <= 1) return;
    const target = clamp(Math.floor(requestedPage), 1, documentProxy.numPages);
    const frame = window.requestAnimationFrame(() => scrollToPage(target, "auto"));
    return () => window.cancelAnimationFrame(frame);
  }, [documentProxy, initialPage, initialViewStateSnapshot, scrollToPage]);

  const initialScrollRestoredRef = useRef(false);
  useEffect(() => {
    const saved = initialViewStateSnapshot;
    const area = scrollAreaRef.current;
    if (!saved || !documentProxy || !area || initialScrollRestoredRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      area.scrollTop = saved.scrollTop;
      area.scrollLeft = saved.scrollLeft;
      initialScrollRestoredRef.current = true;
      viewStateReadyRef.current = true;
      updateCurrentPage();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [documentProxy, initialViewStateSnapshot, updateCurrentPage]);

  const commitPageDraft = () => {
    if (cancelPageEditRef.current) {
      cancelPageEditRef.current = false;
      setPageEditing(false);
      setPageDraft("");
      return;
    }
    const requested = Number.parseInt(pageDraft, 10);
    if (documentProxy && Number.isFinite(requested)) {
      scrollToPage(clamp(requested, 1, documentProxy.numPages));
    }
    setPageEditing(false);
    setPageDraft("");
  };

  useEffect(() => {
    updateCurrentPage();
  }, [documentProxy, pageSizes, scale, updateCurrentPage]);

  useEffect(() => {
    if (selectedMatch) scrollToPage(selectedMatch.page);
  }, [scrollToPage, selectedMatch]);

  useEffect(() => {
    if (syncTarget) scrollToPage(syncTarget.page);
  }, [scrollToPage, syncTarget]);

  const navigateDestination = useCallback(async (destination: string | unknown[]) => {
    if (!documentProxy) return;
    try {
      const explicit = typeof destination === "string"
        ? await documentProxy.getDestination(destination)
        : destination;
      const reference = explicit?.[0];
      if (!reference) return;
      const pageIndex = typeof reference === "number"
        ? reference
        : await documentProxy.getPageIndex(reference);
      scrollToPage(pageIndex + 1);
    } catch (reason) {
      notifyError(PDF_SOURCE, t`Could not open PDF link`, { detail: message(reason) });
    }
  }, [documentProxy, scrollToPage, t]);
  const pages = useMemo(
    () => documentProxy
      ? Array.from({ length: documentProxy.numPages }, (_, index) => index + 1)
      : [],
    [documentProxy],
  );

  if (!loadKey) {
    return (
      <div className="pdf-preview">
        <div className="pdf-toolbar pdf-toolbar-empty">
          <div className="pdf-page-controls" />
          <div className="pdf-find-controls">
            {outline}
            <SearchField
              aria-label={t`Search PDF`}
              containerClassName="pdf-search disabled"
              controlSize="compact"
              placeholder={t`Find in PDF`}
              disabled
              value=""
            />
          </div>
          <div className="pdf-zoom-controls" />
        </div>
        <div className="pdf-placeholder"><FileText size={28} /><p>{t`Build the project to preview the paper`}</p></div>
      </div>
    );
  }

  const download = () => {
    if (!pdfBytes || savingPdf) return;
    setSavingPdf(true);
    void downloadCompiledPdf(pdfBytes, fileName, setSavingPdf, {
      title: t`Save compiled PDF`,
      document: t`PDF document`,
      action: t`Save PDF`,
      saved: (path) => t`Saved to ${path}`,
    });
  };
  const selectMatch = (delta: number) => {
    if (!matches.length) return;
    setSearchMatchIndex((index) => (index + delta + matches.length) % matches.length);
  };

  return (
    <div className="pdf-preview">
      <div className="pdf-toolbar">
        <div className="pdf-navigation-controls">
          {toolbarStart}
          <div className="pdf-page-controls">
            <Tip label={t`Previous page`}>
              <button disabled={pageNumber <= 1} onClick={() => scrollToPage(Math.max(1, pageNumber - 1))}><ChevronLeft size={14} /></button>
            </Tip>
            <label className={`pdf-page-value${pageEditing ? " editing" : ""}`} title={t`Enter a page number`}>
              <input
                aria-label={t`PDF page number`}
                inputMode="numeric"
                value={pageEditing ? pageDraft : String(pageNumber)}
                style={{ width: pageEditing ? `${Math.max(1, pageDraft.length)}ch` : undefined }}
                onFocus={(event) => {
                  const input = event.currentTarget;
                  cancelPageEditRef.current = false;
                  setPageEditing(true);
                  setPageDraft(String(pageNumber));
                  requestAnimationFrame(() => input.select());
                }}
                onChange={(event) => {
                  if (/^\d*$/.test(event.target.value)) setPageDraft(event.target.value);
                }}
                onBlur={commitPageDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    cancelPageEditRef.current = true;
                    event.currentTarget.blur();
                  }
                }}
              />
              {pageEditing
                ? <span className="pdf-page-total">/ {documentProxy?.numPages ?? "–"}</span>
                : <span className="pdf-page-display" aria-hidden="true">{pageNumber} / {documentProxy?.numPages ?? "–"}</span>}
            </label>
            <Tip label={t`Next page`}>
              <button disabled={!documentProxy || pageNumber >= documentProxy.numPages} onClick={() => scrollToPage(Math.min(documentProxy?.numPages ?? pageNumber, pageNumber + 1))}><ChevronRight size={14} /></button>
            </Tip>
          </div>
        </div>
        <div className="pdf-find-controls">
          {outline}
          <SearchField
            aria-label={t`Search PDF`}
            containerClassName="pdf-search"
            controlSize="compact"
            showIcon={!searchQuery}
            value={searchQuery}
            placeholder={t`Find in PDF`}
            onChange={(event) => {
              const query = event.target.value;
              setSearchQuery(query);
              if (query.trim()) setSearchIndexRequested(true);
              setSearchMatchIndex(0);
            }}
            trailing={searchQuery ? (
              <>
                <small className="pdf-search-position" aria-live="polite" title={searchError || undefined}>{searchError ? t`Unavailable` : searchIndexing ? t`Indexing…` : matches.length ? `${selectedMatchIndex + 1} / ${matches.length}` : "0 / 0"}</small>
                <Tip label={t`Previous search result`}>
                  <button type="button" disabled={!matches.length} onClick={() => selectMatch(-1)}><ChevronUp size={12} /></button>
                </Tip>
                <Tip label={t`Next search result`}>
                  <button type="button" disabled={!matches.length} onClick={() => selectMatch(1)}><ChevronDown size={12} /></button>
                </Tip>
                <Tip label={t`Clear PDF search`}>
                  <button type="button" onClick={() => setSearchQuery("")}><X size={12} /></button>
                </Tip>
              </>
            ) : undefined}
          />
        </div>
        <div className="pdf-zoom-controls">
          <Tip label={t`Zoom out`}>
            <button disabled={scale <= PDF_MIN_SCALE} onClick={() => updateManualScale((value) => clamp(Number((value - 0.1).toFixed(1)), PDF_MIN_SCALE, PDF_MAX_SCALE))}><ZoomOut size={14} /></button>
          </Tip>
          <label
            ref={zoomValueLabelRef}
            className="pdf-zoom-value"
            title={t`Enter a zoom percentage or scroll to zoom`}
          >
            <input
              aria-label={t`PDF zoom percentage`}
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
            <span>%</span>
          </label>
          <Tip label={t`Zoom in`}>
            <button disabled={scale >= PDF_MAX_SCALE} onClick={() => updateManualScale((value) => clamp(Number((value + 0.1).toFixed(1)), PDF_MIN_SCALE, PDF_MAX_SCALE))}><ZoomIn size={14} /></button>
          </Tip>
          <i className="pdf-fit-divider" aria-hidden="true" />
          {onForwardSync && (
            <>
              <Tip label={t`Reveal cursor in PDF (⌘⇧J)`}>
                <button
                  type="button"
                  disabled={!canForwardSync || locatingPdf}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={onForwardSync}
                >
                  {locatingPdf
                    ? <InfinityLoader size={14} />
                    : <LocateFixed size={14} />}
                </button>
              </Tip>
              <i className="pdf-fit-divider" aria-hidden="true" />
            </>
          )}
          <Tip label={t`Fit page to width`}>
            <button className={fitMode === "width" ? "active" : ""} aria-pressed={fitMode === "width"} disabled={!pageSize} onClick={() => toggleFit("width")}><RectangleHorizontal size={14} /></button>
          </Tip>
          <Tip label={t`Fit page to height`}>
            <button className={fitMode === "height" ? "active" : ""} aria-pressed={fitMode === "height"} disabled={!pageSize} onClick={() => toggleFit("height")}><RectangleVertical size={14} /></button>
          </Tip>
          {toolbarEnd}
          {showSave && (
            <Tip label={effectiveSaveLabel}>
              <MotionButton disabled={!pdfBytes || savingPdf} onClick={() => void download()}>{savingPdf ? <InfinityLoader size={14} /> : <Download size={14} />}</MotionButton>
            </Tip>
          )}
        </div>
      </div>
      <ScrollArea
        className="pdf-scroll-area"
        orientation="both"
        fadeEdges={false}
        viewportRef={scrollAreaRef}
        viewportClassName="pdf-scroll-area-viewport"
        contentClassName="pdf-scroll-area-content"
        viewportProps={{ onScroll: updateCurrentPage }}
      >
        {pdfError
          ? <div className="pdf-placeholder"><CircleAlert size={24} /><p>{pdfError}</p></div>
          : <div
            ref={pagesRef}
            className="pdf-pages"
            style={zoomFactor === 1
              ? undefined
              : { transform: `scale(${zoomFactor})`, transformOrigin: "0 0" }}
          >{documentProxy && pages.map((page, index) => {
            const geometry = pageGeometry.pages[index];
            const mounted = index >= mountedPageWindow.start && index < mountedPageWindow.end;
            return (
              <div
                key={`${documentGeneration}:${page}`}
                className="pdf-page-shell smooth-shadow-sm"
                data-pdf-page={page}
                style={{ width: geometry.width, height: geometry.height }}
              >
                {mounted && (
                  <ContinuousPdfPage
                    documentProxy={documentProxy}
                    pageNumber={page}
                    scale={scale}
                    current={pageNumber === page}
                    scrolling={pdfScrolling}
                    bundledChromium={bundledChromium}
                    pageAcquireQueue={pageAcquireQueue}
                    renderQueue={renderQueue}
                    searchQuery={searchQuery}
                    selectedSearchOccurrence={selectedMatch?.page === page ? selectedMatch.occurrence : null}
                    syncTarget={syncTarget?.page === page ? syncTarget : null}
                    onPageSize={storePageSize}
                    onTextLayerText={storeRenderedPageText}
                    onSource={onSource}
                    onDestination={navigateDestination}
                  />
                )}
              </div>
            );
          })}</div>}
        {showBlockingLoader && <div className="pdf-loading smooth-shadow-ring-md"><InfinityLoader size={17} /> {t`Rendering PDF…`}</div>}
        {loading && documentProxy ? <div className="pdf-loading pdf-loading-quiet smooth-shadow-ring-md"><InfinityLoader size={14} /> {t`Updating…`}</div> : null}
      </ScrollArea>
    </div>
  );
}
