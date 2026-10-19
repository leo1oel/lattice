/**
 * The live preview drawn over the compiled PDF's pages. A page gets a canvas
 * of its own, between pdf.js's drawing and its text layer, only when there is
 * something to show on it:
 *
 * - a page rtex has laid out again since the PDF under it was built is drawn
 *   whole, from its display list when rtex describes it exactly, else from
 *   the fallback PDF of that layout;
 * - the paragraphs being typed are painted over it, their previous rows
 *   cleared first (the plugin's renderPage, webview/main.ts).
 *
 * Every other page is pdf.js's alone. The canvas takes no pointer events, so
 * selection, links and the double-click to the source (on the last real
 * SyncTeX) work as they do without it.
 */
import { useEffect } from "react";
import type { ActiveViewerRef } from "../pdf/use-pdf-view";
import type { PdfRenderCount } from "../pdf/use-pdf-document";
import { pdfPageView, type ViewerRecord } from "../pdf/pdf-slick";
import { cachedPictureMoves, type Rect } from "./rtex-model";
import { inexactReason, Painter, type Mat } from "./rtex-render";
import { SP_PER_BP } from "./rtex-protocol";
import type { LivePreviewSession } from "./live-preview-session";

const PT = 65536;
/** pdf.js's own canvas cap (pdf-slick.ts): the overlay drops resolution beyond it. */
const MAX_CANVAS_PIXELS = 2 ** 24;
const LAYER_CLASS = "live-preview-page-layer";

export function LivePreviewLayer({ session, recordRef, generation, renderCount }: {
  session: LivePreviewSession;
  recordRef: ActiveViewerRef;
  generation: number;
  renderCount: PdfRenderCount;
}) {
  useEffect(() => {
    const record = recordRef.current;
    if (!record) return;
    // A new viewer: the PDF the build pipeline announced is the one on screen.
    session.basePromoted();
    const painter = new PagePainter(session, record);
    const unsubscribePages = session.subscribePages((pages) => painter.invalidate(pages));
    // pdf.js draws a page again on zoom, and adds and drops pages as they near
    // the view: each draw may have taken the canvas with it.
    const unsubscribeRenders = renderCount.subscribe(() => painter.invalidate("all"));
    painter.invalidate("all");
    return () => {
      unsubscribePages();
      unsubscribeRenders();
      painter.dispose();
    };
  }, [generation, recordRef, renderCount, session]);
  return null;
}

type Drawn = { canvas: HTMLCanvasElement; token: number };

class PagePainter {
  private readonly drawn = new Map<number, Drawn>();
  private readonly dirty = new Set<number>();
  private all = false;
  private frame = 0;
  private token = 0;
  private disposed = false;

  constructor(private readonly session: LivePreviewSession, private readonly record: ViewerRecord) {}

  invalidate(pages: ReadonlySet<number> | "all"): void {
    if (pages === "all") this.all = true;
    else for (const page of pages) this.dirty.add(page);
    if (!this.frame) this.frame = window.requestAnimationFrame(() => this.flush());
  }

  dispose(): void {
    this.disposed = true;
    window.cancelAnimationFrame(this.frame);
    for (const { canvas } of this.drawn.values()) canvas.remove();
    this.drawn.clear();
  }

  private flush(): void {
    this.frame = 0;
    const pages = new Set(this.dirty);
    if (this.all) {
      const count = this.record.slick.viewer.pagesCount ?? 0;
      for (let page = 1; page <= count; page++) pages.add(page);
      for (const page of this.drawn.keys()) pages.add(page);
    }
    this.dirty.clear();
    this.all = false;
    for (const page of pages) void this.draw(page);
  }

  private wants(page: number): boolean {
    const { model } = this.session;
    return model.pageSource(page).kind !== "base" || model.overlaysOn(page).length > 0 || model.hiddenLines(page).size > 0;
  }

