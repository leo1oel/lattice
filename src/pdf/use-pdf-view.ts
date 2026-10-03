import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { PdfFileViewState } from "../app-types";
import { applyPdfZoom, type ViewerRecord } from "./pdf-slick";
import { clampPdfScale, pdfFitMode, toAppScale, type PdfFitMode } from "./pdf-viewer-utils";

const PDF_VIEW_PREFERENCE_KEY = "lattice.pdf-view-preference.v1";

export type PdfViewerCallbacks = {
  onTextSelect?: (text: string) => void;
  onNumPages?: (pages: number | null) => void;
  onPageChange?: (page: number) => void;
  /** Complete bytes assembled by PDF.js after a URL load, for host actions such as download. */
  onDocumentData?: (bytes: ArrayBuffer) => void;
  onViewState?: (state: PdfFileViewState) => void;
  /** The project file was rewritten or removed since this viewer opened it. */
  onFileChanged?: () => void;
  onSource?: (page: number, x: number, y: number) => void;
};

export type ActiveViewerRef = RefObject<ViewerRecord | null>;

function loadPdfViewPreference(): { fitMode: PdfFitMode; scale: number } {
  try {
    const stored = JSON.parse(localStorage.getItem(PDF_VIEW_PREFERENCE_KEY) ?? "null") as
      | { fitMode?: unknown; scale?: unknown }
      | null;
    const fitMode = stored?.fitMode;
    const scale = stored?.scale;
    return {
      fitMode: fitMode === "height" || fitMode === null ? fitMode : "width",
      scale: typeof scale === "number" && Number.isFinite(scale) ? clampPdfScale(scale) : 1.1,
    };
  } catch {
    return { fitMode: "width", scale: 1.1 };
  }
}

/**
 * Page, zoom and fit of the viewer. A file's saved view state wins over the
 * global zoom preference; the view is reported back per animation frame once
 * the first document has restored it.
 */
export function usePdfViewState(
  recordRef: ActiveViewerRef,
  initialViewState: PdfFileViewState | undefined,
  initialPage: number,
  callbacks: RefObject<PdfViewerCallbacks>,
) {
  const [initial] = useState(() => ({
    viewState: initialViewState,
    preference: initialViewState
      ? { fitMode: initialViewState.fitMode, scale: clampPdfScale(initialViewState.scale) }
      : loadPdfViewPreference(),
  }));
  const [pageNumber, setPageNumber] = useState(() => Math.max(1, Math.floor(initialViewState?.page ?? initialPage)));
  const [scale, setScale] = useState(initial.preference.scale);
  const [fitMode, setFitMode] = useState<PdfFitMode>(initial.preference.fitMode);
  const viewRef = useRef({ page: pageNumber, scale, fitMode });
  const frameRef = useRef<number | null>(null);
  const readyRef = useRef(!initial.viewState);

  useLayoutEffect(() => {
    viewRef.current = { page: pageNumber, scale, fitMode };
  }, [fitMode, pageNumber, scale]);

  useEffect(() => {
    callbacks.current.onPageChange?.(pageNumber);
  }, [callbacks, pageNumber]);

  const scrollRef = useRef({ scrollTop: initialViewState?.scrollTop ?? 0, scrollLeft: initialViewState?.scrollLeft ?? 0 });
  const report = useCallback(() => {
    frameRef.current = null;
    if (!readyRef.current) return;
    const area = recordRef.current?.root;
    // The final report runs as the viewer goes away, possibly after its
    // scroller has left the document (a panel handing the document to
    // another): that reads 0, so the place last read in the document stands.
    if (area?.isConnected) scrollRef.current = { scrollTop: area.scrollTop, scrollLeft: area.scrollLeft };
    else if (!area) scrollRef.current = { scrollTop: 0, scrollLeft: 0 };
    callbacks.current.onViewState?.({ ...viewRef.current, ...scrollRef.current });
  }, [callbacks, recordRef]);

  const schedule = useCallback(() => {
    if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(report);
  }, [report]);

  useEffect(() => schedule(), [pageNumber, schedule]);
  useEffect(() => {
    try {
      localStorage.setItem(PDF_VIEW_PREFERENCE_KEY, JSON.stringify({ fitMode, scale }));
    } catch {
      // The current viewer still works when preference storage is unavailable.
    }
    schedule();
  }, [fitMode, scale, schedule]);

  /** Start reporting once a document has restored the initial view. */
  const activate = useCallback(() => {
    readyRef.current = true;
    schedule();
  }, [schedule]);

  /** Report the final location synchronously, before the viewer goes away. */
  const flush = useCallback(() => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    report();
  }, [report]);

  return {
    initialViewState: initial.viewState, pageNumber, setPageNumber, scale, setScale, fitMode, setFitMode,
    viewRef, schedule, activate, flush,
  };
}

