/* eslint lingui/no-unlocalized-strings: "off" -- PDF.js/PDFSlick class names and API identifiers only. */
/**
 * The imperative PDFSlick adapter: PDF.js runtime setup, viewer options, and
 * the DOM/service lifecycle of one viewer instance ("record"). A record is
 * staged hidden while it loads and promoted once PDFSlick reports pagesReady;
 * React state stays in the hooks that drive it.
 */
import { PDFSlick, type PDFSlickOptions } from "@pdfslick/core";
import {
  PDF_CMAP_URL,
  PDF_STANDARD_FONT_DATA_URL,
  pdfScaleValue,
  pdfSlickTranslationId,
  toViewerScale,
  type PdfFitMode,
} from "./pdf-viewer-utils";
import type { PDFDataRangeTransport } from "./pdfjs-runtime";
import "./pdfjs-runtime";

const PDF_RANGE_CHUNK_BYTES = 2 ** 20;
/** PDF.js's `AnnotationEditorType.DISABLE`. */
const ANNOTATION_EDITOR_DISABLED = -1;

export type ViewerRecord = {
  key: string;
  slick: PDFSlick;
  root: HTMLDivElement;
  viewer: HTMLDivElement;
  /** Selection behaviour installed on each rendered text layer, by layer. */
  textLayers: Map<HTMLElement, () => void>;
  /** Listeners and service patches to undo before PDFSlick is torn down. */
  cleanup: Array<() => void>;
  destroyed: boolean;
};

type PdfSlickPageView = {
  div?: HTMLDivElement;
  textLayer?: { div?: HTMLDivElement };
  viewport?: { scale?: number };
};

export function pdfPageView(slick: PDFSlick, page: number) {
  return slick.viewer.getPageView(page - 1) as PdfSlickPageView | undefined;
}

/** The page and PDF-unit point under a pointer event inside the record's viewer. */
export function pdfPointAt({ slick, root }: ViewerRecord, event: MouseEvent, fallbackScale: number) {
  const pageElement = event.target instanceof HTMLElement
    ? event.target.closest<HTMLElement>("[data-page-number]")
    : null;
  if (!pageElement || !root.contains(pageElement)) return null;
  const page = Number.parseInt(pageElement.dataset.pageNumber ?? "", 10);
  const viewportScale = pdfPageView(slick, page)?.viewport?.scale ?? fallbackScale;
  const bounds = pageElement.getBoundingClientRect();
  const toPdfUnits = (offset: number) => Number((offset / viewportScale).toFixed(3));
  return { page, x: toPdfUnits(event.clientX - bounds.left), y: toPdfUnits(event.clientY - bounds.top) };
}

export function viewerOptions(
  browserHosted: boolean,
  scaleValue: string,
  documentData: ArrayBuffer | null,
  range: PDFDataRangeTransport | null = null,
): PDFSlickOptions {
  // Read pages on demand when the bytes are already here, or when a range is
  // a local read: a 1 GB scan must not be pulled into memory just because it
  // was opened.
  const onDemand = documentData !== null || range !== null;
  return {
    scaleValue,
    // Lattice never edits annotations. PDFSlick's default (NONE) still builds
    // PDF.js's editor manager, whose document-wide dragover/drop listeners
    // throw "#editorTypes is not iterable" on every drag, so a paper, file or
    // Finder drop anywhere in the window logged an unexpected error.
    annotationEditorMode: ANNOTATION_EDITOR_DISABLED,
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
      // A project file: PDF.js asks this transport for the ranges it needs.
      ...(range ? { range } : {}),
      // arXiv's response startup latency makes PDF.js's 64 KiB default very
      // expensive for non-linearized papers: one first page can require many
      // sequential ranges. Favor fewer requests over conserving a small amount
      // of overlapping early data.
      rangeChunkSize: PDF_RANGE_CHUNK_BYTES,
      // PDFViewer eagerly initializes 250 pages after its first paint. Local
      // byte sources are already complete, and a project file answers a range
      // in a few milliseconds, so keep page proxies lazy and let a far jump
      // request its target directly. PDF.js requires streaming to be disabled
      // as well for disableAutoFetch to take effect. Remote URL sources keep
      // both features because their server may fulfill incremental range reads.
      disableAutoFetch: onDemand,
      disableStream: onDemand,
      // WKWebView can accept an embedded Type 1 font through FontFace but then
      // paint none of its glyphs. Drawing glyph outlines bypasses that path and
      // still leaves PDF.js's selectable text layer available. Chromium's font
      // path is correct and much cheaper, so keep it enabled there.
      disableFontFace: !browserHosted,
      useSystemFonts: false,
    },
  };
}

