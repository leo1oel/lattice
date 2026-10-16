import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { paperKey, toMessage } from "../app-utils";
import type { PaperSummary } from "../app-types";
import { baseArxivId } from "../papers/arxiv-id";

type PaperLibrarySearchHit = {
  arxivId?: string | null;
  title: string;
  snippet: string;
};

export type RecentPaperImport = { query: string; citationKey?: string; arxivId: string };

export function paperSearchIdentity(paper: { arxivId?: string | null; title: string }): string {
  return paper.arxivId || `title:${paper.title.trim().toLocaleLowerCase()}`;
}

/**
 * Every token must occur somewhere in the paper's local library metadata.
 * arXiv URLs and versioned IDs reduce to the versionless ID stored by imports.
 */
function filterPapers(papers: readonly PaperSummary[], query: string): PaperSummary[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean).map((token) => {
    const arxivId = /\b(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[a-z]{2})?\/\d{7}(?:v\d+)?)\b/i
      .exec(token)?.[1];
    if (arxivId) return baseArxivId(arxivId);
    // A pasted DOI URL and the normalized DOI stored in the bibliography are
    // the same identifier even though neither string contains the other.
    return token.replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "").replace(/^doi:\s*/, "");
  });
  if (!tokens.length) return [...papers];
  return papers.filter((paper) => {
    // Author braces only group names ("{V}aswani"); a query never types them.
    const haystack = [paper.title, paper.authors?.replace(/[{}]/g, ""), paper.citationKey, paper.arxivId, paper.doi, paper.url]
      .filter(Boolean).join(" ").toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/**
 * Metadata matches, full-text matches, and the just-confirmed import, with the
 * import first and title matches ahead of the rest; ties keep library order.
 * An `order` (a sort the writer chose) replaces the title-match ranking; the
 * import still leads.
 */
export function rankPapers(
  papers: readonly PaperSummary[],
  input: string,
  textHits: ReadonlyMap<string, PaperLibrarySearchHit>,
  recentImport: RecentPaperImport | null | undefined,
  order?: (a: PaperSummary, b: PaperSummary) => number,
): PaperSummary[] {
  const query = input.trim();
  const metadataMatches = new Set(filterPapers(papers, input).map(paperKey));
  const isRecent = (paper: PaperSummary) => Boolean(recentImport?.query === query && (
    recentImport.citationKey ? recentImport.citationKey === paper.citationKey
      : recentImport.arxivId && baseArxivId(recentImport.arxivId) === baseArxivId(paper.arxivId)
  ));
  const lowered = query.toLocaleLowerCase();
  const relevance = (paper: PaperSummary) => {
    const title = paper.title.trim().toLocaleLowerCase();
    if (title === lowered) return 4;
    if (title.startsWith(lowered)) return 3;
    if (title.includes(lowered)) return 2;
    return metadataMatches.has(paperKey(paper)) ? 1 : 0;
  };
  return papers.map((paper, index) => ({ paper, index }))
    .filter(({ paper }) => (
      metadataMatches.has(paperKey(paper)) || textHits.has(paperSearchIdentity(paper)) || isRecent(paper)
    ))
    .sort((a, b) => Number(isRecent(b.paper)) - Number(isRecent(a.paper))
      || (order ? order(a.paper, b.paper) : relevance(b.paper) - relevance(a.paper))
      || a.index - b.index)
    .map(({ paper }) => paper);
}

/**
 * How far the full-text pass has got with the current query. "pending" has
 * not had long enough to be worth saying; "searching" has, so the list says
 * its saved-text half is still to come; "failed" means the list holds
 * metadata matches only. Only "done" (or "idle", no query) is a final answer.
 */
export type PaperTextSearchStatus = "idle" | "pending" | "searching" | "failed" | "done";

/** A full-text pass this long under way is said to be under way: a quicker one never shows its status. */
const SEARCHING_NOTICE_MS = 400;

type SettledSearch = { query: string; attempt: number; hits: PaperLibrarySearchHit[]; error?: string };

/**
 * Debounced full-text search over the local paper cache, keyed by paper
 * identity (first hit wins). Hits for an older query are never returned.
 * `searchNow` skips the debounce for the current query (Enter in the box);
 * `retry` runs a failed search again.
 */
export function usePaperTextSearch(query: string): {
  hits: ReadonlyMap<string, PaperLibrarySearchHit>;
  status: PaperTextSearchStatus;
  error?: string;
  searchNow: () => void;
  retry: () => void;
} {
  const [settled, setSettled] = useState<SettledSearch>({ query: "", attempt: 0, hits: [] });
  // A retry is a new attempt at the same query, so its result is told apart from the failure it replaces.
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState<{ query: string; attempt: number } | null>(null);
  const runNow = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!query) return;
    let disposed = false;
    let started = false;
    const run = () => {
      if (started) return;
      started = true;
      window.clearTimeout(timer);
      void invoke<PaperLibrarySearchHit[]>("search_paper_library", { query })
        .then((hits) => {
          if (!disposed) setSettled({ query, attempt, hits: Array.isArray(hits) ? hits : [] });
        })
        .catch((reason: unknown) => {
          // Metadata filtering remains useful if the cache cannot be read,
          // but the list must not read as the whole answer.
          if (!disposed) setSettled({ query, attempt, hits: [], error: toMessage(reason) });
        });
    };
    const timer = window.setTimeout(run, 120);
    const notice = window.setTimeout(() => setSlow({ query, attempt }), SEARCHING_NOTICE_MS);
    runNow.current = run;
    return () => {
      disposed = true;
      runNow.current = null;
      window.clearTimeout(timer);
      window.clearTimeout(notice);
    };
  }, [query, attempt]);
  const searchNow = useCallback(() => runNow.current?.(), []);
  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
    // Said at once: the writer asked, so the failure gives way to the search it asked for.
    setSlow({ query, attempt: attempt + 1 });
  }, [query, attempt]);
  const current = settled.query === query;
  const hits = useMemo(() => {
    const firstHit = new Map<string, PaperLibrarySearchHit>();
    for (const hit of current ? settled.hits : []) {
      const identity = paperSearchIdentity(hit);
      if (!firstHit.has(identity)) firstHit.set(identity, hit);
    }
    return firstHit;
  }, [current, settled.hits]);
  let status: PaperTextSearchStatus;
  if (!query) status = "idle";
  else if (current && settled.attempt === attempt) status = settled.error === undefined ? "done" : "failed";
  else if (slow?.query === query && slow.attempt === attempt) status = "searching";
  // A cache that could not be read for the last query most likely cannot for
  // this one either: the failure stays until this search says otherwise,
  // rather than blinking out at every keystroke.
  else if (settled.error !== undefined && settled.attempt === attempt) status = "failed";
  else status = "pending";
  return { hits, status, error: status === "failed" ? settled.error : undefined, searchNow, retry };
}
