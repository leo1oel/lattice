import type { PdfFileViewState } from "../app-types";
import { clamp } from "../settings/app-settings";

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
  /* eslint-disable lingui/no-unlocalized-strings -- PDF.js message ids */
  return `pdfjs-${id.replaceAll("_", "-")}`
    .replace(/-name-a3$/, "-name-a-three")
    .replace(/-name-a4$/, "-name-a-four");
  /* eslint-enable lingui/no-unlocalized-strings */
}

/**
 * Preserve PDF.js's Fluent catalog and methods, translating only the stale IDs
 * PDFSlick's metadata parser asks for. PDFSlick also still passes the third
 * `fallback` argument that PDF.js 6.4 dropped from L10n.get (its print warning
 * has no message in the catalog at all); answer with it when nothing matches.
 */
export function adaptPdfSlickL10n(l10n: { get(ids: string | string[], args?: null): Promise<unknown> }) {
  const getTranslation = l10n.get.bind(l10n);
  l10n.get = async (ids: string | string[], args?: null, fallback?: string) => {
    const translated = Array.isArray(ids) ? ids.map(pdfSlickTranslationId) : pdfSlickTranslationId(ids);
    return (await getTranslation(translated, args)) || fallback;
  };
}

/** Normalize a browser text selection from the PDF text layer for agent context. */
export function normalizePdfSelection(raw: string): string {
  return raw.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export const PDF_MIN_SCALE = 0.3;
export const PDF_MAX_SCALE = 5;
/** PDF.js's viewer renders a PDF point at one CSS pixel at 75% viewer scale. */
const PDF_TO_CSS_UNITS = 96 / 72;

export type PdfFitMode = PdfFileViewState["fitMode"];

export const clampPdfScale = (scale: number) => clamp(scale, PDF_MIN_SCALE, PDF_MAX_SCALE);
/** App scales are CSS-pixel ratios; PDF.js viewer scales are relative to its 75% baseline. */
export const toAppScale = (viewerScale: number) => clampPdfScale(viewerScale * PDF_TO_CSS_UNITS);
export const toViewerScale = (appScale: number) => clampPdfScale(appScale) / PDF_TO_CSS_UNITS;

const FIT_SCALE_VALUES = { width: "page-width", height: "page-fit" } as const;

/** PDF.js `currentScaleValue` for a fit mode, or the numeric viewer scale when not fitted. */
export function pdfScaleValue(fitMode: PdfFitMode, scale: number): string {
  return fitMode ? FIT_SCALE_VALUES[fitMode] : String(toViewerScale(scale));
}

export function pdfFitMode(scaleValue: unknown): PdfFitMode {
  return scaleValue === "page-width" ? "width" : scaleValue === "page-fit" ? "height" : null;
}

/** Turn a directly entered percentage into the viewer's bounded scale. */
export function parsePdfZoomPercent(value: string): number | null {
  const percent = Number(value.trim().replace(/%$/, ""));
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return clampPdfScale(Number((percent / 100).toFixed(3)));
}

/** Add several listeners with one set of options; the returned call removes them all. */
export function addListeners(
  target: EventTarget,
  listeners: Record<string, (event: never) => void>,
  options: AddEventListenerOptions = {},
): () => void {
  const controller = new AbortController();
  for (const [type, listener] of Object.entries(listeners)) {
    target.addEventListener(type, listener as EventListener, { ...options, signal: controller.signal });
  }
  return () => controller.abort();
}
