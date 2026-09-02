import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useLingui } from "@lingui/react/macro";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { PDFSlick, type PDFSlickOptions } from "@pdfslick/core";
import { GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {
  CaseSensitive,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleAlert,
  CornerUpLeft,
  CornerUpRight,
  Download,
  FileText,
  LocateFixed,
  RectangleHorizontal,
  RectangleVertical,
  WholeWord,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Tip } from "../components/icon-tip";
import { InfinityLoader } from "../components/ui/activity-icons";
import { SearchField } from "../components/ui/search-field";
import { MotionButton } from "../components/ui/motion";
import type { PdfFileViewState } from "../app-types";
import { useNonPassiveWheel } from "../hooks/use-non-passive-wheel";
import { isBrowserHosted } from "../platform/browser-runtime";
import { logAction } from "../telemetry/app-notify";
import {
  pdfBase64Fingerprint,
  pdfBase64ToBytes,
  pdfBytesFingerprint,
  utf8ToBase64,
} from "./pdf-bytes";
import { installPdfTextLayerSelection, pdfSelectedOrCachedPlainText } from "./pdf-text-layer-selection";
import {
  PDF_CMAP_URL,
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  PDF_STANDARD_FONT_DATA_URL,
  normalizePdfSelection,
  parsePdfZoomPercent,
} from "./pdf-viewer-utils";
import "@pdfslick/core/dist/pdf_viewer.css";
import "./pdf-viewer.css";

/** Notification source label for the PDF preview. */
const PDF_SOURCE = "PDF";
const PDF_LOAD_TIMEOUT_MS = 45_000;
const PDF_RANGE_CHUNK_BYTES = 2 ** 20;
const PDF_VIEW_PREFERENCE_KEY = "lattice.pdf-view-preference.v1";
const PDF_REFIT_SETTLE_MS = 120;
/** PDF.js's viewer renders a PDF point at one CSS pixel at 75% viewer scale. */
const PDF_TO_CSS_UNITS = 96 / 72;

GlobalWorkerOptions.workerSrc = pdfWorker;

// PDF.js 6 uses Promise.withResolvers in its viewer code, while macOS 14's
// first WKWebView releases predate that method.
if (!("withResolvers" in Promise)) {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- JavaScript API property name.
  Object.defineProperty(Promise, "withResolvers", {
    configurable: true,
    value: function withResolvers<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    },
  });
}

// WKWebView 18 does not expose the async iterator that PDF.js 5+ uses while
// streaming text. Supplying the standards-compatible adapter keeps PDFSlick's
// native text selection and search path working without a second PDF.js build.
if (
  typeof ReadableStream !== "undefined"
  && !(Symbol.asyncIterator in ReadableStream.prototype)
) {
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, {
    configurable: true,
    value: async function* streamAsyncIterator<T>(this: ReadableStream<T>) {
      const reader = this.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) return;
          yield result.value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  });
}

type PdfViewPreference = {
  fitMode: "width" | "height" | null;
  scale: number;
};

type ViewerRecord = {
  key: string;
  slick: PDFSlick;
  root: HTMLDivElement;
  viewer: HTMLDivElement;
  disposeDom: () => void;
  destroyPromise: Promise<void> | null;
};

type PdfSlickPageView = {
  div?: HTMLDivElement;
  textLayer?: { div?: HTMLDivElement };
  viewport?: { scale?: number };
};

type FindMatchesCountEvent = {
  matchesCount?: { current?: number; total?: number };
};

type PageEvent = {
  pageNumber?: number;
};

type ScaleEvent = {
  scale?: number;
  presetValue?: string | null;
};

type PdfLocation = PdfFileViewState;

type PdfLocationHistory = {
  back: PdfLocation[];
  forward: PdfLocation[];
};

type PdfLoadFeedback = {
  key: string;
  phase: "loading" | "rendering";
  percent: number | null;
  blocking: boolean;
};

