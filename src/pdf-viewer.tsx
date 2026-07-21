import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  GlobalWorkerOptions,
  TextLayer,
  getDocument,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  Download,
  FileText,
  Highlighter,
  LoaderCircle,
  Maximize2,
  RectangleHorizontal,
  Search,
  StickyNote,
  Type,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  createPdfMark,
  pageElementForNode,
  pdfMarkFill,
  selectionRectsInPage,
  type PdfMark,
  type PdfMarkKind,
  type PdfSelectionDraft,
} from "./pdf-annotations";
import { pdfBase64Fingerprint, pdfBase64ToBytes } from "./pdf-bytes";
import {
  annotationBounds,
  findPdfMatches,
  fitPdfScale,
  normalizePdfSelection,
  pdfRenderPixelRatio,
  type PdfPageSize,
} from "./pdf-viewer-utils";
import "./pdf-viewer.css";

GlobalWorkerOptions.workerSrc = pdfWorker;

/** Copied from pdfjs-dist into public/pdfjs by the Vite pdfjs-assets plugin. */
function pdfAssetUrl(relative: string): string {
  try {
    return new URL(`${import.meta.env.BASE_URL}${relative}`, window.location.href).href;
  } catch {
    return `${import.meta.env.BASE_URL}${relative}`;
  }
}
const PDF_CMAP_URL = pdfAssetUrl("pdfjs/cmaps/");
const PDF_STANDARD_FONT_DATA_URL = pdfAssetUrl("pdfjs/standard_fonts/");
const PDF_LOAD_TIMEOUT_MS = 45_000;

// How embedded fonts are rasterized. "system" loads them through the FontFace
// API (crisp, but on some WebKit builds — notably macOS VMs — the load fails and
// text collapses to a sans-serif fallback). "outline" makes pdf.js draw each
// glyph as a vector path from the embedded font program, bypassing the browser
// font system entirely; it fixes the "wrong fonts in the PDF" bug where FontFace
// rendering is broken. Persisted per-Mac so a user can flip it if fonts look off.
export type PdfFontMode = "system" | "outline";
const PDF_FONT_MODE_KEY = "lattice.pdf.font-mode.v1";

function loadPdfFontMode(): PdfFontMode {
  try {
    return localStorage.getItem(PDF_FONT_MODE_KEY) === "outline" ? "outline" : "system";
  } catch {
    return "system";
  }
}