/** Mount a PDFSlick viewer under `host`; a staged one stays hidden until promoted. */
export function createViewerRecord(
  key: string,
  host: HTMLElement,
  staged: boolean,
  options: PDFSlickOptions,
  onError: (reason: unknown) => void,
): ViewerRecord {
  const root = document.createElement("div");
  root.className = "pdfSlick pdfSlickViewer pdf-scroll-area-viewport";
  root.dataset.slot = "scroll-area-viewport";
  root.classList.toggle("pdf-viewer-staging", staged);
  const viewer = document.createElement("div");
  viewer.className = "pdfViewer pdf-pages";
  root.append(viewer);
  host.append(root);
  // PDFSlick reports PDF.js failures through this callback and deliberately
  // resolves loadDocument; the caller keeps the error so it can leave an old
  // document visible or explain a failed first load.
  const slick = new PDFSlick({ container: root, viewer, options, onError });
  // We paint glyph-clipped selections ourselves. PDF.js's DrawLayer would
  // also paint the range (including page-sized sentinel boxes). PDFSlick
  // doesn't forward this option, so set it before loadDocument creates pages.
  slick.viewer.enableSelectionRendering = false;
  // Preserve PDF.js's Fluent catalog and methods, translating only the stale
  // IDs used by PDFSlick's metadata parser before it loads the document.
  const getTranslation = slick.l10n.get.bind(slick.l10n);
  slick.l10n.get = (ids: string | string[], args, fallback) =>
    getTranslation(Array.isArray(ids) ? ids.map(pdfSlickTranslationId) : pdfSlickTranslationId(ids), args, fallback);
  return { key, slick, root, viewer, textLayers: new Map(), cleanup: [], destroyed: false };
}

/** Fit the pages, or apply a manual app scale when not fitted, through PDFSlick's imperative zoom setters. */
export function applyPdfZoom(slick: PDFSlick, fitMode: PdfFitMode, scale = 1) {
  if (fitMode) slick.viewer.currentScaleValue = pdfScaleValue(fitMode, scale);
  else slick.viewer.currentScale = toViewerScale(scale);
}

/** Subscribe PDFSlick event handlers; PDFSlick types every event payload as `Object`. */
export function onPdfEvents(slick: PDFSlick, handlers: Record<string, (event: never) => void>) {
  for (const [name, handler] of Object.entries(handlers)) slick.on(name, handler as (event: object) => void);
}

export async function destroyViewerRecord(record: ViewerRecord): Promise<void> {
  if (record.destroyed) return;
  record.destroyed = true;
  for (const dispose of [...record.textLayers.values(), ...record.cleanup]) dispose();
  record.textLayers.clear();
  const { slick } = record;
  slick.unbindEvents();
  const objectUrl = typeof slick.url === "string" && slick.url.startsWith("blob:") ? slick.url : null;
  const loadingTask = slick.loadingTask;
  // Release canvas backing stores now instead of whenever the detached
  // pages are collected; with enableHWA each one can hold GPU memory.
  // (Before setDocument(null), which empties the viewer element.)
  for (const canvas of record.root.querySelectorAll("canvas")) {
    canvas.width = 0;
    canvas.height = 0;
  }
  // PDFViewer.setDocument(null) is PDF.js's only viewer teardown: it cancels
  // each page's text layer (dropping it from TextLayerBuilder's static map,
  // which otherwise keeps every replaced viewer's pages reachable from the
  // window), aborts the viewer's document listeners and destroys the
  // annotation editor manager's window/document listeners. Destroying only
  // the loading task left all of that alive, so every rebuild leaked the
  // previous viewer with its pages and canvases.
  // (The typings omit null, which is PDF.js's documented detach value.)
  (slick.viewer as unknown as { setDocument(document: null): void }).setDocument(null);
  slick.linkService.setDocument(null);
  if (loadingTask) await Promise.resolve(loadingTask.destroy()).catch(() => undefined);
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  record.root.remove();
}
