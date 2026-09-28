import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { useNonPassiveWheel } from "../hooks/use-non-passive-wheel";
import { applyPdfZoom } from "./pdf-slick";
import { addListeners, clampPdfScale } from "./pdf-viewer-utils";
import type { ActiveViewerRef, PdfViewState } from "./use-pdf-view";

const PDF_REFIT_SETTLE_MS = 120;

type GestureEvent = Event & { scale?: number; clientX?: number; clientY?: number };

/** Keep the content point at (x, y) in the viewport fixed while the content scales by `ratio`. */
function scrollAround(area: HTMLElement, x: number, y: number, ratio: number, left = area.scrollLeft, top = area.scrollTop) {
  area.scrollLeft = (left + x) * ratio - x;
  area.scrollTop = (top + y) * ratio - y;
}

/** Zoom buttons, the scrollable zoom value, pinch/ctrl-wheel zoom around the pointer, and fit modes. */
export function usePdfZoom(recordRef: ActiveViewerRef, generation: number, view: PdfViewState) {
  const { viewRef, scale, fitMode, setScale, setFitMode } = view;
  const hasViewer = generation > 0;
  const zoomLabelRef = useRef<HTMLLabelElement | null>(null);
  const anchorRef = useRef<{ x: number; y: number; prevScale: number } | null>(null);

  const applyManualScale = useCallback((value: number) => {
    const next = clampPdfScale(value);
    setFitMode(null);
    setScale(next);
    const slick = recordRef.current?.slick;
    if (slick) applyPdfZoom(slick, null, next);
  }, [recordRef, setFitMode, setScale]);

  const stepZoom = useCallback((direction: 1 | -1) => {
    applyManualScale(Number((viewRef.current.scale + direction * 0.1).toFixed(1)));
  }, [applyManualScale, viewRef]);

  useNonPassiveWheel(zoomLabelRef, (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.deltaY) stepZoom(event.deltaY < 0 ? 1 : -1);
  });

  // Ctrl-wheel and WebKit gesture events zoom around the pointer: remember the
  // anchor, then correct the scroll offset once the new scale has rendered.
  useEffect(() => {
    const area = recordRef.current?.root;
    if (!hasViewer || !area) return;
    const zoomAround = (next: number, clientX?: number, clientY?: number) => {
      const bounds = area.getBoundingClientRect();
      anchorRef.current = {
        x: (clientX ?? bounds.left + bounds.width / 2) - bounds.left,
        y: (clientY ?? bounds.top + bounds.height / 2) - bounds.top,
        prevScale: viewRef.current.scale,
      };
      applyManualScale(next);
    };
    let gestureStartScale = viewRef.current.scale;
    return addListeners(area, {
      wheel: (event: WheelEvent) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        const previous = viewRef.current.scale;
        const next = clampPdfScale(Number((previous * Math.exp(-event.deltaY * 0.01)).toFixed(3)));
        if (next !== previous) zoomAround(next, event.clientX, event.clientY);
      },
      // Kept as a browser fallback for engines that expose WebKit gesture events.
      gesturestart: (event: Event) => {
        event.preventDefault();
        gestureStartScale = viewRef.current.scale;
      },
      gesturechange: (event: GestureEvent) => {
        event.preventDefault();
        if (typeof event.scale !== "number") return;
        zoomAround(Number((gestureStartScale * event.scale).toFixed(3)), event.clientX, event.clientY);
      },
      gestureend: (event: Event) => event.preventDefault(),
    }, { passive: false });
  }, [applyManualScale, generation, hasViewer, recordRef, viewRef]);

  useLayoutEffect(() => {
    const area = recordRef.current?.root;
    const anchor = anchorRef.current;
    if (!area || !anchor) return;
    anchorRef.current = null;
    scrollAround(area, anchor.x, anchor.y, scale / anchor.prevScale);
  }, [recordRef, scale]);

  // Tauri forwards AppKit magnify events because WKWebView does not consistently
  // surface ctrl-wheel or DOM gesture events for native trackpads. The pinch is
  // previewed as a CSS transform and committed as one PDF.js rescale once it settles.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let factor = 1;
    let timer: number | null = null;
    let anchor: { x: number; y: number; scrollLeft: number; scrollTop: number } | null = null;
    void listen<{ magnification: number; x: number; y: number }>("trackpad-magnify", (event) => {
      const record = recordRef.current;
      if (!record) return;
      const area = record.root;
      const bounds = area.getBoundingClientRect();
      const { magnification, x, y } = event.payload;
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
      if (!anchor) anchor = { x: x - bounds.left, y: y - bounds.top, scrollLeft: area.scrollLeft, scrollTop: area.scrollTop };
      factor = clampPdfScale(viewRef.current.scale * factor * (1 + magnification)) / viewRef.current.scale;
      record.viewer.style.transform = `scale(${factor})`;
      record.viewer.style.transformOrigin = "0 0";
      scrollAround(area, anchor.x, anchor.y, factor, anchor.scrollLeft, anchor.scrollTop);
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        record.viewer.style.transform = "";
        record.viewer.style.transformOrigin = "";
        const next = clampPdfScale(viewRef.current.scale * factor);
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
  }, [applyManualScale, recordRef, viewRef]);

  const toggleFit = useCallback((mode: "width" | "height") => {
    const slick = recordRef.current?.slick;
    if (!slick) return;
    if (viewRef.current.fitMode === mode) {
      setFitMode(null);
      return;
    }
    setFitMode(mode);
    applyPdfZoom(slick, mode);
  }, [recordRef, setFitMode, viewRef]);

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