export type PdfViewState = ReturnType<typeof usePdfViewState>;

type PdfLocation = PdfFileViewState;

function capturePdfLocation({ slick, root }: ViewerRecord): PdfLocation {
  return {
    page: Math.max(1, Math.floor(slick.linkService.page)),
    scale: toAppScale(slick.viewer.currentScale),
    fitMode: pdfFitMode(slick.viewer.currentScaleValue),
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

/**
 * Back/forward over internal-link jumps. PDFSlick exposes PDF.js's link
 * service but does not install its optional browser-global PDFHistory, so each
 * viewer tracks only its own destination jumps; app/tab navigation and
 * ordinary PDF scrolling remain independent.
 */
export function usePdfLocationHistory(recordRef: ActiveViewerRef, view: PdfViewState) {
  const { viewRef, setFitMode, setScale, setPageNumber, schedule } = view;
  const stacksRef = useRef({ back: [] as PdfLocation[], forward: [] as PdfLocation[] });
  const tokenRef = useRef(0);
  const [availability, setAvailability] = useState({ back: false, forward: false });

  const sync = useCallback(() => setAvailability({
    back: stacksRef.current.back.length > 0,
    forward: stacksRef.current.forward.length > 0,
  }), []);

  const reset = useCallback(() => {
    tokenRef.current += 1;
    stacksRef.current = { back: [], forward: [] };
    sync();
  }, [sync]);

  /** Record jumps made through the record's link service; returns the undo. */
  const track = useCallback((record: ViewerRecord) => {
    const linkService = record.slick.linkService;
    const goToDestination = linkService.goToDestination;
    const tracked: typeof goToDestination = async (destination) => {
      const from = recordRef.current === record ? capturePdfLocation(record) : null;
      const token = from ? ++tokenRef.current : 0;
      await goToDestination.call(linkService, destination);
      if (!from || recordRef.current !== record || tokenRef.current !== token) return;
      if (isSamePdfLocation(from, capturePdfLocation(record))) return;
      stacksRef.current.back.push(from);
      stacksRef.current.forward = [];
      sync();
    };
    linkService.goToDestination = tracked;
    return () => {
      if (linkService.goToDestination === tracked) linkService.goToDestination = goToDestination;
    };
  }, [recordRef, sync]);

  const navigate = useCallback((direction: "back" | "forward") => {
    const record = recordRef.current;
    const target = record && stacksRef.current[direction].pop();
    if (!record || !target) return;
    stacksRef.current[direction === "back" ? "forward" : "back"].push(capturePdfLocation(record));
    sync();
    const token = ++tokenRef.current;
    viewRef.current.fitMode = target.fitMode;
    viewRef.current.scale = target.scale;
    setFitMode(target.fitMode);
    setScale(target.scale);
    applyPdfZoom(record.slick, target.fitMode, target.scale);
    window.requestAnimationFrame(() => {
      if (recordRef.current !== record || tokenRef.current !== token) return;
      record.slick.gotoPage(target.page);
      record.root.scrollTop = target.scrollTop;
      record.root.scrollLeft = target.scrollLeft;
      setPageNumber(target.page);
      schedule();
    });
  }, [recordRef, schedule, setFitMode, setPageNumber, setScale, sync, viewRef]);

  return { availability, reset, track, navigate };
}

export type PdfLocationHistory = ReturnType<typeof usePdfLocationHistory>;
