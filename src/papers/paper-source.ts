import type { PaperSummary } from "../app-types";
import { explicitArxivId } from "./arxiv-id";

export function isTitleQuery(input: string): boolean {
  const query = input.trim();
  return Boolean(query) && !explicitArxivId(query)
    && !/^(?:https?:\/\/|(?:doi:\s*)?10\.\d{4,9}\/|arxiv:|@)/i.test(query);
}

/** DOI metadata identifies a work, not a downloadable full-text page. */
export function canDownloadPaper(paper: PaperSummary): boolean {
  if (paper.arxivId) return true;
  if (!paper.url) return false;
  try {
    const url = new URL(paper.url);
    if (!/^https?:$/.test(url.protocol)) return false;
    if (/^(?:dx\.)?doi\.org$/i.test(url.hostname)) return false;
    return /\.pdf$/i.test(url.pathname) || !paper.doi;
  } catch {
    return false;
  }
}
