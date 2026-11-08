import type { MouseEvent } from "react";
import type { PaperSummary } from "../app-types";
import { findPaperSource, paperSourceCitation, type PaperSourceCitation } from "../papers/paper-source";
import type { usePaperPdf } from "./use-paper-pdf";

/**
 * A plain click on a source link (a page of a paper's PDF, its quote in the
 * title) in the Markdown preview opens that paper's PDF in the reader rather
 * than the browser: from this paper's overview directly, from a note or
 * another paper by opening the cited paper first. Any other link, a
 * modified click, or a drag that selected text is left to the editor.
 */
export function followPaperSourceLink(event: MouseEvent, { activePaper, pdf, papers, onOpenPaperSource }: {
  activePaper: PaperSummary | null;
  pdf: Pick<ReturnType<typeof usePaperPdf>, "pdfSource" | "openPdf">;
  papers: readonly PaperSummary[];
  onOpenPaperSource?: (paper: PaperSummary, citation: PaperSourceCitation) => void;
}) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
  if (window.getSelection()?.isCollapsed === false) return;
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (!link) return;
  const citation = activePaper && pdf.pdfSource ? paperSourceCitation(activePaper, link.href, link.title) : null;
  const elsewhere = citation ? null : findPaperSource(papers, link.href, link.title);
  if (!citation && !(elsewhere && onOpenPaperSource)) return;
  event.preventDefault();
  event.stopPropagation();
  if (citation) pdf.openPdf({ ...citation, id: crypto.randomUUID() });
  else onOpenPaperSource?.(elsewhere!.paper, elsewhere!.citation);
}
