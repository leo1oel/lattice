import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useLingui } from "@lingui/react/macro";
import { toMessage } from "../app-utils";
import { isBrowserHosted } from "../platform/browser-runtime";
import { pdfBytesFingerprint } from "./pdf-bytes";
import { projectPdfTransport, type ProjectPdfFile } from "./project-pdf";
import { isProjectPdfStale } from "./project-pdf-refusals";
import { createViewerRecord, destroyViewerRecord, onPdfEvents, pdfPageView, pdfPointAt, viewerOptions } from "./pdf-slick";
import { installPdfTextLayerSelection, refreshPdfTextLayerSelection } from "./pdf-text-layer-selection";
import { addListeners, pdfFitMode, pdfScaleValue, toAppScale } from "./pdf-viewer-utils";
import { clamp } from "../settings/app-settings";
import { useLatestRef } from "../hooks/use-latest-ref";
import { addAppLog } from "../telemetry/app-log-store";
import type { ActiveViewerRef, PdfViewerCallbacks, PdfLocationHistory, PdfViewState } from "./use-pdf-view";

const PDF_LOAD_TIMEOUT_MS = 45_000;
/** `FindState.PENDING` in pdfjs-dist/web/pdf_viewer (pinned by pdf-find-events.test.ts). */
const PDF_FIND_PENDING = 3;

export type PdfSource = { url: string | null; bytes: ArrayBuffer | null; file: ProjectPdfFile | null; key: string };

/** Fingerprint the document so identical rebuilds do not reload the viewer. */
export function pdfSource(url: string | null, pdfBytes: ArrayBuffer | null, file: ProjectPdfFile | null = null): PdfSource {
  // A blob URL made from the same bytes is only a handle for them.
  const bytes = pdfBytes && (!url || url.startsWith("blob:")) ? pdfBytes : null;
  const key = file
    ? `file:${file.path}:${file.version}`
    : bytes ? `bytes:${pdfBytesFingerprint(bytes)}` : (url ? `url:${url}` : "");
  return { url, bytes, file, key };
}

export type PdfLoadFeedback = {
  key: string;
  phase: "loading" | "rendering";
  percent: number | null;
  blocking: boolean;
};

export type PdfFindMatches = { current: number; total: number };

/** PDF.js transfers the buffers it is given, so every consumer gets its own copy. */
function copyPdfBuffer(bytes: ArrayBuffer | Uint8Array): ArrayBuffer {
  return (bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).slice().buffer;
}

/**
 * Load the current source into a staged PDFSlick viewer and promote it once
 * PDFSlick's pages are ready, restoring the previous viewer's location. The
 * old document stays readable until then; failures only replace an empty pane.
 */
