/**
 * What the live preview's layer draws with besides the model: the fonts and
 * images its display lists name, and the fallback PDF of a layout rtex could
 * not describe exactly. The session in the workspace window and its mirror in
 * the PDF's separate window (live-preview-mirror.ts) each keep their own, read
 * through the host from the same rtex session.
 */
import { FontStore, ImageStore } from "./rtex-render";
import type { ModelOp, PreviewModel } from "./rtex-model";
import { ResourceLoader } from "./rtex-resources";
import type { DisplayList } from "./rtex-protocol";
import { getDocument } from "../pdf/pdfjs-runtime";
import { PDF_CMAP_URL, PDF_STANDARD_FONT_DATA_URL } from "../pdf/pdf-viewer-utils";

export type PdfDocument = Awaited<ReturnType<typeof getDocument>["promise"]>;

export type ReadLiveFile = (kind: "font" | "image" | "fallback", path: string) => Promise<Uint8Array>;

/** The fallback PDF of one layout, by the path rtex wrote it at. */
export type FallbackSource = { path: string; layoutVersion: number };

export class LivePreviewAssets {
  readonly fonts = new FontStore();
  readonly images = new ImageStore(rasterizePdfImage);
  private readonly resources: ResourceLoader;
  /** Kept in memory: rtex deletes the file two layouts later. */
  private fallback: (FallbackSource & { document: Promise<PdfDocument | null> }) | null = null;
  private disposed = false;

  /** `changed`: something loaded, so every page may draw differently now. */
  constructor(private readonly read: ReadLiveFile, private readonly changed: () => void) {
    this.images.onLoaded = () => {
      if (!this.disposed) changed();
    };
    this.resources = new ResourceLoader((kind, path) => read(kind, path));
  }

  /** The fonts and images `dls` draw with that are not in yet. */
  load(dls: DisplayList[]): void {
    const fonts = this.resources.fontsFor(dls, (key) => this.fonts.has(key)).then((found) => {
      for (const [key, resource] of found) this.fonts.add(key, resource);
      return found.size;
    });
    const images = this.resources.imagesFor(dls, (file) => this.images.has(file)).then((found) => {
      for (const [file, { resource, page }] of found) this.images.add(file, resource, page);
      return found.size;
    });
    void Promise.all([fonts, images]).then(([newFonts, newImages]) => {
      if (!this.disposed && newFonts + newImages > 0) this.changed();
    });
  }

  loadFallback(source: FallbackSource): void {
    const previous = this.fallback;
    const document = this.read("fallback", source.path)
      .then((data) => getDocument({
        data,
        cMapUrl: PDF_CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
        // As the main viewer: WKWebView can paint embedded Type 1 FontFace glyphs blank.
        disableFontFace: true,
        useSystemFonts: false,
      }).promise)
      .catch(() => null);
    this.fallback = { ...source, document };
    void document.then(() => {
      void previous?.document.then((old) => old?.loadingTask.destroy());
      if (!this.disposed) this.changed();
    });
  }

  /** The fallback PDF that draws pages of layout `layoutVersion`, once loaded. */
  fallbackDocument(layoutVersion: number): Promise<PdfDocument | null> | null {
    return this.fallback && this.fallback.layoutVersion >= layoutVersion ? this.fallback.document : null;
  }

  /** The newest fallback PDF's file, for a mirror that starts from this state. */
  fallbackSource(): FallbackSource | null {
    return this.fallback && { path: this.fallback.path, layoutVersion: this.fallback.layoutVersion };
  }

  dispose(): void {
    this.disposed = true;
    void this.fallback?.document.then((document) => document?.loadingTask.destroy());
  }
}

/**
 * Make `change` to `model` and load what its drawing needs into `assets`
 * (`fallback`: the PDF rtex wrote with a layout). Returns the pages to draw
 * again. The session and its mirror change their models only through this,
 * so both draw the same pages.
 */
export function applyModelOp(
  model: PreviewModel, assets: LivePreviewAssets, change: ModelOp, fallback: string | null = null,
): ReadonlySet<number> | "all" {
  if (change.op === "layout" && fallback) assets.loadFallback({ path: fallback, layoutVersion: change.input.layoutVersion });
  const dirty = model.apply(change);
  // Only the pages drawn from the display list need its fonts and images:
  // most pages stay the PDF's, and a paper's figures run to tens of MB.
  if (change.op === "layout") assets.load(change.input.pages.filter((page) => model.pageSource(page.page).kind === "display-list").map((page) => page.dl));
  if (change.op === "paragraph" && change.fragments.length) assets.load([change.dl]);
  return dirty;
}

/** A PDF image a display list draws (\includegraphics of a PDF), rasterized once for drawImage. */
async function rasterizePdfImage(data: Uint8Array, n: number): Promise<CanvasImageSource> {
  const task = getDocument({ data: data.slice(), disableFontFace: true, useSystemFonts: false });
  const document = await task.promise;
  try {
    const page = await document.getPage(Math.max(1, Math.min(n, document.numPages)));
    const natural = page.getViewport({ scale: 1 });
    // enough pixels for a sharp figure at 200 % zoom on a 2× screen
    const scale = Math.min(6, 2400 / Math.max(natural.width, natural.height));
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvas, viewport }).promise;
    return canvas;
  } finally {
    void task.destroy();
  }
}