function savePdfFontMode(mode: PdfFontMode): void {
  try {
    localStorage.setItem(PDF_FONT_MODE_KEY, mode);
  } catch {
    // Private mode / disabled storage — the in-memory state still applies.
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

function highlightTextLayer(container: HTMLElement, rawQuery: string, selected: boolean) {
  const query = rawQuery.trim().toLocaleLowerCase();
  for (const span of container.querySelectorAll<HTMLElement>("span")) {
    const matches = Boolean(query) && (span.textContent ?? "").toLocaleLowerCase().includes(query);
    span.classList.toggle("pdf-text-match", matches);
    span.classList.toggle("selected", matches && selected);
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

function PdfMarkLayer({
  marks,
  scale,
  activeId,
  onSelect,
}: {
  marks: PdfMark[];
  scale: number;
  activeId: string | null;
  onSelect?: (mark: PdfMark) => void;
}) {
  if (!marks.length) return null;
  return (
    <div className="pdf-mark-layer" aria-label="PDF marks">
      {marks.flatMap((mark) => mark.rects.map((rect, index) => {
        const left = Math.min(rect.x1, rect.x2) * scale;
        const top = Math.min(rect.y1, rect.y2) * scale;
        const width = Math.abs(rect.x2 - rect.x1) * scale;
        const height = Math.abs(rect.y2 - rect.y1) * scale;
        if (width < 1 || height < 1) return [];
        return [(
          <button
            key={`${mark.id}:${index}`}
            type="button"
            className={`pdf-user-highlight ${mark.kind}${activeId === mark.id ? " active" : ""}`}
            style={{
              left,
              top,
              width: Math.max(4, width),
              height: Math.max(4, height),
              background: pdfMarkFill(mark.color),
            }}
            title={mark.note || mark.text}
            onClick={(event) => {
              event.stopPropagation();
              onSelect?.(mark);
            }}
          >
            {mark.kind === "note" && index === 0 ? <StickyNote size={11} /> : null}
          </button>
        )];
      }))}
    </div>
  );
}

function ContinuousPdfPage({
  documentProxy,
  pageNumber,
  scale,
  searchQuery,
  selectedSearchPage,
  syncTarget,
  marks,
  activeMarkId,
  onSelectMark,
  onSource,
  onDestination,
}: {
  documentProxy: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  searchQuery: string;
  selectedSearchPage: number | null;
  syncTarget: PdfSyncTarget | null;
  marks: PdfMark[];
  activeMarkId: string | null;
  onSelectMark?: (mark: PdfMark) => void;
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
      root: shell.closest(".pdf-scroll-area"),
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
          if (active) setTextLayerVersion((version) => version + 1);
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
  }, [page, scale, shouldRender]);

  useEffect(() => {
    const container = textLayerRef.current;
    if (container) {
      highlightTextLayer(container, searchQuery, selectedSearchPage === pageNumber);
    }
  }, [pageNumber, searchQuery, selectedSearchPage, textLayerVersion]);

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
    // Keep text selection for copy; only jump when the click did not create a selection.
    if (window.getSelection()?.toString()) return;
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
        title={onSource ? "Click to reveal LaTeX source" : undefined}
        onClick={revealSourceFromCanvas}
        aria-label={`PDF page ${pageNumber}`}
      />
      <div
        ref={textLayerRef}
        className="textLayer pdf-text-layer"
        title={onSource ? "Click to reveal LaTeX source; drag to select text" : undefined}
        onClick={revealSourceFromText}
      />
      <PdfMarkLayer
        marks={marks}
        scale={scale}
        activeId={activeMarkId}
        onSelect={onSelectMark}
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
  marks = [],
  activeMarkId = null,
  onSource,
  onTextSelect,
  onCreateMark,
  onSelectMark,
  onOpenMarks,
  onNumPages,
}: {
  url: string | null;
  pdfBase64: string | null;
  fileName?: string;
  syncTarget?: PdfSyncTarget | null;
  marks?: PdfMark[];
  activeMarkId?: string | null;
  onSource?: (page: number, x: number, y: number) => void;
  onTextSelect?: (text: string) => void;
  onCreateMark?: (mark: PdfMark) => void;
  onSelectMark?: (mark: PdfMark) => void;
  onOpenMarks?: () => void;
  onNumPages?: (pages: number | null) => void;
}) {
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const onTextSelectRef = useRef(onTextSelect);
  onTextSelectRef.current = onTextSelect;
  const onNumPagesRef = useRef(onNumPages);
  onNumPagesRef.current = onNumPages;
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.1);
  const [pageSize, setPageSize] = useState<PdfPageSize | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState("");
  const [savingPdf, setSavingPdf] = useState(false);
  const [saveNotice, setSaveNotice] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [pageTexts, setPageTexts] = useState<string[]>([]);
  const [searchError, setSearchError] = useState("");
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [selectionDraft, setSelectionDraft] = useState<PdfSelectionDraft | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [markColor, setMarkColor] = useState("yellow");
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const [pdfFontMode, setPdfFontMode] = useState<PdfFontMode>(loadPdfFontMode);
  const pdfFontModeRef = useRef(pdfFontMode);
  pdfFontModeRef.current = pdfFontMode;
  // Trackpad pinch on macOS (and ctrl+scroll) arrives as a wheel event with
  // ctrlKey set. Zoom continuously and keep the point under the cursor fixed.
  const pendingZoomAnchorRef = useRef<{ x: number; y: number; prevScale: number } | null>(null);
  useEffect(() => {
    const area = scrollAreaRef.current;
    if (!area) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const prev = scaleRef.current;
      const next = clamp(Number((prev * Math.exp(-event.deltaY * 0.01)).toFixed(3)), 0.6, 2.2);
      if (next === prev) return;
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
  useLayoutEffect(() => {
    const area = scrollAreaRef.current;
    const anchor = pendingZoomAnchorRef.current;
    if (!area || !anchor) return;
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
    // Font rendering mode (see PdfFontMode). "outline" draws glyph paths from the
    // embedded font — the robust fallback when FontFace rendering is broken on a
    // WebKit build; "system" uses FontFace + system-serif substitution.
    const outlineMode = pdfFontModeRef.current === "outline";
    const loadingTask = getDocument({
      ...source,
      cMapUrl: PDF_CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
      disableFontFace: outlineMode,
      useSystemFonts: !outlineMode,
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
    // pdfFontMode is a load-time option, so re-run getDocument when it changes.
  }, [stableLoadKey, pdfFontMode]);

  const applyFit = useCallback((mode: "width" | "page") => {
    const area = scrollAreaRef.current;
    if (!area || !pageSize) return;
    setScale(fitPdfScale(mode, pageSize, {
      width: area.clientWidth,
      height: area.clientHeight,
    }));
  }, [pageSize]);

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
      void Promise.all(
        Array.from({ length: documentProxy.numPages }, async (_, index) => {
          const page = await documentProxy.getPage(index + 1);
          return textFromContent(await page.getTextContent());
        }),
      )
        .then((texts) => {
          if (active) setPageTexts(texts);
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
        setSelectionDraft(null);
        setNoteDraft("");
        return;
      }
      const anchor = selection.anchorNode;
      if (!anchor || !root.contains(anchor)) return;
      const next = normalizePdfSelection(selection.toString());
      if (next !== lastReported) {
        lastReported = next;
        onTextSelectRef.current?.(next);
      }
      if (!next) {
        setSelectionDraft(null);
        return;
      }
      const pageElement = pageElementForNode(selection.anchorNode);
      if (!pageElement) return;
      const page = Number(pageElement.dataset.pdfPage ?? 0);
      if (!(page > 0)) return;
      try {
        const range = selection.getRangeAt(0);
        const rects = selectionRectsInPage(range, pageElement, scaleRef.current);
        if (!rects.length) return;
        setSelectionDraft({ text: next, page, rects });
      } catch {
        // Selection can become invalid while the text layer remounts.
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

  const commitMark = (kind: PdfMarkKind) => {
    if (!selectionDraft || !onCreateMark) return;
    const mark = createPdfMark(selectionDraft, kind, markColor, kind === "note" ? noteDraft.trim() : "");
    onCreateMark(mark);
    setSelectionDraft(null);
    setNoteDraft("");
    window.getSelection()?.removeAllRanges();
  };

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

  useEffect(() => {
    if (!activeMarkId) return;
    const mark = marks.find((item) => item.id === activeMarkId);
    if (mark) scrollToPage(mark.page);
  }, [activeMarkId, marks, scrollToPage]);

  if (!url) {
    return <div className="pdf-preview"><div className="pdf-placeholder"><FileText size={28} /><p>Build the project to preview the paper.</p></div></div>;
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
          <button title="Previous page" disabled={pageNumber <= 1} onClick={() => scrollToPage(Math.max(1, pageNumber - 1))}><ChevronLeft size={14} /></button>
          <span>{pageNumber} / {documentProxy?.numPages ?? "–"}</span>
          <button title="Next page" disabled={!documentProxy || pageNumber >= documentProxy.numPages} onClick={() => scrollToPage(Math.min(documentProxy?.numPages ?? pageNumber, pageNumber + 1))}><ChevronRight size={14} /></button>
        </div>
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
              <small title={searchError || undefined}>{searchError ? "Unavailable" : searchIndexing ? "Indexing…" : matches.length ? `${selectedMatchIndex + 1}/${matches.length}` : "0/0"}</small>
              <button title="Previous search result" disabled={!matches.length} onClick={() => selectMatch(-1)}><ChevronUp size={12} /></button>
              <button title="Next search result" disabled={!matches.length} onClick={() => selectMatch(1)}><ChevronDown size={12} /></button>
              <button title="Clear PDF search" onClick={() => setSearchQuery("")}><X size={12} /></button>
            </>
          )}
        </label>
        <div className="pdf-zoom-controls">
          <button title="Zoom out" disabled={scale <= 0.6} onClick={() => setScale((value) => clamp(Number((value - 0.1).toFixed(1)), 0.6, 2.2))}><ZoomOut size={14} /></button>
          <span>{Math.round(scale * 100)}%</span>
          <button title="Zoom in" disabled={scale >= 2.2} onClick={() => setScale((value) => clamp(Number((value + 0.1).toFixed(1)), 0.6, 2.2))}><ZoomIn size={14} /></button>
          <i className="pdf-fit-divider" aria-hidden="true" />
          <button title="Fit page to width" disabled={!pageSize} onClick={() => applyFit("width")}><RectangleHorizontal size={14} /></button>
          <button title="Fit whole page" disabled={!pageSize} onClick={() => applyFit("page")}><Maximize2 size={14} /></button>
          <i className="pdf-fit-divider" aria-hidden="true" />
          <button
            className={pdfFontMode === "outline" ? "active" : ""}
            title={pdfFontMode === "outline"
              ? "Font rendering: vector outlines. Click to switch to system fonts."
              : "Font rendering: system fonts. If text looks wrong (e.g. serif shows as sans-serif), click to switch to vector outlines."}
            onClick={() => {
              const next: PdfFontMode = pdfFontMode === "outline" ? "system" : "outline";
              setPdfFontMode(next);
              savePdfFontMode(next);
            }}
          >
            <Type size={14} />
          </button>
          {onOpenMarks && (
            <button title="PDF marks" onClick={onOpenMarks}>
              <Highlighter size={14} />
              {marks.length ? <em className="pdf-mark-count">{marks.length}</em> : null}
            </button>
          )}
          <button title="Save PDF as…" disabled={!pdfBase64 || savingPdf} onClick={() => void download()}>{savingPdf ? <LoaderCircle className="spin" size={14} /> : <Download size={14} />}</button>
        </div>
      </div>
      {saveNotice && <div className={`pdf-save-notice ${saveNotice.startsWith("Could not") ? "error" : ""}`}>{saveNotice}<button title="Dismiss PDF save notice" onClick={() => setSaveNotice("")}><X size={12} /></button></div>}
      {selectionDraft && onCreateMark && (
        <div className="pdf-mark-popover" role="dialog" aria-label="Create PDF mark">
          <p>{selectionDraft.text}</p>
          <div className="pdf-mark-colors">
            {(["yellow", "green", "blue", "pink"] as const).map((color) => (
              <button
                key={color}
                type="button"
                className={`pdf-mark-color ${color}${markColor === color ? " active" : ""}`}
                title={color}
                onClick={() => setMarkColor(color)}
              />
            ))}
          </div>
          <input
            value={noteDraft}
            onChange={(event) => setNoteDraft(event.target.value)}
            placeholder="Optional note"
            aria-label="Sticky note text"
          />
          <div className="pdf-mark-popover-actions">
            <button type="button" onClick={() => commitMark("highlight")}><Highlighter size={12} /> Highlight</button>
            <button type="button" onClick={() => commitMark("note")}><StickyNote size={12} /> Note</button>
            <button type="button" className="secondary" onClick={() => { setSelectionDraft(null); setNoteDraft(""); }}>Cancel</button>
          </div>
        </div>
      )}
      <div ref={scrollAreaRef} className="pdf-scroll-area" onScroll={updateCurrentPage}>
        {pdfError
          ? <div className="pdf-placeholder"><CircleAlert size={24} /><p>{pdfError}</p></div>
          : <div className="pdf-pages">{documentProxy && pages.map((page) => (
            <ContinuousPdfPage
              key={page}
              documentProxy={documentProxy}
              pageNumber={page}
              scale={scale}
              searchQuery={searchQuery}
              selectedSearchPage={selectedMatch?.page ?? null}
              syncTarget={syncTarget}
              marks={marks.filter((mark) => mark.page === page)}
              activeMarkId={activeMarkId}
              onSelectMark={onSelectMark}
              onSource={onSource}
              onDestination={(destination) => void navigateDestination(destination)}
            />
          ))}</div>}
        {showBlockingLoader && <div className="pdf-loading"><LoaderCircle className="spin" size={17} /> Rendering PDF…</div>}
        {loading && documentProxy ? <div className="pdf-loading pdf-loading-quiet"><LoaderCircle className="spin" size={14} /> Updating…</div> : null}
      </div>
    </div>
  );
}
