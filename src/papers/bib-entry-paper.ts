/**
 * The paper a .bib reference stands for, and what opening it from the
 * reference list does (EntryPaperAction): read the text the library holds,
 * or, when the library has none yet but the entry names a source (an arXiv
 * id, a web address), download it first. The download is the Papers panel's
 * own (usePaperActions' fetchAndOpenPaper, behind the host's `onOpenPaper`):
 * its progress is that panel's fetch state, and a failure is its error.
 */
import type { PaperSummary } from "../app-types";
import { paperKey } from "../app-utils";
import type { PaperFetchState } from "../project/paper-row";
import type { BibSummary } from "./bib-document";
import { canDownloadPaper } from "./paper-source";
import { sameIgnoringCase } from "../lib/equality";

/** What a reference's open control offers: read it, download and read it, wait for it, or nothing to fetch. */
export type EntryPaperState = "open" | "download" | "downloading" | "none";

export type EntryPaper = { paper: PaperSummary | null; state: EntryPaperState };

export type PaperFetchStates = Readonly<Record<string, PaperFetchState>>;

/**
 * The library's paper for the entry `key` (by citation key, else by arXiv
 * id or web address, as the library lists another .bib's downloaded
 * reference), else, for a reference of another .bib not downloaded yet, one
 * made from the entry itself, which the fetch takes as it takes a
 * citation-only row: by arXiv id or by web address.
 */
export function entryPaper(
  papers: readonly PaperSummary[],
  key: string,
  summary: BibSummary,
  fetchStates: PaperFetchStates | undefined,
): EntryPaper {
  const paper = papers.find((item) => sameIgnoringCase(item.citationKey, key))
    ?? (summary.arxivId ? papers.find((item) => item.arxivId === summary.arxivId) : undefined)
    ?? (summary.url ? papers.find((item) => item.url === summary.url) : undefined)
    ?? (summary.arxivId || summary.url ? {
      arxivId: summary.arxivId, doi: summary.doi || undefined, url: summary.url || undefined, title: summary.title || key,
      year: summary.year || undefined, citationKey: key, hasFullText: false, hasBlog: false,
    } : null);
  if (!paper) return { paper: null, state: "none" };
  if (fetchStates?.[paperKey(paper)] === "loading") return { paper, state: "downloading" };
  // As the Papers list reads a row (paperReadingState): its text, else a source to fetch.
  return { paper, state: paper.hasFullText || paper.hasBlog ? "open" : canDownloadPaper(paper) ? "download" : "none" };
}
