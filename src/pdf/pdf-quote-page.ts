/**
 * Which page of a paper's PDF holds a passage read elsewhere (the full text
 * Lattice converted from the paper's HTML has no pages), and the anchors that
 * find it there. The page text is what PDF.js's text layer draws, a line
 * break after each line, so the anchors chosen here are the ones the
 * reader's highlight (pdf-source-targets.ts) finds again.
 */
import { findSourceQuote } from "../papers/source-quote";
import { sourceQuoteAnchors, type PaperSourceCitation } from "../papers/paper-source";
import { getDocument } from "./pdfjs-runtime";
import { PDF_CMAP_URL, PDF_STANDARD_FONT_DATA_URL } from "./pdf-viewer-utils";

type PageTextSource = { numPages: number; getPage: (number: number) => Promise<{ getTextContent: () => Promise<{ items: object[] }> }> };

async function pageText(document: PageTextSource, number: number): Promise<string> {
  const content = await (await document.getPage(number)).getTextContent();
  return content.items.map((item) => ("str" in item ? `${String(item.str)}${"hasEOL" in item && item.hasEOL ? "\n" : ""}` : "")).join("");
}

/**
 * Where `quote` sits in `text` (one page's), as anchors that find it and
 * nothing else there; null when even the whole quote cannot be found.
 */
export function quoteAnchorsIn(text: string, quote: string): { first: string; last: string } | null {
  const unique = (first: string, last: string) => findSourceQuote(text, first, last) !== null;
  const anchors = sourceQuoteAnchors(quote, unique);
  return anchors && unique(anchors.first, anchors.last) ? anchors : null;
}

/** The first page of `document` that holds `quote` once, with its anchors there. */
export async function findQuoteInPages(document: PageTextSource, quote: string): Promise<PaperSourceCitation | null> {
  for (let page = 1; page <= document.numPages; page += 1) {
    const anchors = quoteAnchorsIn(await pageText(document, page), quote);
    if (anchors) return { page, ...anchors };
  }
  return null;
}

/**
 * Find `quote` in the PDF at `source` (its bytes, or a URL PDF.js may fetch).
 * Resolves the place and the document's bytes, which the reader keeps for
 * showing the PDF next.
 */
export async function findQuotePage(
  source: { data: ArrayBuffer } | { url: string }, quote: string,
): Promise<{ place: PaperSourceCitation | null; bytes: ArrayBuffer }> {
  const task = getDocument({
    // PDF.js transfers the bytes it is given to its worker; keep the caller's.
    ...("data" in source ? { data: source.data.slice(0) } : { url: source.url }),
    cMapUrl: PDF_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
  });
  try {
    const document = await task.promise;
    const place = await findQuoteInPages(document, quote);
    const bytes = "data" in source ? source.data : (await document.getData()).slice().buffer;
    return { place, bytes };
  } finally {
    void task.destroy();
  }
}
