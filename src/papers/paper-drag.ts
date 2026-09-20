import type { PaperSummary } from "../app-types";
import { paperLinkHref } from "./paper-link";

export const PAPER_DRAG_TYPE = "application/x-lattice-paper";
const PAPER_DRAG_URI = "lattice-paper:";
export type PaperDrag = { projectRoot: string; arxivId: string; citationKey?: string };

export function beginPaperDrag(data: DataTransfer, projectRoot: string, paper: PaperSummary) {
  data.effectAllowed = "copy";
  const payload = JSON.stringify({ projectRoot, arxivId: paper.arxivId, citationKey: paper.citationKey });
  data.setData(PAPER_DRAG_TYPE, payload);
  // Standard URI data survives native transfers between WebKit and Chromium,
  // which need not preserve one another's custom MIME representations.
  data.setData("text/uri-list", PAPER_DRAG_URI + encodeURIComponent(payload));
  data.setData("text/plain", paper.citationKey ? `@${paper.citationKey}` : paper.title);
}

export function hasPaperDrag(data: DataTransfer | null): boolean {
  return Boolean(data && (Array.from(data.types).includes(PAPER_DRAG_TYPE)
    || (Array.from(data.types).includes("text/uri-list") && data.getData("text/uri-list").startsWith(PAPER_DRAG_URI))));
}

/** Resolve against today's library, never trust metadata from another project/window. */
export function resolvePaperDrag(data: DataTransfer | null, projectRoot: string, papers: readonly PaperSummary[]): PaperSummary | undefined {
  try {
    const uri = data?.getData("text/uri-list") ?? "";
    const payload = data?.getData(PAPER_DRAG_TYPE)
      || (uri.startsWith(PAPER_DRAG_URI) ? decodeURIComponent(uri.slice(PAPER_DRAG_URI.length)) : "");
    const value: PaperDrag = JSON.parse(payload);
    if (!value || value.projectRoot !== projectRoot) return;
    return papers.find((paper) => paper.arxivId === value.arxivId && paper.citationKey === value.citationKey);
  } catch { return; }
}

export function paperCitationLabel(paper: PaperSummary): string {
  return `@${paper.citationKey || paper.title}`;
}

export function paperMarkdownCitation(path: string, paper: PaperSummary): string {
  const label = paperCitationLabel(paper).replace(/[\\[\]*_`]/g, "\\$&");
  return paper.arxivId && (paper.hasFullText || paper.hasBlog)
    ? `[${label}](${paperLinkHref(path, paper)})`
    : label;
}
