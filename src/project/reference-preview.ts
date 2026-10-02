import type { ProjectPdfFile } from "../pdf/project-pdf";
import { PDF_CMAP_URL, PDF_STANDARD_FONT_DATA_URL } from "../pdf/pdf-viewer-utils";

/**
 * A project asset as `read_project_asset` returns it: figures and HTML inline,
 * PDFs as their length and version, which PDF.js reads a range at a time
 * instead of receiving the whole file in one reply.
 */
export type ReferenceAssetPreview = {
  path: string;
  mimeType: string;
} & (
  | { base64: string; ranges?: undefined }
  | { ranges: { length: number; version: string }; base64?: undefined }
);

/** An inline asset as a `data:` URL; null for a PDF, which is read in ranges. */
export function assetDataUrl(asset: ReferenceAssetPreview): string | null {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- data: URL
  return asset.base64 === undefined ? null : `data:${asset.mimeType};base64,${asset.base64}`;
}

/** The project PDF an asset names, when it is read in ranges. */
export function assetPdfFile(asset: ReferenceAssetPreview): ProjectPdfFile | null {
  return asset.ranges ? { path: asset.path, ...asset.ranges } : null;
}

export async function referenceAssetPreviewDataUrl(asset: ReferenceAssetPreview): Promise<string | null> {
  if (asset.mimeType.startsWith("image/") || asset.mimeType === "text/html") return assetDataUrl(asset);
  const file = assetPdfFile(asset);
  if (asset.mimeType !== "application/pdf" || !file) return null;

  // Keep PDF.js out of startup for the common image-preview path: the same
  // PDF.js the viewer uses is loaded only for an actual PDF reference asset.
  // A hover must also work before any PDF opens, so the shared runtime sets
  // up the worker and polyfills the viewer relies on.
  const [{ getDocument }, { projectPdfTransport }] = await Promise.all([
    import("../pdf/pdfjs-runtime"),
    import("../pdf/project-pdf"),
  ]);
  // A failed read ends the load instead of leaving it waiting for the range.
  const range = projectPdfTransport(file, () => void loadingTask.destroy());
  const loadingTask = getDocument({
    range,
    // Read only the ranges the first page needs, in the viewer's 1 MiB chunks.
    rangeChunkSize: 2 ** 20,
    disableAutoFetch: true,
    disableStream: true,
    cMapUrl: PDF_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
    // Match the main viewer: WKWebView can silently paint embedded Type 1
    // FontFace glyphs as blank even though PDF.js reports a successful render.
    disableFontFace: true,
    useSystemFonts: false,
  });
  try {
    const documentProxy = await loadingTask.promise;
    const page = await documentProxy.getPage(1);
    const naturalViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2, 720 / Math.max(1, naturalViewport.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvas, viewport, background: "#F9F9FA" }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    await loadingTask.destroy();
  }
}
