export type PdfSearchMatch = {
  page: number;
  occurrence: number;
};

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

/** Normalize a browser text selection from the PDF text layer for agent context. */
export function normalizePdfSelection(raw: string): string {
  return raw.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function findPdfMatches(pageTexts: string[], rawQuery: string): PdfSearchMatch[] {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return [];
  const matches: PdfSearchMatch[] = [];
  pageTexts.forEach((text, pageIndex) => {
    const haystack = text.toLocaleLowerCase();
    let from = 0;
    let occurrence = 0;
    while (from <= haystack.length - query.length) {
      const index = haystack.indexOf(query, from);
      if (index < 0) break;
      matches.push({ page: pageIndex + 1, occurrence });
      occurrence += 1;
      from = index + Math.max(1, query.length);
    }
  });
  return matches;
}

export function annotationBounds(rect: number[], scale: number) {
  if (rect.length !== 4 || !rect.every(Number.isFinite) || !Number.isFinite(scale) || scale <= 0) {
    return null;
  }
  const [x1, y1, x2, y2] = rect;
  return {
    left: Math.min(x1, x2) * scale,
    top: Math.min(y1, y2) * scale,
    width: Math.abs(x2 - x1) * scale,
    height: Math.abs(y2 - y1) * scale,
  };
}

export type PdfPageSize = { width: number; height: number };

/**
 * Canvas supersampling for pdf.js. Preview.app looks fine with Type1 Times;
 * WKWebView at devicePixelRatio=1 (common in VMs) needs extra scale or glyphs go soft.
 */
export function pdfRenderPixelRatio(devicePixelRatio = 1): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  // Cap supersampling — 3× on large conference PDFs was freezing WKWebView.
  if (dpr < 1.25) return 2;
  if (dpr < 2) return 2;
  return Math.min(Math.max(dpr, 2), 2.5);
}

/** Scale that fits a page into the scroll area (padding deducted). */
export function fitPdfScale(
  mode: "width" | "page",
  page: PdfPageSize,
  area: { width: number; height: number },
  padding = { x: 48, y: 40 },
  limits = { min: 0.6, max: 2.2 },
): number {
  if (!(page.width > 0) || !(page.height > 0) || !(area.width > 0) || !(area.height > 0)) {
    return 1;
  }
  const availableWidth = Math.max(1, area.width - padding.x);
  const availableHeight = Math.max(1, area.height - padding.y);
  const raw = mode === "width"
    ? availableWidth / page.width
    : Math.min(availableWidth / page.width, availableHeight / page.height);
  return Math.min(limits.max, Math.max(limits.min, Number(raw.toFixed(2))));
}

