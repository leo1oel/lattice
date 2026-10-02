import { useCallback, useEffect, useRef } from "react";
import { listenInThisWindow } from "../app/window-events";
import { useNonPassiveWheel } from "../hooks/use-non-passive-wheel";
import { applyPdfZoom, pdfPageView, type ViewerRecord } from "./pdf-slick";
import { addListeners, clampPdfScale, PDF_MIN_SCALE } from "./pdf-viewer-utils";
import type { ActiveViewerRef, PdfViewState } from "./use-pdf-view";

const PDF_REFIT_SETTLE_MS = 120;
/**
 * Ctrl-wheel, pinch and the zoom buttons all preview as a CSS transform of the
 * viewer and rescale PDF.js once, this long after the last event. A rescale
 * restyles and lays out every page box (thousands in a long PDF), so doing it
 * per wheel or pinch tick is what made zooming a long PDF stutter, in WebKit
 * most of all. Long enough to bridge the gaps between one gesture's events.
 */
const PDF_ZOOM_COMMIT_MS = 80;

type GestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };

/** A zoom shown as a transform of the viewer that PDF.js has not applied yet. */
type ZoomPreview = {
  record: ViewerRecord;
  /** The applied scale the preview started from, and the scale it shows. */
  base: number;
  target: number;
  /** The point that stays put while zooming, in client pixels. */
  x: number;
  y: number;
  timer: number;
};

/** The PDF page drawn at a client point, if any. */
function pageAt(record: ViewerRecord, x: number, y: number): HTMLElement | null {
  if (typeof document.elementFromPoint !== "function") return null;
  const page = document.elementFromPoint(x, y)?.closest<HTMLElement>(".page");
  return page && record.viewer.contains(page) ? page : null;
}

/**
 * A clip of the viewer to the pages a preview can bring on screen, even zoomed
 * all the way out: those within the viewport's height times the largest shrink
 * of the page at the held point. WebKit repaints every page box of a
 * transformed viewer each frame, off screen too: zooming out of a 1,930-page
 * PDF ran at 25 fps until the clip left it a handful.
 */
function reachClip(record: ViewerRecord, anchor: HTMLElement, base: number, viewer: DOMRect): string {
  const area = record.root.getBoundingClientRect();
  const reach = area.height * base / PDF_MIN_SCALE;
  let { top, bottom } = anchor.getBoundingClientRect();
  for (let page = anchor.previousElementSibling; page && top > area.top - reach; page = page.previousElementSibling) {
    top = page.getBoundingClientRect().top;
  }
  for (let page = anchor.nextElementSibling; page && bottom < area.bottom + reach; page = page.nextElementSibling) {
    bottom = page.getBoundingClientRect().bottom;
  }
  // eslint-disable-next-line lingui/no-unlocalized-strings -- CSS value
  return `inset(${top - viewer.top}px 0 ${viewer.bottom - bottom}px 0)`;
}

