/**
 * A rebuilt PDF shown in the viewer that is already open, redrawing only the
 * pages the rebuild changed.
 *
 * Replacing the whole viewer (use-pdf-document.ts's staged load) blanks every
 * visible page until PDF.js draws it again, and drops the reader's text
 * selection and search. Most rebuilds change one page of a paper, though, and
 * the backend can tell which (src-tauri/src/pdf_pages.rs): every page has a
 * signature of everything it draws, and two builds that give a page the same
 * one draw it the same. So the open viewer moves to the new document, the
 * pages that did not change keep their canvas, text layer and links as they
 * are, and each changed page keeps showing its old canvas until the new one
 * is fully drawn. Scroll position and zoom never move.
 *
 * Anything else falls back to the staged load: a new page count, outline,
 * page labels or forms (the signatures' document part), a changed page of a
 * different size, or any failure on the way.
 */
import { invoke } from "@tauri-apps/api/core";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { getDocument } from "./pdfjs-runtime";
import type { ViewerRecord } from "./pdf-slick";

export type PdfPageSignatures = { document: string; pages: string[] };

/** PDF.js's `RenderingStates.FINISHED`: the page's canvas is complete. */
const RENDERING_FINISHED = 3;

/** The parts of PDF.js's PDFPageView the swap reads and writes. */
type SwappablePageView = {
  id: number;
  pdfPage: PDFPageProxy | null;
  renderingState: number;
  viewport: { scale: number; rotation: number };
  textLayer?: { pdfPage: PDFPageProxy } | null;
  annotationLayer?: { pdfPage: PDFPageProxy } | null;
  setPdfPage(page: PDFPageProxy): void;
  reset(options: { keepCanvasWrapper: boolean }): void;
};

/** The parts of PDF.js's PDFFindController the swap reads and writes. */
type SwappableFindController = {
  state: Record<string, unknown> | null;
  _highlightMatches: boolean;
  _scrollMatches: boolean;
  setDocument(document: PDFDocumentProxy): void;
};

const signed = new WeakMap<ArrayBuffer, Promise<PdfPageSignatures | null>>();

/**
 * What the backend signs, once per buffer: a build's bytes are signed as they
 * arrive, so the comparison is ready when the preview's debounce ends. Null
 * when it cannot (not a PDF it can parse, or no backend).
 */
export function pdfPageSignatures(bytes: ArrayBuffer): Promise<PdfPageSignatures | null> {
  let signatures = signed.get(bytes);
  if (!signatures) {
    // The raw IPC body is the PDF itself. A copy: the caller's buffer may be
    // transferred to PDF.js while this is in flight.
    const copy = bytes.slice(0);
    signatures = Promise.resolve()
      .then(() => invoke<PdfPageSignatures | undefined>("pdf_page_signatures", copy))
      .then((answer) => answer && Array.isArray(answer.pages) ? answer : null)
      .catch(() => null);
    signed.set(bytes, signatures);
  }
  return signatures;
}

/** The pages (from 1) whose signatures differ, or null when the document as a whole changed. */
export function changedPages(before: PdfPageSignatures, after: PdfPageSignatures): number[] | null {
  if (before.document !== after.document || before.pages.length !== after.pages.length) return null;
  return after.pages.flatMap((signature, index) => signature === before.pages[index] ? [] : [index + 1]);
}

function sameBox(left: PDFPageProxy, right: PDFPageProxy): boolean {
  return left.rotate === right.rotate && left.view.every((value, index) => value === right.view[index]);
}

/**
 * Show `bytes` in `record`'s viewer in place, redrawing `changed` pages only.
 * Resolves whether it did; `isCurrent` is asked before anything on screen
 * changes, so a swap overtaken by a newer build or a closed viewer leaves the
 * viewer as it was.
 */
export async function swapPdfPages(
  record: ViewerRecord, bytes: ArrayBuffer, changed: readonly number[], isCurrent: () => boolean,
): Promise<boolean> {
  const { slick } = record;
  const viewer = slick.viewer as unknown as {
    pdfDocument: PDFDocumentProxy | null;
    pagesCount: number;
    getPageView(index: number): SwappablePageView | undefined;
    update(): void;
  };
  const task = getDocument({ ...slick.getDocumentParams, data: bytes.slice(0), enableHWA: slick.enableHWA });
  const abandon = () => {
    void Promise.resolve(task.destroy()).catch(() => undefined);
    return false;
  };
  let next: PDFDocumentProxy;
  try {
    next = await task.promise;
  } catch {
    return abandon();
  }
  if (!isCurrent() || next.numPages !== viewer.pagesCount) return abandon();
  // Pages PDF.js has not loaded yet load from whichever document the viewer
  // has when they are needed; the ones it has move to the new document now.
  const views = Array.from({ length: viewer.pagesCount }, (_, index) => viewer.getPageView(index))
    .filter((view): view is SwappablePageView & { pdfPage: PDFPageProxy } => Boolean(view?.pdfPage));
  let pages: PDFPageProxy[];
  try {
    pages = await Promise.all(views.map((view) => next.getPage(view.id)));
  } catch {
    return abandon();
  }
  if (!isCurrent() || views.some((view, index) => !sameBox(view.pdfPage, pages[index]))) return abandon();

  // From here on, synchronously: nothing may draw between the two documents.
  const previousTask = slick.loadingTask;
  const finder = slick.findController as unknown as SwappableFindController | null;
  const search = finder?._highlightMatches ? finder.state : null;
  viewer.pdfDocument = next;
  slick.document = next;
  slick.loadingTask = task;
  slick.linkService.setDocument(next);
  const redraw = new Set(changed);
  views.forEach((view, index) => {
    const page = pages[index];
    if (view.renderingState !== RENDERING_FINISHED) {
      // Not fully drawn yet: start it again from the new document.
      view.setPdfPage(page);
    } else if (redraw.has(view.id)) {
      // Keep the old canvas on screen; PDF.js swaps in the new one once it
      // is complete, and rebuilds the text and link layers with it.
      view.pdfPage = page;
      view.viewport = page.getViewport({ scale: view.viewport.scale, rotation: view.viewport.rotation });
      view.reset({ keepCanvasWrapper: true });
    } else {
      view.pdfPage = page;
      if (view.textLayer) view.textLayer.pdfPage = page;
      if (view.annotationLayer) view.annotationLayer.pdfPage = page;
    }
  });
  if (finder) rerunSearch(record, finder, next, search);
  // PDFSlick's own copy of the document, for its download fallback.
  if (typeof slick.url === "string" && slick.url.startsWith("blob:")) URL.revokeObjectURL(slick.url);
  slick.url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  viewer.update();
  if (previousTask) void Promise.resolve(previousTask.destroy()).catch(() => undefined);
  return true;
}

/**
 * Point Find at the new document and search it again for what was on screen.
 * PDF.js would also take the reader to the first match from the current page,
 * which a rebuild must not do, so scrolling to a match stays off until the
 * reader searches again themselves.
 */
function rerunSearch(
  { slick }: ViewerRecord, finder: SwappableFindController, next: PDFDocumentProxy,
  search: Record<string, unknown> | null,
) {
  finder.setDocument(next);
  if (!search) return;
  Object.defineProperty(finder, "_scrollMatches", { configurable: true, get: () => false, set: () => undefined });
  slick.dispatch("find", { ...search, source: slick, type: "highlightallchange" });
  const restore = () => {
    slick.off("find", restore);
    delete (finder as Partial<SwappableFindController>)._scrollMatches;
    finder._scrollMatches = false;
  };
  slick.on("find", restore);
}
