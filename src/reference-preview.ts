// Legacy build + shared font assets, for the same reason as the main viewer:
// see the note in pdf-viewer.tsx.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDF_CMAP_URL, PDF_STANDARD_FONT_DATA_URL } from "./pdf-viewer-utils";

export type ReferenceAssetPreview = {
  path: string;
  mimeType: string;
  base64: string;
};

export async function referenceAssetPreviewDataUrl(asset: ReferenceAssetPreview): Promise<string | null> {
  if (asset.mimeType.startsWith("image/")) {
    return `data:${asset.mimeType};base64,${asset.base64}`;
  }
  if (asset.mimeType !== "application/pdf") return null;

  const binary = atob(asset.base64);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const loadingTask = getDocument({
    data: bytes,
    cMapUrl: PDF_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
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
    await page.render({ canvas, viewport, background: "#ffffff" }).promise;
    return canvas.toDataURL("image/png");
  } finally {
    await loadingTask.destroy();
  }
}
