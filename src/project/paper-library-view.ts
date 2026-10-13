import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PaperSummary } from "../app-types";
import type { CitationInfo } from "../editor/latex/latex-text";
import { paperShortAuthors } from "../papers/paper-identity";
import { canDownloadPaper } from "../papers/paper-source";
import type { SymbolOccurrence } from "./references-panel";
import { citationHealthLabel } from "./citation-health";

/** "title" is the library's own order (by title), or best match first while searching. */
export type PaperSort = "title" | "year" | "author" | "venue" | "cited";
export type PaperFilter = "all" | "cited" | "uncited" | "fullText" | "flagged";
export type PaperGroup = "none" | "year" | "venue" | "state";
/** What a click on the row can open: the paper, a download of it, or nothing yet. */
export type PaperReadingState = "fullText" | "downloadable" | "citation";

export const readablePaper = (paper: PaperSummary) => paper.hasFullText || paper.hasBlog;

export function paperReadingState(paper: PaperSummary): PaperReadingState {
  return readablePaper(paper) ? "fullText" : canDownloadPaper(paper) ? "downloadable" : "citation";
}

/**
 * What the bibliography and the manuscript say about a paper beyond its own
 * record: the venue its entry names, and how often the manuscript cites it.
 * `uses` is null until the manuscript has been scanned (or when it cannot
 * be), so a paper is never called uncited on no evidence.
 */
export type PaperFacts = {
  venue: (paper: PaperSummary) => string;
  uses: (paper: PaperSummary) => number | null;
};

/**
 * How many times the manuscript cites each key (lowercased, as LaTeX's keys
 * are matched), rescanned when the project or its saved revision changes;
 * null until the first scan lands, or when it fails.
 */
function useCitationUses(projectKey: string, revision: unknown): ReadonlyMap<string, number> | null {
  const [scan, setScan] = useState<{ projectKey: string; counts: ReadonlyMap<string, number> | null } | null>(null);
  useEffect(() => {
    let disposed = false;
    invoke<SymbolOccurrence[]>("list_citation_usages")
      .then((list) => {
        const counts = new Map<string, number>();
        // `\nocite{*}` lists every entry without citing any of them.
        for (const { symbol } of Array.isArray(list) ? list : []) {
          if (symbol === "*") continue;
          const key = symbol.toLocaleLowerCase();
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        if (!disposed) setScan({ projectKey, counts });
      })
      .catch(() => {
        if (!disposed) setScan({ projectKey, counts: null });
      });
    return () => { disposed = true; };
  }, [projectKey, revision]);
  // Another project's counts are never shown while this one's scan runs.
  return scan?.projectKey === projectKey ? scan.counts : null;
}

export function usePaperFacts(
  projectKey: string,
  citations: readonly CitationInfo[] | undefined,
  usageRevision: unknown,
): PaperFacts {
  const uses = useCitationUses(projectKey, usageRevision);
  return useMemo(() => {
    const venues = new Map((citations ?? []).map((citation) => [citation.key, citation.venue.trim()]));
    return {
      venue: (paper) => (paper.citationKey && venues.get(paper.citationKey)) || "",
      uses: (paper) => uses && (paper.citationKey ? uses.get(paper.citationKey.toLocaleLowerCase()) ?? 0 : 0),
    };
  }, [citations, uses]);
}

export function paperFilter(filter: PaperFilter, facts: PaperFacts): (paper: PaperSummary) => boolean {
  switch (filter) {
    case "cited": return (paper) => (facts.uses(paper) ?? 0) > 0;
    case "uncited": return (paper) => facts.uses(paper) === 0;
    case "fullText": return readablePaper;
    case "flagged": return (paper) => Boolean(citationHealthLabel(paper.citationHealth));
    default: return () => true;
  }
}

/**
 * The chosen sort as a comparison, or none for the library's own order (by
 * title, best match first while searching). Text sorts run A to Z, the year
 * newest first and uses most first; a paper with no value goes last.
 */
export function paperOrder(sort: PaperSort, facts: PaperFacts): ((a: PaperSummary, b: PaperSummary) => number) | undefined {
  if (sort === "title") return undefined;
  if (sort === "cited") return (a, b) => (facts.uses(b) ?? 0) - (facts.uses(a) ?? 0);
  const key = (paper: PaperSummary) => (
    sort === "year" ? paper.year?.trim() : sort === "venue" ? facts.venue(paper) : paperShortAuthors(paper)
  ) || "";
  return (a, b) => {
    const [left, right] = [key(a), key(b)];
    return Number(!left) - Number(!right)
      || (sort === "year" ? right.localeCompare(left, undefined, { numeric: true }) : left.localeCompare(right));
  };
}

export type PaperGroupSection = { id: string; name: string; papers: PaperSummary[] };

const READING_ORDER: readonly PaperReadingState[] = ["fullText", "downloadable", "citation"];

/**
 * The shown papers in sections, each keeping the order it was given: years
 * newest first, venues A to Z, reading states from readable to cited only,
 * and the papers that record no year or venue last. `name` turns a group's
 * value into its heading; an empty value is the "none recorded" group.
 */
export function groupPapers(
  papers: readonly PaperSummary[],
  group: PaperGroup,
  facts: PaperFacts,
  name: (value: string) => string,
): PaperGroupSection[] {
  if (group === "none") return [{ id: "", name: "", papers: [...papers] }];
  const valueOf = (paper: PaperSummary) => (
    group === "year" ? paper.year?.trim() ?? "" : group === "venue" ? facts.venue(paper) : paperReadingState(paper)
  );
  const sections = new Map<string, PaperSummary[]>();
  for (const paper of papers) {
    const value = valueOf(paper);
    const members = sections.get(value);
    if (members) members.push(paper);
    else sections.set(value, [paper]);
  }
  const rank = (value: string) => (group === "state" ? READING_ORDER.indexOf(value as PaperReadingState) : 0);
  return [...sections].sort(([a], [b]) => (
    Number(!a) - Number(!b)
    || rank(a) - rank(b)
    || (group === "year" ? b.localeCompare(a, undefined, { numeric: true }) : a.localeCompare(b))
  )).map(([value, members]) => ({ id: value, name: name(value), papers: members }));
}
