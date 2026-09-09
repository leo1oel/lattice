/** Copied from pdfjs-dist into public/pdfjs by the Vite pdfjs-assets plugin. */
function pdfAssetUrl(relative: string): string {
  try {
    return new URL(`${import.meta.env.BASE_URL}${relative}`, window.location.href).href;
  } catch {
    return `${import.meta.env.BASE_URL}${relative}`;
  }
}

/** Shared by every getDocument() call so previews and the viewer agree on fonts. */
export const PDF_CMAP_URL = pdfAssetUrl("pdfjs/cmaps/");
export const PDF_STANDARD_FONT_DATA_URL = pdfAssetUrl("pdfjs/standard_fonts/");

/** PDFSlick 4.0.2 still asks PDF.js 6 for legacy document-property IDs. */
export function pdfSlickTranslationId(id: string): string {
  if (!id.startsWith("document_properties_page_size_")) return id;
  return `pdfjs-${id.replaceAll("_", "-")}`
    .replace(/-name-a3$/, "-name-a-three")
    .replace(/-name-a4$/, "-name-a-four");
}

/** Normalize a browser text selection from the PDF text layer for agent context. */
export function normalizePdfSelection(raw: string): string {
  return raw.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export const PDF_MIN_SCALE = 0.3;
export const PDF_MAX_SCALE = 5;

/** Turn a directly entered percentage into the viewer's bounded scale. */
export function parsePdfZoomPercent(value: string): number | null {
  const percent = Number(value.trim().replace(/%$/, ""));
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, Number((percent / 100).toFixed(3))));
}