/** Zoom buttons, the scrollable zoom value, pinch/ctrl-wheel zoom around the pointer, and fit modes. */
export function usePdfZoom(recordRef: ActiveViewerRef, generation: number, view: PdfViewState) {
  const { viewRef, fitMode, setScale, setFitMode } = view;
  const hasViewer = generation > 0;
  const zoomLabelRef = useRef<HTMLLabelElement | null>(null);
  const previewRef = useRef<ZoomPreview | null>(null);

  /** The scale the next zoom step starts from: the previewed one while a zoom is pending. */
  const currentScale = useCallback(() => previewRef.current?.target ?? viewRef.current.scale, [viewRef]);

  /** Shows a percentage in the zoom field without a React render, unless someone is typing in it. */
  const showZoomValue = useCallback((value: number) => {
    const input = zoomLabelRef.current?.querySelector("input");
    if (input && input !== document.activeElement) input.value = String(Math.round(value * 100));
  }, []);

  const applyScale = useCallback((value: number) => {
    const next = clampPdfScale(value);
    viewRef.current.fitMode = null;
    viewRef.current.scale = next;
    setFitMode(null);
    setScale(next);
    const slick = recordRef.current?.slick;
    if (slick) applyPdfZoom(slick, null, next);
  }, [recordRef, setFitMode, setScale, viewRef]);

  const endPreview = useCallback((preview: ZoomPreview) => {
    window.clearTimeout(preview.timer);
    const { viewer } = preview.record;
    viewer.style.transform = "";
    viewer.style.transformOrigin = "";
    viewer.style.clipPath = "";
    previewRef.current = null;
  }, []);

  /** Drops a pending zoom without applying it. */
  const cancelPreview = useCallback(() => {
    const preview = previewRef.current;
    if (!preview) return;
    endPreview(preview);
    showZoomValue(viewRef.current.scale);
  }, [endPreview, showZoomValue, viewRef]);

  /**
   * Applies the previewed zoom, then scrolls so the held point lands where the
   * preview showed it. Measured on its page rather than scaled from the scroll
   * offset: the gaps between pages do not scale, which adds up to whole pages
   * of drift deep into a long PDF.
   */
  const commitPreview = useCallback(() => {
    const preview = previewRef.current;
    if (!preview) return;
    const { record, target, x, y } = preview;
    const page = pageAt(record, x, y) ?? pdfPageView(record.slick, viewRef.current.page)?.div ?? null;
    const shown = page?.getBoundingClientRect();
    endPreview(preview);
    if (recordRef.current !== record) return;
    applyScale(target);
    if (!page || !shown?.width || !shown.height) return;
    const applied = page.getBoundingClientRect();
    record.root.scrollLeft += applied.left + (x - shown.left) * (applied.width / shown.width) - x;
    record.root.scrollTop += applied.top + (y - shown.top) * (applied.height / shown.height) - y;
  }, [applyScale, endPreview, recordRef, viewRef]);

  /** Shows `value` around the client point (the viewport's center by default) and applies it once input stops. */
  const previewZoom = useCallback((value: number, clientX?: number, clientY?: number) => {
    const record = recordRef.current;
    if (!record) return;
    if (previewRef.current?.record !== record) cancelPreview();
    const target = Number(clampPdfScale(value).toFixed(3));
    let preview = previewRef.current;
    if (!preview) {
      const base = viewRef.current.scale;
      if (target === base) return;
      const area = record.root.getBoundingClientRect();
      const x = clientX ?? area.left + area.width / 2;
      const y = clientY ?? area.top + area.height / 2;
      const viewer = record.viewer.getBoundingClientRect();
      const anchor = pageAt(record, x, y) ?? pdfPageView(record.slick, viewRef.current.page)?.div;
      const clip = anchor ? reachClip(record, anchor, base, viewer) : "";
      // eslint-disable-next-line lingui/no-unlocalized-strings -- CSS value
      record.viewer.style.transformOrigin = `${x - viewer.left}px ${y - viewer.top}px`;
      record.viewer.style.clipPath = clip;
      preview = { record, base, target, x, y, timer: 0 };
      if (viewRef.current.fitMode) setFitMode(null);
    }
    window.clearTimeout(preview.timer);
    previewRef.current = { ...preview, target, timer: window.setTimeout(commitPreview, PDF_ZOOM_COMMIT_MS) };
    record.viewer.style.transform = `scale(${target / preview.base})`;
    showZoomValue(target);
  }, [cancelPreview, commitPreview, recordRef, setFitMode, showZoomValue, viewRef]);

  // A pending zoom belongs to the document it transforms.
  useEffect(() => () => cancelPreview(), [cancelPreview, generation]);

  /** Applies a typed zoom at once. */
  const applyManualScale = useCallback((value: number) => {
    cancelPreview();
    applyScale(value);
  }, [applyScale, cancelPreview]);

  const stepZoom = useCallback((direction: 1 | -1) => {
    previewZoom(Number((currentScale() + direction * 0.1).toFixed(1)));
  }, [currentScale, previewZoom]);

  useNonPassiveWheel(zoomLabelRef, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.deltaY) stepZoom(event.deltaY < 0 ? 1 : -1);
  });

  // Ctrl-wheel (Chromium also reports trackpad pinches this way) and WebKit
  // gesture events zoom around the pointer.
  useEffect(() => {
    const area = recordRef.current?.root;
    if (!hasViewer || !area) return;
    let gestureStartScale = currentScale();
    return addListeners(area, {
      wheel: (event: WheelEvent) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        previewZoom(currentScale() * Math.exp(-event.deltaY * 0.01), event.clientX, event.clientY);
      },
      // Kept as a browser fallback for engines that expose WebKit gesture events.
      gesturestart: (event: Event) => {
        event.preventDefault();
        gestureStartScale = currentScale();
      },
      gesturechange: (event: GestureEvent) => {
        event.preventDefault();
        if (typeof event.scale !== "number") return;
        previewZoom(gestureStartScale * event.scale, event.clientX, event.clientY);
      },
      gestureend: (event: Event) => event.preventDefault(),
    }, { passive: false });
  }, [currentScale, generation, hasViewer, previewZoom, recordRef]);

  // Tauri forwards AppKit magnify events to the focused window because WKWebView
  // does not consistently surface ctrl-wheel or DOM gesture events for native trackpads.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenInThisWindow<{ magnification: number; x: number; y: number }>("trackpad-magnify", (event) => {
      const area = recordRef.current?.root;
      if (!area) return;
      const bounds = area.getBoundingClientRect();
      const { magnification, x, y } = event.payload;
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
      previewZoom(currentScale() * (1 + magnification), x, y);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [currentScale, previewZoom, recordRef]);

  const toggleFit = useCallback((mode: "width" | "height") => {
    const slick = recordRef.current?.slick;
    if (!slick) return;
    cancelPreview();
    if (viewRef.current.fitMode === mode) {
      setFitMode(null);
      return;
    }
    setFitMode(mode);
    applyPdfZoom(slick, mode);
  }, [cancelPreview, recordRef, setFitMode, viewRef]);

  // A fitted page follows the pane size; settle resizes so a split drag does not rescale every frame.
  useEffect(() => {
    const slick = recordRef.current?.slick;
    const area = recordRef.current?.root;
    if (!slick || !area || !fitMode || typeof ResizeObserver === "undefined") return;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const fit = () => applyPdfZoom(slick, fitMode);
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
  }, [fitMode, generation, recordRef]);

  return { zoomLabelRef, applyManualScale, stepZoom, toggleFit };
}