  private async draw(page: number): Promise<void> {
    const view = pdfPageView(this.record.slick, page);
    const div = view?.div;
    const previous = this.drawn.get(page);
    if (!div?.isConnected || !view?.viewport || !this.wants(page)) {
      previous?.canvas.remove();
      this.drawn.delete(page);
      return;
    }
    const token = ++this.token;
    const { model, fonts, images } = this.session;
    const cssWidth = view.viewport.width ?? div.clientWidth;
    const cssHeight = view.viewport.height ?? div.clientHeight;
    // css px per sp: pdf.js's viewport scale is css px per PDF point (bp).
    const k = (view.viewport.scale ?? 1) / SP_PER_BP;
    let dpr = window.devicePixelRatio || 1;
    if (cssWidth * cssHeight * dpr * dpr > MAX_CANVAS_PIXELS) dpr = Math.sqrt(MAX_CANVAS_PIXELS / (cssWidth * cssHeight));
    const canvas = document.createElement("canvas");
    canvas.className = LAYER_CLASS;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    canvas.setAttribute("aria-hidden", "true");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const base: Mat = [k * dpr, 0, 0, k * dpr, 0, 0];
    const source = model.pageSource(page);
    const hidden = model.hiddenLines(page);
    const overlays = model.overlaysOn(page);
    const pageList = source.kind === "base" ? model.pages.get(page) : source.page;
    let pictureSnaps: { img: ImageData; dst: Rect }[] = [];

    if (source.kind === "display-list") {
      const lines = source.page.dl.lines.filter((_, i) => !hidden.has(i));
      // A font still loading or missing would draw approximately: the page
      // shows the PDF under it until everything it needs is in, and the
      // status says the layout is catching up.
      if (inexactReason(source.page.dl, fonts, images, lines)) {
        previous?.canvas.remove();
        this.drawn.delete(page);
        return;
      }
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const painter = new Painter(ctx, base, fonts, images);
      painter.draw(source.page.dl, source.page.dl.other ?? []);
      for (const line of lines) painter.draw(source.page.dl, line.items);
    } else if (source.kind === "fallback") {
      const document = await this.session.fallbackDocument(source.layoutVersion);
      if (this.disposed) return;
      if (document && page <= document.numPages) {
        const pdfPage = await document.getPage(page);
        const viewport = pdfPage.getViewport({ scale: (view.viewport.scale ?? 1) * dpr });
        await pdfPage.render({ canvas, viewport }).promise;
        if (this.disposed) return;
        pictureSnaps = overlays.flatMap(({ overlay, rows }) => (
          cachedPictureMoves(source.page.dl, rows, model.ownLines(page, overlay.parId)).flatMap(({ src, dst }) => {
            const img = grabRect(ctx, base, src);
            return img ? [{ img, dst }] : [];
          })
        ));
      }
      new Painter(ctx, base, fonts, images).clearLines(
        source.page.dl.lines.filter((_, i) => hidden.has(i)).map((line) => ({ line, dx: 0, dy: 0 })),
        "#fff",
      );
    } else if (pageList) {
      // The base PDF's page is rtex's page as of the base: clear the rows the
      // live paragraphs held there.
      new Painter(ctx, base, fonts, images).clearLines(
        pageList.dl.lines.filter((_, i) => hidden.has(i)).map((line) => ({ line, dx: 0, dy: 0 })),
        "#fff",
      );
    }
    // Live units: clear the bands their rows occupy now (they may reach into
    // following material until the next layout), put their cached pictures
    // back, then draw their rows, so a picture never covers live text and no
    // clear erases a picture already placed.
    const painters = overlays.map(() => new Painter(ctx, base, fonts, images));
    overlays.forEach(({ rows }, i) => painters[i].clearRects(rowBands(rows), "#fff"));
    for (const { img, dst } of pictureSnaps) putRect(ctx, base, img, dst);
    overlays.forEach(({ overlay, rows }, i) => {
      painters[i].draw(overlay.dl, overlay.dl.other ?? []);
      for (const r of rows) painters[i].draw(overlay.dl, r.line.items, r.dx, r.dy);
    });
    if (this.disposed) return;
    // A newer draw of this page started while this one waited for its PDF.
    const current = this.drawn.get(page);
    if (current && current.token > token) return;
    const live = pdfPageView(this.record.slick, page)?.div;
    if (!live?.isConnected) return;
    // A page not drawn yet is not a positioned box (the PDF.js patch marks
    // only pages with layers): position this one for the canvas.
    live.classList.add("latticeLayered");
    // Under the text layer, so selection and links stay on top.
    const textLayer = live.querySelector(".textLayer");
    if (current?.canvas.parentElement === live) current.canvas.replaceWith(canvas);
    else {
      current?.canvas.remove();
      live.insertBefore(canvas, textLayer);
    }
    this.drawn.set(page, { canvas, token });
    this.session.painted(page);
  }
}

/** Device-pixel rectangle of an sp rectangle under the page's base matrix (scale only). */
function deviceRect(base: Mat, r: Rect): [number, number, number, number] {
  const x = Math.round(r.x * base[0] + base[4]);
  const y = Math.round(r.y * base[3] + base[5]);
  return [x, y, Math.max(0, Math.round((r.x + r.w) * base[0] + base[4]) - x), Math.max(0, Math.round((r.y + r.h) * base[3] + base[5]) - y)];
}

/** The pixels of `r` (sp) on the canvas, or undefined when it is empty or off the canvas. */
function grabRect(ctx: CanvasRenderingContext2D, base: Mat, r: Rect): ImageData | undefined {
  const [x, y, w, h] = deviceRect(base, r);
  if (w < 1 || h < 1 || x >= ctx.canvas.width || y >= ctx.canvas.height || x + w <= 0 || y + h <= 0) return undefined;
  return ctx.getImageData(x, y, w, h);
}

/** Put pixels taken by grabRect at the top-left of `r` (sp); putImageData ignores the transform. */
function putRect(ctx: CanvasRenderingContext2D, base: Mat, img: ImageData, r: Rect): void {
  const [x, y] = deviceRect(base, r);
  ctx.putImageData(img, x, y);
}

/** Rectangles [x0, y0, x1, y1] (sp) covering each overlay row and the gap above it. */
export function rowBands(rows: { line: { x: number; y: number; w: number; h: number; d: number }; dx: number; dy: number }[]): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let prevBottom: number | undefined;
  let prevBase = -Infinity;
  for (const { line, dx, dy } of rows) {
    const baseline = line.y + dy;
    const ownTop = baseline - line.h - PT;
    const top = prevBottom !== undefined && baseline > prevBase && baseline - prevBase < 4 * (line.h + line.d + 2 * PT) ? Math.min(ownTop, prevBottom) : ownTop;
    const bottom = baseline + Math.max(line.d, 3 * PT);
    out.push([line.x + dx - PT, top, line.x + dx + line.w + PT, bottom]);
    prevBottom = bottom;
    prevBase = baseline;
  }
  return out;
}
