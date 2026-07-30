import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  LoaderCircle,
  RectangleHorizontal,
  RectangleVertical,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Tip } from "./components/icon-tip";
import { ScrollArea } from "./components/ui/scroll-area";
import { pdfBase64Fingerprint, pdfBase64ToBytes } from "./pdf-bytes";
import { MotionButton } from "./motion";
import {
  annotationBounds,
  findPdfMatches,
  fitPdfScale,
  normalizePdfSelection,
  parsePdfZoomPercent,
  pdfRenderPixelRatio,
  PDF_CMAP_URL,
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  PDF_STANDARD_FONT_DATA_URL,
  type PdfPageSize,
  type PdfSearchMatch,
} from "./pdf-viewer-utils";
import "./pdf-viewer.css";

GlobalWorkerOptions.workerSrc = pdfWorker;

const PDF_LOAD_TIMEOUT_MS = 45_000;

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
  return (
    <div className="pdf-annotation-layer" aria-label="PDF links">
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
              title={annotation.title ?? "Go to linked PDF location"}
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

function ContinuousPdfPage({
  documentProxy,
  pageNumber,
  scale,
  searchQuery,
  selectedSearchMatch,
  syncTarget,
  onTextLayerText,
  onSource,
  onDestination,
}: {
  documentProxy: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  searchQuery: string;
  selectedSearchMatch: PdfSearchMatch | null;
  syncTarget: PdfSyncTarget | null;
  onTextLayerText: (page: number, text: string) => void;
  onSource?: (page: number, x: number, y: number) => void;
  onDestination: (destination: string | unknown[]) => void;
}) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [shouldRender, setShouldRender] = useState(pageNumber === 1);
  const [rendering, setRendering] = useState(true);
  const [textLayerVersion, setTextLayerVersion] = useState(0);
  const [pageError, setPageError] = useState("");

  useEffect(() => {
    let active = true;
    void documentProxy.getPage(pageNumber)
      .then((nextPage) => {
        if (active) setPage(nextPage);
      })
      .catch((reason) => {
        if (!active) return;
        // Destroyed workers surface as messageHandler null — treat as cancelled.
        const detail = message(reason);
        if (/messageHandler|worker is being destroyed|RenderingCancelled/i.test(detail)) {
          setRendering(false);
          return;
        }
        setPageError(detail);
        setRendering(false);
      });
    return () => {
      active = false;
    };
  }, [documentProxy, pageNumber]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (typeof IntersectionObserver === "undefined") {
      const frame = window.requestAnimationFrame(() => setShouldRender(true));
      return () => window.cancelAnimationFrame(frame);
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setShouldRender(true);
    }, {
      root: shell.closest(".pdf-scroll-area-viewport"),
      rootMargin: "900px 0px",
    });
    observer.observe(shell);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const textContainer = textLayerRef.current;
    if (!page || !canvas || !textContainer || !shouldRender) return;
    let active = true;
    let renderTask: { promise: Promise<unknown>; cancel: () => void } | null = null;
    let textLayer: TextLayer | null = null;
    try {
      // Preview.app looks sharp; pdf.js canvas Type1 Times needs supersampling,
      // especially on VM displays that report devicePixelRatio=1.
      const pixelRatio = pdfRenderPixelRatio(window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: scale * pixelRatio });
      const cssViewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(cssViewport.width)}px`;
      canvas.style.height = `${Math.floor(cssViewport.height)}px`;
      textContainer.replaceChildren();
      setRendering(true);
      setPageError("");
      const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
      if (context) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        // High-DPI bitmap is downscaled in CSS; light smoothing keeps Type1 paths clean.
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = "high";
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      renderTask = page.render({
        canvas,
        viewport,
        intent: "display",
        ...(context ? { canvasContext: context } : {}),
      });
      textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textContainer,
        viewport: cssViewport,
      });
      void page.getAnnotations({ intent: "display" }).then((items) => {
        if (!active) return;
        setAnnotations((items as PdfAnnotation[]).map((annotation) => ({
          ...annotation,
          rect: annotation.rect
            ? [
                ...cssViewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]),
                ...cssViewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]),
              ]
            : undefined,
        })));
      }).catch(() => {
        if (active) setAnnotations([]);
      });
      void Promise.all([
        renderTask.promise,
        textLayer.render().then(() => {
          if (active) {
            onTextLayerText(pageNumber, textContainer.textContent ?? "");
            setTextLayerVersion((version) => version + 1);
          }
        }),
      ])
        .catch((reason) => {
          if (!active) return;
          const detail = message(reason);
          if (
            reason?.name === "RenderingCancelledException"
            || /messageHandler|worker is being destroyed/i.test(detail)
          ) {
            return;
          }
          setPageError(detail);
        })
        .finally(() => {
          if (active) setRendering(false);
        });
    } catch (reason) {
      const detail = message(reason);
      if (!/messageHandler|worker is being destroyed/i.test(detail)) {
        setPageError(detail);
      }
      setRendering(false);
    }
    return () => {
      active = false;
      try {
        renderTask?.cancel();
        textLayer?.cancel();
      } catch {
        // Worker may already be gone during PDF rebuilds.
      }
    };
  }, [onTextLayerText, page, pageNumber, scale, shouldRender]);

  useEffect(() => {
    const container = textLayerRef.current;
    if (container) {
      highlightTextLayer(
        container,
        searchQuery,
        selectedSearchMatch?.page === pageNumber ? selectedSearchMatch.occurrence : null,
      );
    }
  }, [pageNumber, searchQuery, selectedSearchMatch, textLayerVersion]);

  const viewport = page?.getViewport({ scale });
  const width = Math.floor(viewport?.width ?? 612 * scale);
  const height = Math.floor(viewport?.height ?? 792 * scale);
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
      className="pdf-page-shell"
      data-pdf-page={pageNumber}
      style={{ width, height, "--total-scale-factor": scale } as React.CSSProperties}
      aria-busy={rendering}
    >
      <canvas
        ref={canvasRef}
        className={onSource ? "synctex-enabled" : ""}
        onDoubleClick={revealSourceFromCanvas}
        aria-label={`PDF page ${pageNumber}`}
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
          aria-label="Source location in PDF"
        />
      )}
      {rendering && <div className="pdf-page-skeleton" aria-hidden="true" />}
      {pageError && <div className="pdf-page-error">Could not render page {pageNumber}. {pageError}</div>}
    </div>
  );
}

export function PdfPreview({
  url,
  pdfBase64,
  fileName = "paper.pdf",
  syncTarget = null,
  onSource,
  onTextSelect,
  onNumPages,
  onPageChange,
  outline,
}: {
  url: string | null;
  pdfBase64: string | null;
  fileName?: string;
  syncTarget?: PdfSyncTarget | null;
  onSource?: (page: number, x: number, y: number) => void;
  onTextSelect?: (text: string) => void;
  onNumPages?: (pages: number | null) => void;
  onPageChange?: (page: number) => void;
  outline?: ReactNode;
}) {
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const onTextSelectRef = useRef(onTextSelect);
  onTextSelectRef.current = onTextSelect;
  const onNumPagesRef = useRef(onNumPages);
  onNumPagesRef.current = onNumPages;
  const onPageChangeRef = useRef(onPageChange);
  onPageChangeRef.current = onPageChange;
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  useEffect(() => {
    onPageChangeRef.current?.(pageNumber);
  }, [pageNumber]);
  const [pageEditing, setPageEditing] = useState(false);
  const [pageDraft, setPageDraft] = useState("");
  const cancelPageEditRef = useRef(false);
  const [scale, setScale] = useState(1.1);
  const [fitMode, setFitMode] = useState<"width" | "height" | null>(null);
  const [pageSize, setPageSize] = useState<PdfPageSize | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState("");
  const [savingPdf, setSavingPdf] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [pageTexts, setPageTexts] = useState<string[]>([]);
  const pageTextsRef = useRef<string[]>([]);
  pageTextsRef.current = pageTexts;
  const [searchError, setSearchError] = useState("");
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [zoomEditing, setZoomEditing] = useState(false);
  const [zoomDraft, setZoomDraft] = useState("");
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const updateManualScale = useCallback((update: (current: number) => number) => {
    setFitMode(null);
    setScale(update);
  }, []);
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

  const loadKey = pdfBase64
    ? `b64:${pdfBase64Fingerprint(pdfBase64)}`
    : (url ? `url:${url}` : "");
  const documentProxyRef = useRef<PDFDocumentProxy | null>(null);
  documentProxyRef.current = documentProxy;
  const pdfBase64Ref = useRef(pdfBase64);
  pdfBase64Ref.current = pdfBase64;
  const urlRef = useRef(url);
  urlRef.current = url;
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
      setLoadedUrl(null);
      onNumPagesRef.current?.(null);
      void previous?.cleanup();
      return;
    }
    let active = true;
    const currentBase64 = pdfBase64Ref.current;
    const currentUrl = urlRef.current;
    // Prefer in-memory bytes over blob: URLs.
    const source = currentBase64
      ? { data: pdfBase64ToBytes(currentBase64) }
      : { url: currentUrl! };
    const loadingTask = getDocument({
      ...source,
      cMapUrl: PDF_CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
    });
    const timeout = window.setTimeout(() => {
      if (!active) return;
      // Keep any already-visible PDF; only surface the error if we have nothing.
      if (!documentProxyRef.current) {
        setPdfError("PDF preview timed out. Click Build again, or open the PDF in Preview.");
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
        documentProxyRef.current = pdf;
        setDocumentProxy(pdf);
        if (previous && previous !== pdf) {
          void previous.cleanup();
        }
        setPageTexts([]);
        setSearchError("");
        setPageNumber((page) => Math.min(page, pdf.numPages));
        setPdfError("");
        onNumPagesRef.current?.(pdf.numPages);
        try {
          const first = await pdf.getPage(1);
          if (!active) return;
          const viewport = first.getViewport({ scale: 1 });
          setPageSize({ width: viewport.width, height: viewport.height });
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
      // Keep the current document on screen while a newer load is cancelled —
      // clearing it here caused endless “Rendering PDF…” during autosave builds.
      void Promise.resolve(loadingTask.destroy()).catch(() => undefined);
    };
  }, [stableLoadKey]);

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
    const refit = () => applyFit(fitMode);
    const observer = new ResizeObserver(refit);
    observer.observe(area);
    refit();
    return () => observer.disconnect();
  }, [applyFit, fitMode]);

  const commitZoomDraft = () => {
    const next = parsePdfZoomPercent(zoomDraft);
    if (next !== null) updateManualScale(() => next);
    setZoomEditing(false);
    setZoomDraft("");
  };

  const fittedPageSizeRef = useRef<PdfPageSize | null>(null);
  useEffect(() => {
    if (!pageSize || !loadedUrl) return;
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
      applyFit("width");
    };
    const frame = requestAnimationFrame(tryFit);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [applyFit, loadedUrl, pageSize]);

  useEffect(() => {
    if (!documentProxy) return;
    let active = true;
    // Defer full-text indexing so the first page can paint without worker contention.
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
            setSearchError(`Search unavailable: ${message(firstFailure.reason)}`);
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
          setSearchError(`Search unavailable: ${detail}`);
        });
    }, 350);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [documentProxy]);

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

  const updateCurrentPage = useCallback(() => {
    const scrollArea = scrollAreaRef.current;
    if (!scrollArea) return;
    const scrollBounds = scrollArea.getBoundingClientRect();
    const marker = scrollBounds.top + Math.min(scrollBounds.height * 0.35, 240);
    let closestPage = 1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const shell of scrollArea.querySelectorAll<HTMLElement>("[data-pdf-page]")) {
      const bounds = shell.getBoundingClientRect();
      const distance = marker < bounds.top
        ? bounds.top - marker
        : marker > bounds.bottom
          ? marker - bounds.bottom
          : 0;
      if (distance < closestDistance) {
        closestDistance = distance;
        closestPage = Number(shell.dataset.pdfPage ?? 1);
      }
    }
    setPageNumber(closestPage);
  }, []);

  const scrollToPage = useCallback((nextPage: number, behavior: ScrollBehavior = "smooth") => {
    const scrollArea = scrollAreaRef.current;
    const page = scrollArea?.querySelector<HTMLElement>(`[data-pdf-page="${nextPage}"]`);
    if (!scrollArea || !page) return;
    setPageNumber(nextPage);
    const top = Math.max(0, page.offsetTop - 20);
    if (typeof scrollArea.scrollTo === "function") {
      scrollArea.scrollTo({ top, behavior });
    } else {
      scrollArea.scrollTop = top;
    }
  }, []);

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
    const frame = window.requestAnimationFrame(updateCurrentPage);
    return () => window.cancelAnimationFrame(frame);
  }, [documentProxy, scale, updateCurrentPage]);

  useEffect(() => {
    if (selectedMatch) scrollToPage(selectedMatch.page);
  }, [scrollToPage, selectedMatch]);

  useEffect(() => {
    if (syncTarget) scrollToPage(syncTarget.page);
  }, [scrollToPage, syncTarget]);

  if (!url) {
    return (
      <div className="pdf-preview">
        <div className="pdf-toolbar pdf-toolbar-empty">
          <div className="pdf-page-controls" />
          <div className="pdf-find-controls">
            {outline}
            <label className="pdf-search disabled">
              <Search size={12} />
              <input aria-label="Search PDF" placeholder="Find in PDF" disabled />
            </label>
          </div>
          <div className="pdf-zoom-controls" />
        </div>
        <div className="pdf-placeholder"><FileText size={28} /><p>Build the project to preview the paper.</p></div>
      </div>
    );
  }

  const download = async () => {
    if (!pdfBase64 || savingPdf) return;
    setSavingPdf(true);
    setSaveNotice("");
    try {
      const destination = await saveDialog({
        title: "Save compiled PDF",
        defaultPath: fileName,
        filters: [{ name: "PDF document", extensions: ["pdf"] }],
      });
      if (!destination) return;
      const savedPath = await invoke<string>("save_compiled_pdf", { path: destination, pdfBase64 });
      setSaveNotice(`Saved to ${savedPath}`);
    } catch (reason) {
      setSaveNotice(`Could not save PDF. ${message(reason)}`);
    } finally {
      setSavingPdf(false);
    }
  };
  const selectMatch = (delta: number) => {
    if (!matches.length) return;
    setSearchMatchIndex((index) => (index + delta + matches.length) % matches.length);
  };
  const navigateDestination = async (destination: string | unknown[]) => {
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
      setSaveNotice(`Could not open PDF link. ${message(reason)}`);
    }
  };
  const pages = documentProxy
    ? Array.from({ length: documentProxy.numPages }, (_, index) => index + 1)
    : [];

  return (
    <div className="pdf-preview">
      <div className="pdf-toolbar">
        <div className="pdf-page-controls">
          <Tip label="Previous page">
            <button disabled={pageNumber <= 1} onClick={() => scrollToPage(Math.max(1, pageNumber - 1))}><ChevronLeft size={14} /></button>
          </Tip>
          <label className={`pdf-page-value${pageEditing ? " editing" : ""}`} title="Enter a page number">
            <input
              aria-label="PDF page number"
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
          <Tip label="Next page">
            <button disabled={!documentProxy || pageNumber >= documentProxy.numPages} onClick={() => scrollToPage(Math.min(documentProxy?.numPages ?? pageNumber, pageNumber + 1))}><ChevronRight size={14} /></button>
          </Tip>
        </div>
        <div className="pdf-find-controls">
          {outline}
          <label className="pdf-search">
            <Search size={12} />
            <input
            aria-label="Search PDF"
            value={searchQuery}
            placeholder="Find in PDF"
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchMatchIndex(0);
            }}
            />
            {searchQuery && (
            <>
              <small className="pdf-search-position" aria-live="polite" title={searchError || undefined}>{searchError ? "Unavailable" : searchIndexing ? "Indexing…" : matches.length ? `${selectedMatchIndex + 1} / ${matches.length}` : "0 / 0"}</small>
              <Tip label="Previous search result">
                <button disabled={!matches.length} onClick={() => selectMatch(-1)}><ChevronUp size={12} /></button>
              </Tip>
              <Tip label="Next search result">
                <button disabled={!matches.length} onClick={() => selectMatch(1)}><ChevronDown size={12} /></button>
              </Tip>
              <Tip label="Clear PDF search">
                <button onClick={() => setSearchQuery("")}><X size={12} /></button>
              </Tip>
            </>
            )}
          </label>
        </div>
        <div className="pdf-zoom-controls">
          <Tip label="Zoom out">
            <button disabled={scale <= PDF_MIN_SCALE} onClick={() => updateManualScale((value) => clamp(Number((value - 0.1).toFixed(1)), PDF_MIN_SCALE, PDF_MAX_SCALE))}><ZoomOut size={14} /></button>
          </Tip>
          <label
            className="pdf-zoom-value"
            title="Enter a zoom percentage or scroll to zoom"
            onWheel={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!event.deltaY) return;
              updateManualScale((value) => clamp(
                Number((value + (event.deltaY < 0 ? 0.1 : -0.1)).toFixed(1)),
                PDF_MIN_SCALE,
                PDF_MAX_SCALE,
              ));
            }}
          >
            <input
              aria-label="PDF zoom percentage"
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
          <Tip label="Zoom in">
            <button disabled={scale >= PDF_MAX_SCALE} onClick={() => updateManualScale((value) => clamp(Number((value + 0.1).toFixed(1)), PDF_MIN_SCALE, PDF_MAX_SCALE))}><ZoomIn size={14} /></button>
          </Tip>
          <i className="pdf-fit-divider" aria-hidden="true" />
          <Tip label="Fit page to width">
            <button className={fitMode === "width" ? "active" : ""} aria-pressed={fitMode === "width"} disabled={!pageSize} onClick={() => toggleFit("width")}><RectangleHorizontal size={14} /></button>
          </Tip>
          <Tip label="Fit page to height">
            <button className={fitMode === "height" ? "active" : ""} aria-pressed={fitMode === "height"} disabled={!pageSize} onClick={() => toggleFit("height")}><RectangleVertical size={14} /></button>
          </Tip>
          <Tip label="Save PDF as…">
            <MotionButton disabled={!pdfBase64 || savingPdf} onClick={() => void download()}>{savingPdf ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}</MotionButton>
          </Tip>
        </div>
      </div>
      {saveNotice && <div className={`pdf-save-notice ${saveNotice.startsWith("Could not") ? "error" : ""}`}>{saveNotice}<button title="Dismiss PDF save notice" onClick={() => setSaveNotice("")}><X size={12} /></button></div>}
      <ScrollArea
        className="pdf-scroll-area"
        orientation="both"
        viewportRef={scrollAreaRef}
        viewportClassName="pdf-scroll-area-viewport"
        contentClassName="pdf-scroll-area-content"
        viewportProps={{ onScroll: updateCurrentPage }}
      >
        {pdfError
          ? <div className="pdf-placeholder"><CircleAlert size={24} /><p>{pdfError}</p></div>
          : <div
            className="pdf-pages"
            style={zoomFactor === 1
              ? undefined
              : { transform: `scale(${zoomFactor})`, transformOrigin: "0 0" }}
          >{documentProxy && pages.map((page) => (
            <ContinuousPdfPage
              key={page}
              documentProxy={documentProxy}
              pageNumber={page}
              scale={scale}
              searchQuery={searchQuery}
              selectedSearchMatch={selectedMatch}
              syncTarget={syncTarget}
              onTextLayerText={storeRenderedPageText}
              onSource={onSource}
              onDestination={(destination) => void navigateDestination(destination)}
            />
          ))}</div>}
        {showBlockingLoader && <div className="pdf-loading"><LoaderCircle className="spin" size={17} /> Rendering PDF…</div>}
        {loading && documentProxy ? <div className="pdf-loading pdf-loading-quiet"><LoaderCircle className="spin" size={14} /> Updating…</div> : null}
      </ScrollArea>
    </div>
  );
}
