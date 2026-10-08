import { useEffect, useRef } from "react";
import { useLingui } from "@lingui/react/macro";
import { sourceQuoteDomRange } from "../papers/source-quote";
import { pdfPageView } from "./pdf-slick";
import type { ActiveViewerRef } from "./use-pdf-view";

export type PdfSyncTarget = {
  id: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PdfSourceQuote = {
  id: string;
  page: number;
  first: string;
  last: string;
};

/**
 * Wrap the text of `range` in marks without moving PDF.js's positioned glyph
 * spans. Returns the marks in document order.
 */
function highlightTextRange(root: HTMLElement, range: Range): HTMLElement[] {
  const prefix = document.createRange();
  prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset);
  const from = prefix.toString().length;
  const to = from + range.toString().length;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: Array<{ node: Text; from: number; to: number }> = [];
  let offset = 0;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const end = offset + node.data.length;
    if (end > from && offset < to) {
      segments.push({ node, from: Math.max(0, from - offset), to: Math.min(node.data.length, to - offset) });
    }
    offset = end;
  }
  // Split from the end so earlier offsets stay valid.
  return segments.reverse().map((segment) => {
    segment.node.splitText(segment.to);
    const selected = segment.node.splitText(segment.from);
    const mark = document.createElement("mark");
    mark.className = "pdf-source-quote-highlight";
    selected.replaceWith(mark);
    mark.append(selected);
    return mark;
  }).reverse();
}

function removeHighlights(marks: HTMLElement[]) {
  for (const mark of marks) {
    const parent = mark.parentNode;
    mark.replaceWith(...mark.childNodes);
    parent?.normalize();
  }
}

const isPageInDocument = (page: number, numPages: number | null) => page >= 1 && page <= (numPages ?? 0);

/** True the first time this ref sees `id`: each target navigates and scrolls once. */
function firstTime(seen: { current: string | null }, id: string) {
  if (seen.current === id) return false;
  seen.current = id;
  return true;
}

/**
 * Source locations shown in the PDF: a forward-SyncTeX box and a paper quote.
 * Each jumps to its page once per target id, then (re)draws its highlight
 * whenever the viewer, zoom, or a page/text-layer render could have cleared it.
 */
export function usePdfSourceTargets(recordRef: ActiveViewerRef, {
  syncTarget, sourceQuote, numPages, scale, generation, pageRenderGeneration, textLayerGeneration,
}: {
  syncTarget: PdfSyncTarget | null;
  sourceQuote: PdfSourceQuote | null;
  numPages: number | null;
  scale: number;
  generation: number;
  pageRenderGeneration: number;
  textLayerGeneration: number;
}) {
  const { t } = useLingui();
  const syncJumpRef = useRef<string | null>(null);
  const syncScrollRef = useRef<string | null>(null);
  const quoteJumpRef = useRef<string | null>(null);
  const quoteScrollRef = useRef<string | null>(null);

  useEffect(() => {
    const record = recordRef.current;
    const target = syncTarget;
    if (!record || !target || !isPageInDocument(target.page, numPages)) return;
    // Reloads and scale changes need a new highlight, not a replay of an old jump.
    if (firstTime(syncJumpRef, target.id)) record.slick.gotoPage(target.page);
    let highlight: HTMLDivElement | null = null;
    const frame = window.requestAnimationFrame(() => {
      const pageView = pdfPageView(record.slick, target.page);
      if (!pageView?.div) return;
      const viewportScale = pageView.viewport?.scale ?? scale;
      highlight = document.createElement("div");
      highlight.className = "pdf-synctex-highlight";
      highlight.dataset.syncTarget = target.id;
      highlight.setAttribute("aria-label", t`Source location in PDF`);
      Object.assign(highlight.style, {
        left: `${target.x * viewportScale}px`,
        top: `${target.y * viewportScale}px`,
        width: `${Math.max(18, target.width * viewportScale)}px`,
        height: `${Math.max(12, target.height * viewportScale)}px`,
      });
      // A page not drawn yet is not a positioned box (the PDF.js patch marks
      // only pages with layers): position this one for the highlight.
      pageView.div.classList.add("latticeLayered");
      pageView.div.append(highlight);
      if (firstTime(syncScrollRef, target.id)) {
        highlight.scrollIntoView({ block: "center", inline: "nearest" });
        // Keep PDF.js's cached location in step with this DOM scroll so a
        // pending fit-to-width update cannot restore the old page-top offset.
        record.slick.viewer.update();
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      highlight?.remove();
    };
  }, [generation, numPages, pageRenderGeneration, recordRef, scale, syncTarget, t]);

  useEffect(() => {
    const record = recordRef.current;
    const quote = sourceQuote;
    if (!record || !quote || !isPageInDocument(quote.page, numPages)) return;
    // A quote target is an explicit navigation request. It runs after viewer
    // promotion so it overrides restoration of the saved scroll position.
    if (firstTime(quoteJumpRef, quote.id)) record.slick.gotoPage(quote.page);
    const textLayer = pdfPageView(record.slick, quote.page)?.textLayer?.div;
    const match = textLayer?.isConnected ? sourceQuoteDomRange(textLayer, quote.first, quote.last) : null;
    if (!textLayer || !match) return;
    const marks = highlightTextRange(textLayer, match);
    if (firstTime(quoteScrollRef, quote.id)) marks[0]?.scrollIntoView({ block: "center" });
    return () => removeHighlights(marks);
  }, [generation, numPages, recordRef, scale, sourceQuote, textLayerGeneration]);
}