function loadPdfViewPreference(): PdfViewPreference {
  try {
    const stored = JSON.parse(localStorage.getItem(PDF_VIEW_PREFERENCE_KEY) ?? "null") as unknown;
    if (!stored || typeof stored !== "object") return { fitMode: "width", scale: 1.1 };
    const candidate = stored as Partial<PdfViewPreference>;
    const fitMode = candidate.fitMode === "height" || candidate.fitMode === null
      ? candidate.fitMode
      : "width";
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

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function toAppScale(viewerScale: number) {
  return clamp(viewerScale * PDF_TO_CSS_UNITS, PDF_MIN_SCALE, PDF_MAX_SCALE);
}

function toViewerScale(appScale: number) {
  return clamp(appScale, PDF_MIN_SCALE, PDF_MAX_SCALE) / PDF_TO_CSS_UNITS;
}

function capturePdfLocation(record: ViewerRecord): PdfLocation {
  const { slick, root } = record;
  const scaleValue = slick.viewer.currentScaleValue;
  return {
    page: Math.max(1, Math.floor(slick.linkService.page)),
    scale: toAppScale(slick.viewer.currentScale),
    fitMode: scaleValue === "page-width"
      ? "width"
      : scaleValue === "page-fit"
        ? "height"
        : null,
    scrollTop: root.scrollTop,
    scrollLeft: root.scrollLeft,
  };
}

function isSamePdfLocation(left: PdfLocation, right: PdfLocation): boolean {
  return left.page === right.page
    && left.fitMode === right.fitMode
    && Math.abs(left.scale - right.scale) < 0.001
    && Math.abs(left.scrollTop - right.scrollTop) < 1
    && Math.abs(left.scrollLeft - right.scrollLeft) < 1;
}

function copyArrayBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (bytes instanceof Uint8Array) {
    return new Uint8Array(bytes).buffer;
  }
  return bytes.slice(0);
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

async function destroyViewerRecord(record: ViewerRecord): Promise<void> {
  if (record.destroyPromise) return record.destroyPromise;
  record.destroyPromise = (async () => {
    record.disposeDom();
    record.slick.unbindEvents();
    const objectUrl = typeof record.slick.url === "string" && record.slick.url.startsWith("blob:")
      ? record.slick.url
      : null;
    const loadingTask = record.slick.document?.loadingTask;
    if (loadingTask) {
      await Promise.resolve(loadingTask.destroy()).catch(() => undefined);
    }
    record.slick.viewer.cleanup();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    record.root.remove();
  })();
  return record.destroyPromise;
}

function viewerOptions(
  browserHosted: boolean,
  scaleValue: string,
  completeSource: boolean,
  documentData: ArrayBuffer | null,
): PDFSlickOptions {
  return {
    scaleValue,
    removePageBorders: true,
    enableDetailCanvas: true,
    // PDF.js otherwise keeps a new canvas hidden for up to 500 ms before its
    // first incremental update. Showing it immediately makes a far scroll
    // progressively useful instead of leaving a blank page while rendering.
    minDurationToUpdateCanvas: 0,
    enableHWA: true,
    maxCanvasPixels: browserHosted ? 2 ** 25 : 2 ** 24,
    getDocumentParams: {
      cMapUrl: PDF_CMAP_URL,
      cMapPacked: true,
      standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
      // PDFSlick turns ArrayBuffers into blob URLs before calling PDF.js.
      // Supplying the same disposable copy as data keeps local documents on
      // PDF.js's direct worker-transfer path instead of fetching that blob.
      ...(documentData ? { data: documentData } : {}),
      // arXiv's response startup latency makes PDF.js's 64 KiB default very
      // expensive for non-linearized papers: one first page can require many
      // sequential ranges. Favor fewer requests over conserving a small amount
      // of overlapping early data.
      rangeChunkSize: PDF_RANGE_CHUNK_BYTES,
      // PDFViewer eagerly initializes 250 pages after its first paint. Local
      // byte sources are already complete, so keep page proxies lazy and let a
      // far jump request its target directly. PDF.js requires streaming to be
      // disabled as well for disableAutoFetch to take effect. URL sources keep
      // both features because their server may fulfill incremental range reads.
      disableAutoFetch: completeSource,
      disableStream: completeSource,
      // WKWebView can accept an embedded Type 1 font through FontFace but then
      // paint none of its glyphs. Drawing glyph outlines bypasses that path and
      // still leaves PDF.js's selectable text layer available. Chromium's font
      // path is correct and much cheaper, so keep it enabled there.
      disableFontFace: !browserHosted,
      useSystemFonts: false,
    },
  };
}

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
  /** Complete bytes assembled by PDF.js after a URL load, for host actions such as download. */
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
  const browserHosted = isBrowserHosted();
  const effectiveSaveLabel = saveLabel ?? t`Save PDF as…`;
  const effectiveTimeoutMessage = timeoutMessage
    ?? t`PDF preview timed out. Click Build again, or open the PDF in Preview.`;
  const previewRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scrollAreaRef = useRef<HTMLDivElement | null>(null);
  const activeRecordRef = useRef<ViewerRecord | null>(null);
  const syncHighlightRef = useRef<HTMLDivElement | null>(null);
  const onTextSelectRef = useRef(onTextSelect);
  const onNumPagesRef = useRef(onNumPages);
  const onPageChangeRef = useRef(onPageChange);
  const onDocumentDataRef = useRef(onDocumentData);
  const onViewStateRef = useRef(onViewState);
  const onSourceRef = useRef(onSource);
  const [initialViewStateSnapshot] = useState(initialViewState);

  useLayoutEffect(() => {
    onTextSelectRef.current = onTextSelect;
    onNumPagesRef.current = onNumPages;
    onPageChangeRef.current = onPageChange;
    onDocumentDataRef.current = onDocumentData;
    onViewStateRef.current = onViewState;
    onSourceRef.current = onSource;
  }, [onDocumentData, onNumPages, onPageChange, onSource, onTextSelect, onViewState]);

  const [initialViewPreference] = useState(() => {
    const saved = initialViewStateSnapshot;
    return saved
      ? {
          fitMode: saved.fitMode,
          scale: clamp(saved.scale, PDF_MIN_SCALE, PDF_MAX_SCALE),
        }
      : loadPdfViewPreference();
  });
  // A generation, rather than the mutable PDFSlick instance, gives effects a
  // React-owned signal whenever staged document replacement promotes a viewer.
  const [activeViewerGeneration, setActiveViewerGeneration] = useState(0);
  const hasActiveViewer = activeViewerGeneration > 0;
  const [pageNumber, setPageNumber] = useState(() => Math.max(
    1,
    Math.floor(initialViewStateSnapshot?.page ?? initialPage),
  ));
  const [numPages, setNumPages] = useState<number | null>(null);
  const [scale, setScale] = useState(initialViewPreference.scale);
  const [fitMode, setFitMode] = useState<"width" | "height" | null>(initialViewPreference.fitMode);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState("");
  const [loadFeedback, setLoadFeedback] = useState<PdfLoadFeedback | null>(null);
  const [savingPdf, setSavingPdf] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchCase, setSearchMatchCase] = useState(false);
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchMatches, setSearchMatches] = useState({ current: 0, total: 0 });
  const [pageEditing, setPageEditing] = useState(false);
  const [pageDraft, setPageDraft] = useState("");
  const [zoomEditing, setZoomEditing] = useState(false);
  const [zoomDraft, setZoomDraft] = useState("");
  const [historyAvailability, setHistoryAvailability] = useState({ back: false, forward: false });
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pdfSurfaceActiveRef = useRef(false);
  const cancelPageEditRef = useRef(false);
  const pageNumberRef = useRef(pageNumber);
  const scaleRef = useRef(scale);
  const fitModeRef = useRef(fitMode);
  const locationHistoryRef = useRef<PdfLocationHistory>({ back: [], forward: [] });
  const locationNavigationTokenRef = useRef(0);
  const viewStateFrameRef = useRef<number | null>(null);
  const viewStateReadyRef = useRef(!initialViewStateSnapshot);
  const textLayerDisposersRef = useRef(new Map<HTMLElement, () => void>());

  useLayoutEffect(() => {
    pageNumberRef.current = pageNumber;
    scaleRef.current = scale;
    fitModeRef.current = fitMode;
  }, [fitMode, pageNumber, scale]);

  useEffect(() => {
    onPageChangeRef.current?.(pageNumber);
  }, [pageNumber]);

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

  const syncHistoryAvailability = useCallback(() => {
    setHistoryAvailability({
      back: locationHistoryRef.current.back.length > 0,
      forward: locationHistoryRef.current.forward.length > 0,
    });
  }, []);

  const resetLocationHistory = useCallback(() => {
    locationNavigationTokenRef.current += 1;
    locationHistoryRef.current = { back: [], forward: [] };
    setHistoryAvailability({ back: false, forward: false });
  }, []);

  const disposeRecord = useCallback((record: ViewerRecord) => {
    for (const [layer, dispose] of textLayerDisposersRef.current) {
      if (record.root.contains(layer)) {
        dispose();
        textLayerDisposersRef.current.delete(layer);
      }
    }
    void destroyViewerRecord(record);
  }, []);

  const byteSource = pdfBytes && (!url || url.startsWith("blob:")) ? pdfBytes : null;
  const loadKey = byteSource
    ? `bytes:${pdfBytesFingerprint(byteSource)}`
    : pdfBase64
      ? `b64:${pdfBase64Fingerprint(pdfBase64)}`
      : (url ? `url:${url}` : "");
  const pdfSourceRef = useRef({ byteSource, pdfBase64, url });
  useLayoutEffect(() => {
    pdfSourceRef.current = { byteSource, pdfBase64, url };
  }, [byteSource, pdfBase64, url]);
  const [stableLoadKey, setStableLoadKey] = useState("");

  // Coalesce rapid rebuild fingerprints before replacing the active document.
  // The old instance remains visible until PDFSlick's replacement reaches pagesinit.
  useEffect(() => {
    if (!loadKey) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- source removal cancels the debounced replacement immediately.
      setStableLoadKey("");
      return;
    }
    const delayMs = activeRecordRef.current ? 900 : 120;
    const timer = window.setTimeout(() => setStableLoadKey(loadKey), delayMs);
    return () => window.clearTimeout(timer);
  }, [loadKey]);

  useEffect(() => {
    const host = hostRef.current;
    if (!stableLoadKey || !host) {
      if (!stableLoadKey) {
        const previous = activeRecordRef.current;
        activeRecordRef.current = null;
        scrollAreaRef.current = null;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- removing the source clears the imperative viewer and its React mirror together.
        setActiveViewerGeneration(0);
        setNumPages(null);
        setLoadedKey(null);
        resetLocationHistory();
        onNumPagesRef.current?.(null);
        if (previous) disposeRecord(previous);
      }
      return;
    }

    let cancelled = false;
    let promoted = false;
    let loadSettled = false;
    let firstPageRendered = false;
    let loadFailure: unknown = null;
    let dataTimer: number | null = null;
    let timeout: number | null = null;
    const root = document.createElement("div");
    // eslint-disable-next-line lingui/no-unlocalized-strings -- PDFSlick and app CSS class names.
    root.className = "pdfSlick pdfSlickViewer pdf-scroll-area-viewport";
    root.dataset.slot = "scroll-area-viewport";
    const viewer = document.createElement("div");
    // eslint-disable-next-line lingui/no-unlocalized-strings -- PDF.js viewer CSS class names.
    viewer.className = "pdfViewer pdf-pages";
    root.append(viewer);
    const previousAtStart = activeRecordRef.current;
    if (previousAtStart) root.classList.add("pdf-viewer-staging");
    host.append(root);

    const updateLoadFeedback = (phase: PdfLoadFeedback["phase"], percent: number | null) => {
      if (cancelled || firstPageRendered) return;
      setLoadFeedback((current) => {
        if (
          current?.key === stableLoadKey
          && current.phase === phase
          && current.percent === percent
        ) return current;
        return {
          key: stableLoadKey,
          phase,
          percent,
          blocking: previousAtStart === null,
        };
      });
    };
    const clearLoadFeedback = () => {
      setLoadFeedback((current) => current?.key === stableLoadKey ? null : current);
    };

    const scaleValue = fitModeRef.current === "width"
      ? "page-width"
      : fitModeRef.current === "height"
        ? "page-fit"
        : String(toViewerScale(scaleRef.current));
    const { byteSource: currentBytes, pdfBase64: currentBase64, url: currentUrl } = pdfSourceRef.current;
    const source = currentBytes
      ? copyArrayBuffer(currentBytes)
      : currentBase64
        ? copyArrayBuffer(pdfBase64ToBytes(currentBase64))
        : currentUrl!;
    const documentData = typeof source === "string" ? null : source;
    const slick = new PDFSlick({
      container: root,
      viewer,
      options: viewerOptions(browserHosted, scaleValue, documentData !== null, documentData),
      // PDFSlick reports PDF.js failures through this callback and deliberately
      // resolves loadDocument. Preserve the error so the lifecycle below can
      // keep an old document visible or show a useful first-load failure.
      onError: (reason) => {
        loadFailure = reason;
      },
    });
    const linkService = slick.linkService;
    const originalGoToDestination = linkService.goToDestination;
    const trackedGoToDestination: typeof originalGoToDestination = async (destination) => {
      const sourceLocation = activeRecordRef.current === record
        ? capturePdfLocation(record)
        : null;
      const navigationToken = sourceLocation
        ? ++locationNavigationTokenRef.current
        : 0;
      await originalGoToDestination.call(linkService, destination);
      if (
        !sourceLocation
        || activeRecordRef.current !== record
        || locationNavigationTokenRef.current !== navigationToken
      ) return;
      const targetLocation = capturePdfLocation(record);
      if (isSamePdfLocation(sourceLocation, targetLocation)) return;
      locationHistoryRef.current.back.push(sourceLocation);
      locationHistoryRef.current.forward = [];
      syncHistoryAvailability();
    };
    // PDFSlick exposes PDF.js's link service but does not install its optional
    // browser-global PDFHistory. Track only internal-destination jumps on this
    // viewer instance so app/tab navigation and ordinary PDF scrolling remain
    // independent.
    linkService.goToDestination = trackedGoToDestination;
    const sourceHandler = (event: MouseEvent) => {
      const sourceCallback = onSourceRef.current;
      if (!sourceCallback) return;
      let pageElement = event.target instanceof HTMLElement ? event.target : null;
      while (pageElement && pageElement !== root && pageElement.dataset.pageNumber === undefined) {
        pageElement = pageElement.parentElement;
      }
      if (!pageElement || pageElement === root) return;
      event.preventDefault();
      const page = Number.parseInt(pageElement.dataset.pageNumber ?? "", 10);
      const pageView = slick.viewer.getPageView(page - 1) as PdfSlickPageView | undefined;
      const viewportScale = pageView?.viewport?.scale ?? scaleRef.current;
      const bounds = pageElement.getBoundingClientRect();
      sourceCallback(
        page,
        Number(((event.clientX - bounds.left) / viewportScale).toFixed(3)),
        Number(((event.clientY - bounds.top) / viewportScale).toFixed(3)),
      );
    };
    const scrollHandler = () => scheduleViewState();
    root.addEventListener("dblclick", sourceHandler);
    root.addEventListener("scroll", scrollHandler, { passive: true });

    const record: ViewerRecord = {
      key: stableLoadKey,
      slick,
      root,
      viewer,
      disposeDom: () => {
        if (dataTimer !== null) window.clearTimeout(dataTimer);
        if (linkService.goToDestination === trackedGoToDestination) {
          linkService.goToDestination = originalGoToDestination;
        }
        root.removeEventListener("dblclick", sourceHandler);
        root.removeEventListener("scroll", scrollHandler);
      },
      destroyPromise: null,
    };

    const decoratePages = () => {
      const pages = slick.document?.numPages ?? 0;
      for (let index = 0; index < pages; index += 1) {
        const pageView = slick.viewer.getPageView(index) as PdfSlickPageView | undefined;
        const pageElement = pageView?.div;
        if (!pageElement) continue;
        const pageNumber = index + 1;
        pageElement.dataset.pdfPage = String(pageNumber);
        pageElement.setAttribute("role", "group");
        pageElement.setAttribute("aria-label", t`PDF page ${pageNumber}`);
        pageElement.classList.toggle("synctex-enabled", Boolean(onSourceRef.current));
      }
    };

    const promote = () => {
      if (cancelled || promoted || !slick.document) return;
      promoted = true;
      updateLoadFeedback("rendering", null);
      const previous = activeRecordRef.current;
      const restorePage = Math.min(pageNumberRef.current, slick.document.numPages);
      const restoreTop = previous?.root.scrollTop ?? initialViewStateSnapshot?.scrollTop ?? 0;
      const restoreLeft = previous?.root.scrollLeft ?? initialViewStateSnapshot?.scrollLeft ?? 0;
      root.classList.remove("pdf-viewer-staging");
      resetLocationHistory();
      activeRecordRef.current = record;
      scrollAreaRef.current = root;
      setActiveViewerGeneration((generation) => generation + 1);
      setNumPages(slick.document.numPages);
      setPageNumber(restorePage);
      setLoadedKey(stableLoadKey);
      setPdfError("");
      onNumPagesRef.current?.(slick.document.numPages);
      window.requestAnimationFrame(() => {
        slick.gotoPage(restorePage);
        root.scrollTop = restoreTop;
        root.scrollLeft = restoreLeft;
        viewStateReadyRef.current = true;
        scheduleViewState();
      });
      if (previous && previous !== record) disposeRecord(previous);
    };

    slick.on("pagesinit", () => {
      decoratePages();
      promote();
    });
    slick.on("pagerendered", () => {
      if (!firstPageRendered) {
        firstPageRendered = true;
        clearLoadFeedback();
      }
      for (const [layer, dispose] of textLayerDisposersRef.current) {
        if (!layer.isConnected) {
          dispose();
          textLayerDisposersRef.current.delete(layer);
        }
      }
      if (
        dataTimer === null
        && !pdfSourceRef.current.byteSource
        && !pdfSourceRef.current.pdfBase64
        && onDocumentDataRef.current
      ) {
        dataTimer = window.setTimeout(() => {
          const currentDocument = slick.document;
          if (!cancelled && currentDocument) {
            void currentDocument.getData()
              .then((bytes) => onDocumentDataRef.current?.(copyArrayBuffer(bytes)))
              .catch(() => undefined);
          }
        }, 750);
      }
    });
    slick.on("textlayerrendered", (source) => {
      const event = source as PageEvent;
      const page = event.pageNumber ?? 0;
      const pageView = slick.viewer.getPageView(page - 1) as PdfSlickPageView | undefined;
      const textLayer = pageView?.textLayer?.div;
      if (!textLayer) return;
      textLayer.classList.add("pdf-text-layer");
      textLayerDisposersRef.current.get(textLayer)?.();
      textLayerDisposersRef.current.set(textLayer, installPdfTextLayerSelection(textLayer));
    });
    slick.on("pagechanging", (source) => {
      const event = source as PageEvent;
      if (activeRecordRef.current !== record || typeof event.pageNumber !== "number") return;
      setPageNumber(event.pageNumber);
    });
    slick.on("scalechanging", (source) => {
      const event = source as ScaleEvent;
      if (activeRecordRef.current !== record || typeof event.scale !== "number") return;
      setScale(toAppScale(event.scale));
      setFitMode(event.presetValue === "page-width"
        ? "width"
        : event.presetValue === "page-fit"
          ? "height"
          : null);
    });
    slick.on("updatefindmatchescount", (source) => {
      const event = source as FindMatchesCountEvent;
      if (activeRecordRef.current !== record) return;
      setSearchMatches({
        current: event.matchesCount?.current ?? 0,
        total: event.matchesCount?.total ?? 0,
      });
    });

    timeout = window.setTimeout(() => {
      if (loadSettled || cancelled) return;
      cancelled = true;
      clearLoadFeedback();
      if (!activeRecordRef.current) setPdfError(effectiveTimeoutMessage);
      setLoadedKey(stableLoadKey);
    }, PDF_LOAD_TIMEOUT_MS);

    void slick.loadDocument(source, {
      onProgress: ({ loaded, total }) => {
        if (cancelled || promoted || firstPageRendered) return;
        const percent = total > 0
          ? Math.round(clamp((loaded / total) * 100, 0, 100))
          : null;
        updateLoadFeedback(
          percent === 100 ? "rendering" : "loading",
          percent === 100 ? null : percent,
        );
      },
    })
      .then(() => {
        loadSettled = true;
        if (timeout !== null) window.clearTimeout(timeout);
        if (cancelled) {
          disposeRecord(record);
          return;
        }
        if (!slick.document) {
          if (!activeRecordRef.current) {
            setPdfError(message(loadFailure ?? t`Could not load PDF`));
            setNumPages(null);
            onNumPagesRef.current?.(null);
          }
          setLoadedKey(stableLoadKey);
          clearLoadFeedback();
          disposeRecord(record);
          return;
        }
        promote();
      })
      .catch((reason) => {
        loadSettled = true;
        if (timeout !== null) window.clearTimeout(timeout);
        if (cancelled) return;
        clearLoadFeedback();
        if (!activeRecordRef.current) {
          setPdfError(message(reason));
          setNumPages(null);
          onNumPagesRef.current?.(null);
        }
        setLoadedKey(stableLoadKey);
        disposeRecord(record);
      });

    return () => {
      if (timeout !== null) window.clearTimeout(timeout);
      if (promoted && activeRecordRef.current === record) return;
      cancelled = true;
      if (loadSettled) disposeRecord(record);
    };
  }, [
    browserHosted,
    disposeRecord,
    effectiveTimeoutMessage,
    initialViewStateSnapshot,
    resetLocationHistory,
    scheduleViewState,
    stableLoadKey,
    syncHistoryAvailability,
    t,
  ]);

  useEffect(() => () => {
    if (viewStateFrameRef.current !== null) {
      window.cancelAnimationFrame(viewStateFrameRef.current);
      viewStateFrameRef.current = null;
    }
    reportViewState();
    const active = activeRecordRef.current;
    activeRecordRef.current = null;
    if (active) disposeRecord(active);
  }, [disposeRecord, reportViewState]);

  useEffect(() => {
    const root = activeRecordRef.current?.root;
    if (!hasActiveViewer || !root) return;
    let lastReported = "";
    let reportFrame: number | null = null;
    const reportFromSelection = () => {
      reportFrame = null;
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
      if (reportFrame !== null) window.cancelAnimationFrame(reportFrame);
      reportFrame = window.requestAnimationFrame(reportFromSelection);
    };
    root.addEventListener("mouseup", onMouseUp);
    root.addEventListener("keyup", reportFromSelection);
    document.addEventListener("selectionchange", reportFromSelection);
    return () => {
      if (reportFrame !== null) window.cancelAnimationFrame(reportFrame);
      root.removeEventListener("mouseup", onMouseUp);
      root.removeEventListener("keyup", reportFromSelection);
      document.removeEventListener("selectionchange", reportFromSelection);
    };
  }, [activeViewerGeneration, hasActiveViewer]);

  const applyManualScale = useCallback((value: number) => {
    const next = clamp(value, PDF_MIN_SCALE, PDF_MAX_SCALE);
    setFitMode(null);
    setScale(next);
    const slick = activeRecordRef.current?.slick;
    // eslint-disable-next-line react-hooks/immutability -- PDFSlick's documented zoom API is an imperative property setter.
    if (slick) slick.viewer.currentScale = toViewerScale(next);
  }, []);

  const zoomValueLabelRef = useRef<HTMLLabelElement | null>(null);
  useNonPassiveWheel(zoomValueLabelRef, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!event.deltaY) return;
    applyManualScale(clamp(
      Number((scaleRef.current + (event.deltaY < 0 ? 0.1 : -0.1)).toFixed(1)),
      PDF_MIN_SCALE,
      PDF_MAX_SCALE,
    ));
  });

  const pendingZoomAnchorRef = useRef<{ x: number; y: number; prevScale: number } | null>(null);
  useEffect(() => {
    const area = scrollAreaRef.current;
    if (!hasActiveViewer || !area) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const previous = scaleRef.current;
      const next = clamp(
        Number((previous * Math.exp(-event.deltaY * 0.01)).toFixed(3)),
        PDF_MIN_SCALE,
        PDF_MAX_SCALE,
      );
      if (next === previous) return;
      const bounds = area.getBoundingClientRect();
      pendingZoomAnchorRef.current = {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top,
        prevScale: previous,
      };
      applyManualScale(next);
    };
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => area.removeEventListener("wheel", onWheel);
  }, [activeViewerGeneration, applyManualScale, hasActiveViewer]);

  useLayoutEffect(() => {
    const area = scrollAreaRef.current;
    const anchor = pendingZoomAnchorRef.current;
    if (!area || !anchor) return;
    pendingZoomAnchorRef.current = null;
    const ratio = scale / anchor.prevScale;
    area.scrollLeft = (area.scrollLeft + anchor.x) * ratio - anchor.x;
    area.scrollTop = (area.scrollTop + anchor.y) * ratio - anchor.y;
  }, [scale]);

  // Tauri forwards AppKit magnify events because WKWebView does not consistently
  // surface ctrl-wheel or DOM gesture events for native trackpads.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let factor = 1;
    let timer: number | null = null;
    let anchor: { x: number; y: number; scrollLeft: number; scrollTop: number } | null = null;
    void listen<{ magnification: number; x: number; y: number }>("trackpad-magnify", (event) => {
      const record = activeRecordRef.current;
      const area = record?.root;
      if (!record || !area) return;
      const bounds = area.getBoundingClientRect();
      const { magnification, x, y } = event.payload;
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
      if (!anchor) {
        anchor = {
          x: x - bounds.left,
          y: y - bounds.top,
          scrollLeft: area.scrollLeft,
          scrollTop: area.scrollTop,
        };
      }
      factor = clamp(scaleRef.current * factor * (1 + magnification), PDF_MIN_SCALE, PDF_MAX_SCALE)
        / scaleRef.current;
      record.viewer.style.transform = `scale(${factor})`;
      record.viewer.style.transformOrigin = "0 0";
      area.scrollLeft = (anchor.scrollLeft + anchor.x) * factor - anchor.x;
      area.scrollTop = (anchor.scrollTop + anchor.y) * factor - anchor.y;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        record.viewer.style.transform = "";
        record.viewer.style.transformOrigin = "";
        const next = clamp(scaleRef.current * factor, PDF_MIN_SCALE, PDF_MAX_SCALE);
        factor = 1;
        anchor = null;
        applyManualScale(Number(next.toFixed(3)));
      }, 160);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      unlisten?.();
    };
  }, [applyManualScale]);

  // Kept as a browser fallback for engines that expose WebKit gesture events.
  useEffect(() => {
    const area = scrollAreaRef.current;
    if (!hasActiveViewer || !area) return;
    let startScale = scaleRef.current;
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      startScale = scaleRef.current;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
      if (typeof gesture.scale !== "number") return;
      const bounds = area.getBoundingClientRect();
      pendingZoomAnchorRef.current = {
        x: (gesture.clientX ?? bounds.left + bounds.width / 2) - bounds.left,
        y: (gesture.clientY ?? bounds.top + bounds.height / 2) - bounds.top,
        prevScale: scaleRef.current,
      };
      applyManualScale(Number((startScale * gesture.scale).toFixed(3)));
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
  }, [activeViewerGeneration, applyManualScale, hasActiveViewer]);

  const toggleFit = useCallback((mode: "width" | "height") => {
    if (!activeRecordRef.current) return;
    if (fitModeRef.current === mode) {
      setFitMode(null);
      return;
    }
    setFitMode(mode);
    activeRecordRef.current.slick.viewer.currentScaleValue = mode === "width" ? "page-width" : "page-fit";
  }, []);

  useEffect(() => {
    const area = scrollAreaRef.current;
    const slick = activeRecordRef.current?.slick;
    if (!slick || !area || !fitMode || typeof ResizeObserver === "undefined") return;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const fit = () => {
      // eslint-disable-next-line react-hooks/immutability -- PDFSlick's documented fit API is an imperative property setter.
      slick.viewer.currentScaleValue = fitMode === "width" ? "page-width" : "page-fit";
    };
    const observer = new ResizeObserver(() => {
      if (settle) clearTimeout(settle);
      settle = setTimeout(fit, PDF_REFIT_SETTLE_MS);
    });
    observer.observe(area);
    fit();
    return () => {
      observer.disconnect();
      if (settle) clearTimeout(settle);
    };
  }, [activeViewerGeneration, fitMode]);

  const goToPage = useCallback((nextPage: number) => {
    const slick = activeRecordRef.current?.slick;
    if (!slick || !numPages) return;
    const page = clamp(Math.floor(nextPage), 1, numPages);
    slick.gotoPage(page);
    setPageNumber(page);
  }, [numPages]);

  const navigateLocationHistory = useCallback((direction: "back" | "forward") => {
    const record = activeRecordRef.current;
    if (!record) return;
    const history = locationHistoryRef.current;
    const source = direction === "back" ? history.back : history.forward;
    const target = source.pop();
    if (!target) return;
    const current = capturePdfLocation(record);
    if (direction === "back") history.forward.push(current);
    else history.back.push(current);
    syncHistoryAvailability();

    const navigationToken = ++locationNavigationTokenRef.current;
    fitModeRef.current = target.fitMode;
    scaleRef.current = target.scale;
    setFitMode(target.fitMode);
    setScale(target.scale);
    if (target.fitMode) {
      record.slick.viewer.currentScaleValue = target.fitMode === "width" ? "page-width" : "page-fit";
    } else {
      record.slick.viewer.currentScale = toViewerScale(target.scale);
    }
    window.requestAnimationFrame(() => {
      if (
        activeRecordRef.current !== record
        || locationNavigationTokenRef.current !== navigationToken
      ) return;
      record.slick.gotoPage(target.page);
      record.root.scrollTop = target.scrollTop;
      record.root.scrollLeft = target.scrollLeft;
      setPageNumber(target.page);
      scheduleViewState();
    });
  }, [scheduleViewState, syncHistoryAvailability]);

  useEffect(() => {
    const record = activeRecordRef.current;
    if (!record) return;
    syncHighlightRef.current?.remove();
    syncHighlightRef.current = null;
    if (!syncTarget || syncTarget.page < 1 || syncTarget.page > (numPages ?? 0)) return;
    record.slick.gotoPage(syncTarget.page);
    const frame = window.requestAnimationFrame(() => {
      const pageView = record.slick.viewer.getPageView(syncTarget.page - 1) as PdfSlickPageView | undefined;
      const pageElement = pageView?.div;
      if (!pageElement) return;
      const viewportScale = pageView.viewport?.scale ?? scaleRef.current;
      const highlight = document.createElement("div");
      highlight.className = "pdf-synctex-highlight";
      highlight.dataset.syncTarget = syncTarget.id;
      highlight.setAttribute("aria-label", t`Source location in PDF`);
      highlight.style.left = `${syncTarget.x * viewportScale}px`;
      highlight.style.top = `${syncTarget.y * viewportScale}px`;
      highlight.style.width = `${Math.max(18, syncTarget.width * viewportScale)}px`;
      highlight.style.height = `${Math.max(12, syncTarget.height * viewportScale)}px`;
      pageElement.append(highlight);
      syncHighlightRef.current = highlight;
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (syncHighlightRef.current?.dataset.syncTarget === syncTarget.id) {
        syncHighlightRef.current.remove();
        syncHighlightRef.current = null;
      }
    };
  }, [activeViewerGeneration, numPages, scale, syncTarget, t]);

  const dispatchFind = useCallback((query: string, findPrevious = false, again = false) => {
    const slick = activeRecordRef.current?.slick;
    if (!slick) return;
    if (!query.trim()) {
      slick.dispatch("findbarclose", { source: slick });
      setSearchMatches({ current: 0, total: 0 });
      return;
    }
    slick.dispatch("find", {
      source: slick,
      type: again ? "again" : "",
      query,
      caseSensitive: searchMatchCase,
      entireWord: searchWholeWord,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    });
  }, [searchMatchCase, searchWholeWord]);

  const focusPdfSurface = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const interactiveSelector = ["a", "button", "input", "select", "textarea", `[${"contenteditable"}]`]
      .join(", ");
    if (target?.closest(interactiveSelector)) return;
    event.currentTarget.focus({ preventScroll: true });
  }, []);

  const handlePdfFindShortcut = useCallback((event: KeyboardEvent) => {
    if (
      event.key.toLocaleLowerCase() !== "f"
      || (!event.metaKey && !event.ctrlKey)
      || event.altKey
      || event.shiftKey
    ) return;
    event.preventDefault();
    event.stopPropagation();
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    let selectedText = "";
    if (selection && !selection.isCollapsed && anchor && activeRecordRef.current?.root.contains(anchor)) {
      selectedText = normalizePdfSelection(selection.toString());
    }
    if (
      !selectedText
      && event.target instanceof Element
      && event.target.classList.contains("pdf-copy-field")
    ) selectedText = pdfSelectedOrCachedPlainText();
    if (selectedText) setSearchQuery(selectedText);
    window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview || !loadKey) return;
    const onPointerDown = (event: PointerEvent) => {
      pdfSurfaceActiveRef.current = event.target instanceof Node && preview.contains(event.target);
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Element && target.classList.contains("pdf-copy-field")) return;
      pdfSurfaceActiveRef.current = target instanceof Node && preview.contains(target);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (pdfSurfaceActiveRef.current) handlePdfFindShortcut(event);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      pdfSurfaceActiveRef.current = false;
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [handlePdfFindShortcut, loadKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize PDFSlick's imperative find controller after promotion or query changes.
    if (hasActiveViewer) dispatchFind(searchQuery);
  }, [activeViewerGeneration, dispatchFind, hasActiveViewer, searchQuery]);

  const commitPageDraft = () => {
    if (cancelPageEditRef.current) {
      cancelPageEditRef.current = false;
    } else {
      const requested = Number.parseInt(pageDraft, 10);
      if (Number.isFinite(requested)) goToPage(requested);
    }
    setPageEditing(false);
    setPageDraft("");
  };

  const commitZoomDraft = () => {
    const next = parsePdfZoomPercent(zoomDraft);
    if (next !== null) applyManualScale(next);
    setZoomEditing(false);
    setZoomDraft("");
  };

  const loading = Boolean(loadKey && loadedKey !== loadKey);
  const currentLoadFeedback = loadFeedback?.key === loadKey ? loadFeedback : null;
  const showBlockingLoader = (loading && !hasActiveViewer) || currentLoadFeedback?.blocking === true;
  const showQuietLoader = !showBlockingLoader
    && hasActiveViewer
    && (loading || currentLoadFeedback !== null);
  const remoteSource = !byteSource && !pdfBase64;
  const loadPhase = currentLoadFeedback?.phase ?? (remoteSource ? "loading" : "rendering");
  const loadPercent = loadPhase === "loading" ? currentLoadFeedback?.percent ?? null : null;
  const loadLabel = showBlockingLoader
    ? loadPhase === "loading"
      ? t`Loading PDF…`
      : t`Rendering first page…`
    : t`Updating…`;

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
        <div className="pdf-placeholder">
          <FileText size={28} />
          <p>{t`Build the project to preview the paper`}</p>
        </div>
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

  return (
    <div
      ref={previewRef}
      className="pdf-preview"
      tabIndex={-1}
      onPointerDownCapture={focusPdfSurface}
    >
      <div className="pdf-toolbar">
        <div className="pdf-navigation-controls">
          {toolbarStart}
          <div className="pdf-page-controls">
            <Tip label={t`Previous page`}>
              <button disabled={pageNumber <= 1} onClick={() => goToPage(pageNumber - 1)}>
                <ChevronLeft size={14} />
              </button>
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
                ? <span className="pdf-page-total">/ {numPages ?? "–"}</span>
                : <span className="pdf-page-display" aria-hidden="true">{pageNumber} / {numPages ?? "–"}</span>}
            </label>
            <Tip label={t`Next page`}>
              <button disabled={!numPages || pageNumber >= numPages} onClick={() => goToPage(pageNumber + 1)}>
                <ChevronRight size={14} />
              </button>
            </Tip>
          </div>
          <div className="pdf-history-controls">
            <Tip label={t`Previous PDF location`}>
              <button
                type="button"
                disabled={!historyAvailability.back}
                onClick={() => navigateLocationHistory("back")}
              >
                <CornerUpLeft size={14} />
              </button>
            </Tip>
            <Tip label={t`Next PDF location`}>
              <button
                type="button"
                disabled={!historyAvailability.forward}
                onClick={() => navigateLocationHistory("forward")}
              >
                <CornerUpRight size={14} />
              </button>
            </Tip>
          </div>
        </div>
        <div className="pdf-find-controls">
          {outline}
          <SearchField
            ref={searchInputRef}
            aria-label={t`Search PDF`}
            containerClassName="pdf-search"
            controlSize="compact"
            showIcon={!searchQuery}
            value={searchQuery}
            placeholder={t`Find in PDF`}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && searchQuery) {
                event.preventDefault();
                dispatchFind(searchQuery, event.shiftKey, true);
              } else if (event.key === "Escape" && searchQuery) {
                event.preventDefault();
                setSearchQuery("");
              }
            }}
            trailing={searchQuery ? (
              <>
                <Tip label={t`Match case`}>
                  <button
                    type="button"
                    className="pdf-search-option"
                    aria-pressed={searchMatchCase}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setSearchMatchCase((enabled) => !enabled)}
                  >
                    <CaseSensitive size={12} />
                  </button>
                </Tip>
                <Tip label={t`Whole word`}>
                  <button
                    type="button"
                    className="pdf-search-option"
                    aria-pressed={searchWholeWord}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setSearchWholeWord((enabled) => !enabled)}
                  >
                    <WholeWord size={12} />
                  </button>
                </Tip>
                <small className="pdf-search-position" aria-live="polite">
                  {searchMatches.total ? `${searchMatches.current} / ${searchMatches.total}` : "0 / 0"}
                </small>
                <Tip label={t`Previous search result`}>
                  <button
                    type="button"
                    disabled={!searchMatches.total}
                    onClick={() => dispatchFind(searchQuery, true, true)}
                  >
                    <ChevronUp size={12} />
                  </button>
                </Tip>
                <Tip label={t`Next search result`}>
                  <button
                    type="button"
                    disabled={!searchMatches.total}
                    onClick={() => dispatchFind(searchQuery, false, true)}
                  >
                    <ChevronDown size={12} />
                  </button>
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
            <button
              className="pdf-zoom-step"
              disabled={scale <= PDF_MIN_SCALE}
              onClick={() => applyManualScale(Number((scaleRef.current - 0.1).toFixed(1)))}
            >
              <ZoomOut size={14} />
            </button>
          </Tip>
          <label
            ref={zoomValueLabelRef}
            className="pdf-zoom-value pdf-zoom-step"
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
            <button
              className="pdf-zoom-step"
              disabled={scale >= PDF_MAX_SCALE}
              onClick={() => applyManualScale(Number((scaleRef.current + 0.1).toFixed(1)))}
            >
              <ZoomIn size={14} />
            </button>
          </Tip>
          <i className="pdf-fit-divider pdf-zoom-step" aria-hidden="true" />
          {onForwardSync && (
            <>
              <Tip label={t`Reveal cursor in PDF (⌘⇧J)`}>
                <button
                  type="button"
                  disabled={!canForwardSync || locatingPdf}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={onForwardSync}
                >
                  {locatingPdf ? <InfinityLoader size={14} /> : <LocateFixed size={14} />}
                </button>
              </Tip>
              <i className="pdf-fit-divider" aria-hidden="true" />
            </>
          )}
          <Tip label={t`Fit page to width`}>
            <button
              className={fitMode === "width" ? "active" : ""}
              aria-pressed={fitMode === "width"}
              disabled={!hasActiveViewer}
              onClick={() => toggleFit("width")}
            >
              <RectangleHorizontal size={14} />
            </button>
          </Tip>
          <Tip label={t`Fit page to height`}>
            <button
              className={fitMode === "height" ? "active" : ""}
              aria-pressed={fitMode === "height"}
              disabled={!hasActiveViewer}
              onClick={() => toggleFit("height")}
            >
              <RectangleVertical size={14} />
            </button>
          </Tip>
          {toolbarEnd}
          {showSave && (
            <Tip label={effectiveSaveLabel}>
              <MotionButton disabled={!pdfBytes || savingPdf} onClick={() => void download()}>
                {savingPdf ? <InfinityLoader size={14} /> : <Download size={14} />}
              </MotionButton>
            </Tip>
          )}
        </div>
      </div>
      <div className="pdf-scroll-area">
        <div ref={hostRef} className="pdf-viewer-host" />
        {pdfError && !hasActiveViewer
          ? <div className="pdf-placeholder"><CircleAlert size={24} /><p>{pdfError}</p></div>
          : null}
        {showBlockingLoader || showQuietLoader
          ? (
              <div
                className={`pdf-loading smooth-shadow-ring-md${showQuietLoader ? " pdf-loading-quiet" : ""}`}
                role="status"
                aria-live="polite"
              >
                <InfinityLoader size={showBlockingLoader ? 17 : 14} />
                <span>{loadLabel}</span>
                {loadPercent !== null ? (
                  <>
                    <div
                      className="pdf-load-progress"
                      role="progressbar"
                      aria-label={t`PDF loading progress`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={loadPercent}
                    >
                      <div className="pdf-load-progress-fill" style={{ width: `${loadPercent}%` }} />
                    </div>
                    <span className="pdf-load-percent" aria-hidden="true">{loadPercent}%</span>
                  </>
                ) : null}
              </div>
            )
          : null}
      </div>
    </div>
  );
}