export function usePdfDocument({
  hostRef, recordRef, setGeneration, source, view, history, callbacks, onFindMatches, timeoutMessage,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  recordRef: ActiveViewerRef;
  setGeneration: Dispatch<SetStateAction<number>>;
  source: PdfSource;
  view: PdfViewState;
  history: PdfLocationHistory;
  callbacks: RefObject<PdfViewerCallbacks>;
  onFindMatches: (matches: PdfFindMatches) => void;
  timeoutMessage: string;
}) {
  const { t } = useLingui();
  const browserHosted = isBrowserHosted();
  const sourceRef = useLatestRef(source);
  const [stableLoadKey, setStableLoadKey] = useState("");
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [pdfError, setPdfError] = useState("");
  // PDF.js exceptions are English library text: shown as secondary detail only.
  const [pdfErrorDetail, setPdfErrorDetail] = useState("");
  const [loadFeedback, setLoadFeedback] = useState<PdfLoadFeedback | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageRenderGeneration, setPageRenderGeneration] = useState(0);
  const [textLayerGeneration, setTextLayerGeneration] = useState(0);
  const { initialViewState, viewRef, setPageNumber, setScale, setFitMode, schedule, activate, flush } = view;
  const { reset: resetHistory, track: trackHistory } = history;

  // Coalesce rapid rebuild fingerprints before replacing the active document.
  // Keep the old instance readable until the replacement finishes initial scaling.
  useEffect(() => {
    if (!source.key) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- source removal cancels the debounced replacement immediately.
      setStableLoadKey("");
      return;
    }
    const timer = window.setTimeout(() => setStableLoadKey(source.key), recordRef.current ? 900 : 120);
    return () => window.clearTimeout(timer);
  }, [recordRef, source.key]);

  useEffect(() => {
    const host = hostRef.current;
    if (!stableLoadKey) {
      const previous = recordRef.current;
      recordRef.current = null;
      setGeneration(0);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- removing the source clears the imperative viewer and its React mirror together.
      setNumPages(null);
      setLoadedKey(null);
      resetHistory();
      callbacks.current.onNumPages?.(null);
      if (previous) void destroyViewerRecord(previous);
      return;
    }
    if (!host) return;

    const key = stableLoadKey;
    let cancelled = false;
    let promoted = false;
    let loadSettled = false;
    let firstPageRendered = false;
    let loadFailure: unknown = null;
    let dataTimer: number | null = null;
    let timeout: number | null = null;
    let unsubscribeReady = () => {};
    const blocking = recordRef.current === null;
    const { bytes, url, file } = sourceRef.current;
    const data = bytes ? copyPdfBuffer(bytes) : null;
    // A failed range read: why the load failed, or why later pages stay blank.
    let rangeFailure: unknown = null;
    const range = file && projectPdfTransport(file, (reason) => {
      if (rangeFailure !== null) return;
      if (cancelled) {
        if (!loadSettled) disposeRecord();
        return;
      }
      rangeFailure = reason;
      // A rewritten or removed file is checked again by the host, not reported
      // here. Only a shown viewer asks: a replacement refused while its file is
      // still being written waits for the host's next check, or every partial
      // version would start another load.
      const changed = isProjectPdfStale(reason);
      if (changed && promoted) callbacks.current.onFileChanged?.();
      if (!promoted) {
        // The read is never answered, so end the load now instead of at the timeout.
        cancelled = true;
        unsubscribeReady();
        fail(reason);
        return;
      }
      // A viewer whose file has a new version on its way is being replaced.
      if (changed || sourceRef.current.key !== key) return;
      addAppLog({
        level: "warning", source: "PDF", title: t`PDF could not be loaded`, detail: toMessage(reason), toast: true,
      });
    });
    const scaleValue = () => pdfScaleValue(viewRef.current.fitMode, viewRef.current.scale);
    const options = viewerOptions(browserHosted, scaleValue(), data, range);
    const record = createViewerRecord(key, host, !blocking, options, (reason) => {
      loadFailure = reason;
    });
    const { slick, root } = record;
    const isActive = () => recordRef.current === record;
    const forwardFindMatches = ({ matchesCount, state }: { matchesCount?: Partial<PdfFindMatches>; state?: number }) => {
      // A pending search still reports the previous query's selection.
      if (!isActive() || state === PDF_FIND_PENDING) return;
      onFindMatches({ current: matchesCount?.current ?? 0, total: matchesCount?.total ?? 0 });
    };

    const updateLoadFeedback = (phase: PdfLoadFeedback["phase"], percent: number | null) => {
      if (cancelled || firstPageRendered) return;
      setLoadFeedback((current) => current?.key === key && current.phase === phase && current.percent === percent
        ? current
        : { key, phase, percent, blocking });
    };
    const clearLoadFeedback = () => setLoadFeedback((current) => current?.key === key ? null : current);
    const disposeRecord = () => void destroyViewerRecord(record);
    const fail = (reason: unknown) => {
      if (timeout !== null) window.clearTimeout(timeout);
      clearLoadFeedback();
      const title = t`PDF could not be loaded`;
      const detail = reason ? toMessage(reason) : "";
      // A replacement for a file still being written is not a failure while the
      // previous version stays on screen.
      if (!(recordRef.current && isProjectPdfStale(reason))) {
        addAppLog({ level: "warning", source: "PDF", title, detail: detail || undefined, toast: false });
      }
      if (!recordRef.current) {
        setPdfError(title);
        setPdfErrorDetail(detail);
        setNumPages(null);
        callbacks.current.onNumPages?.(null);
      }
      setLoadedKey(key);
      disposeRecord();
    };

    // Reverse SyncTeX: report the double-clicked PDF point to the host.
    const onDoubleClick = (event: MouseEvent) => {
      const onSource = callbacks.current.onSource;
      const point = onSource && pdfPointAt(record, event, viewRef.current.scale);
      if (!point) return;
      event.preventDefault();
      onSource(point.page, point.x, point.y);
    };
    record.cleanup.push(
      () => unsubscribeReady(),
      () => {
        if (dataTimer !== null) window.clearTimeout(dataTimer);
      },
      trackHistory(record),
      addListeners(root, { dblclick: onDoubleClick }),
      addListeners(root, { scroll: schedule }, { passive: true }),
    );

    const promote = () => {
      if (cancelled || promoted || !slick.document || !slick.store.getState().pagesReady) return;
      const pages = slick.document.numPages;
      promoted = true;
      unsubscribeReady();
      if (timeout !== null) window.clearTimeout(timeout);
      updateLoadFeedback("rendering", null);
      const previous = recordRef.current;
      // Zoom can also change while this document is staged.
      slick.viewer.currentScaleValue = scaleValue();
      const restorePage = Math.min(previous?.slick.linkService.page ?? viewRef.current.page, pages);
      let restoreTop = previous?.root.scrollTop ?? initialViewState?.scrollTop ?? 0;
      const restoreLeft = previous?.root.scrollLeft ?? initialViewState?.scrollLeft ?? 0;
      // Going to the page first puts it in the viewer's page window, so its
      // offset below is a real one.
      slick.gotoPage(restorePage);
      // Read at handoff, not load start: the old viewer remains interactive.
      // Anchor within the page, since earlier pages and fit scale may have changed.
      const oldPage = previous && pdfPageView(previous.slick, previous.slick.linkService.page);
      const newPage = pdfPageView(slick, restorePage);
      if (oldPage?.div?.isConnected && newPage?.div?.isConnected) {
        const ratio = (newPage.viewport?.scale ?? 1) / (oldPage.viewport?.scale ?? 1);
        restoreTop = newPage.div.offsetTop + (restoreTop - oldPage.div.offsetTop) * ratio;
      }
      root.scrollTop = restoreTop;
      root.scrollLeft = restoreLeft;
      // Publish the restored location to PDF.js before any later fit/resize pass.
      slick.viewer.update();
      root.classList.remove("pdf-viewer-staging");
      resetHistory();
      recordRef.current = record;
      setGeneration((generation) => generation + 1);
      setNumPages(pages);
      setPageNumber(restorePage);
      setScale(toAppScale(slick.viewer.currentScale));
      setLoadedKey(key);
      setPdfError("");
      setPdfErrorDetail("");
      callbacks.current.onNumPages?.(pages);
      activate();
      if (previous && previous !== record) void destroyViewerRecord(previous);
    };

    onPdfEvents(slick, {
      pagesinit: () => {
        for (let pageNumber = 1; pageNumber <= (slick.document?.numPages ?? 0); pageNumber += 1) {
          const pageElement = pdfPageView(slick, pageNumber)?.div;
          if (!pageElement) continue;
          pageElement.dataset.pdfPage = String(pageNumber);
          pageElement.setAttribute("role", "group");
          pageElement.setAttribute("aria-label", t`PDF page ${pageNumber}`);
          pageElement.classList.toggle("synctex-enabled", Boolean(callbacks.current.onSource));
        }
      },
      pagerendered: () => {
        // The first draw of a previously unvisited page can clear an overlay
        // attached before PDF.js has initialized that page's canvas.
        if (isActive()) setPageRenderGeneration((generation) => generation + 1);
        if (!firstPageRendered) {
          firstPageRendered = true;
          clearLoadFeedback();
        }
        // A layer PDF.js removed from its page. A page outside the viewer's
        // page window keeps its layers while it is out of the document.
        for (const [layer, dispose] of record.textLayers) {
          if (layer.parentElement) continue;
          dispose();
          record.textLayers.delete(layer);
        }
        const current = sourceRef.current;
        if (dataTimer !== null || current.bytes || !callbacks.current.onDocumentData) return;
        dataTimer = window.setTimeout(() => {
          if (cancelled || !slick.document) return;
          void slick.document.getData()
            .then((bytes) => callbacks.current.onDocumentData?.(copyPdfBuffer(bytes)))
            .catch(() => undefined);
        }, 750);
      },
      textlayerrendered: ({ pageNumber }: { pageNumber?: number }) => {
        const textLayer = pdfPageView(slick, pageNumber ?? 0)?.textLayer?.div;
        if (!textLayer || record.destroyed) return;
        textLayer.classList.add("pdf-text-layer");
        // A layer PDF.js kept and drew again (a zoom, or a page a live drag
        // still runs through scrolled back into view) keeps its text nodes,
        // and with them the selection: disposing it would clear that.
        if (record.textLayers.has(textLayer)) refreshPdfTextLayerSelection(textLayer);
        else record.textLayers.set(textLayer, installPdfTextLayerSelection(textLayer));
        if (isActive()) setTextLayerGeneration((generation) => generation + 1);
      },
      pagechanging: ({ pageNumber }: { pageNumber?: number }) => {
        if (isActive() && typeof pageNumber === "number") setPageNumber(pageNumber);
      },
      scalechanging: ({ scale, presetValue }: { scale?: number; presetValue?: string | null }) => {
        if (!isActive() || typeof scale !== "number") return;
        setScale(toAppScale(scale));
        setFitMode(pdfFitMode(presetValue));
      },
      // PDF.js reports a search's running total through `updatefindmatchescount`
      // but the selected match moving (Next/Previous, wraparound) only through
      // `updatefindcontrolstate`; both carry the same `matchesCount` shape.
      updatefindmatchescount: forwardFindMatches,
      updatefindcontrolstate: forwardFindMatches,
    });
    // pagesinit precedes PDFSlick's async getOutline + initial scale assignment;
    // loadDocument's promise is not a readiness barrier either. pagesReady is.
    unsubscribeReady = slick.store.subscribe(() => promote());

    timeout = window.setTimeout(() => {
      if (promoted || cancelled) return;
      cancelled = true;
      unsubscribeReady();
      clearLoadFeedback();
      if (!recordRef.current) {
        setPdfError(timeoutMessage);
        setPdfErrorDetail("");
      }
      setLoadedKey(key);
      if (loadSettled) disposeRecord();
    }, PDF_LOAD_TIMEOUT_MS);

    // With a range transport PDF.js ignores the URL; PDFSlick names the file from it.
    void slick.loadDocument(data ?? (file ? file.path : url!), {
      onProgress: ({ loaded, total }) => {
        // A project file reads only the ranges its first pages need, so the
        // share of bytes loaded is no measure of how close the page is.
        if (promoted || file) return;
        const percent = total > 0 ? Math.round(clamp((loaded / total) * 100, 0, 100)) : null;
        updateLoadFeedback(percent === 100 ? "rendering" : "loading", percent === 100 ? null : percent);
      },
    })
      .then(() => {
        loadSettled = true;
        if (cancelled) disposeRecord();
        else if (slick.document) promote();
        else fail(rangeFailure ?? loadFailure);
      })
      .catch((reason) => {
        loadSettled = true;
        if (cancelled) disposeRecord();
        else fail(rangeFailure ?? reason);
      });

    return () => {
      if (timeout !== null) window.clearTimeout(timeout);
      if (promoted && isActive()) return;
      cancelled = true;
      unsubscribeReady();
      if (loadSettled) disposeRecord();
    };
  }, [
    activate, browserHosted, callbacks, hostRef, initialViewState, onFindMatches, recordRef, resetHistory,
    schedule, setFitMode, setGeneration, setPageNumber, setScale, sourceRef, stableLoadKey, t, timeoutMessage,
    trackHistory, viewRef
  ]);

  useEffect(() => () => {
    flush();
    const active = recordRef.current;
    recordRef.current = null;
    if (active) void destroyViewerRecord(active);
  }, [flush, recordRef]);

  return { stableLoadKey, loadedKey, pdfError, pdfErrorDetail, loadFeedback, numPages, pageRenderGeneration, textLayerGeneration };
}
