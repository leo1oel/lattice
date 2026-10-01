import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { paperKey } from "../app-utils";
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
    const haystack = [paper.title, paper.authors, paper.citationKey, paper.arxivId, paper.doi, paper.url]
      .filter(Boolean).join(" ").toLocaleLowerCase();
    return tokens.every((token) => haystack.includes(token));
  });
}

/**
 * Metadata matches, full-text matches, and the just-confirmed import, with the
 * import first and title matches ahead of the rest; ties keep library order.
 */
export function rankPapers(
  papers: readonly PaperSummary[],
  input: string,
  textHits: ReadonlyMap<string, PaperLibrarySearchHit>,
  recentImport: RecentPaperImport | null | undefined,
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
      || relevance(b.paper) - relevance(a.paper)
      || a.index - b.index)
    .map(({ paper }) => paper);
}

/**
 * Debounced full-text search over the local paper cache, keyed by paper
 * identity (first hit wins). Hits for an older query are never returned.
 * `searchNow` skips the debounce for the current query (Enter in the box).
 */
export function usePaperTextSearch(query: string, enabled: boolean): {
  hits: ReadonlyMap<string, PaperLibrarySearchHit>;
  searchNow: () => void;
} {
  const [search, setSearch] = useState<{ query: string; hits: PaperLibrarySearchHit[] }>({ query: "", hits: [] });
  const runNow = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!enabled || !query) return;
    let disposed = false;
    let started = false;
    const run = () => {
      if (started) return;
      started = true;
      window.clearTimeout(timer);
      void invoke<PaperLibrarySearchHit[]>("search_paper_library", { query })
        .then((hits) => {
          if (!disposed) setSearch({ query, hits: Array.isArray(hits) ? hits : [] });
        })
        .catch(() => {
          // Metadata filtering remains useful if the cache cannot be read.
          if (!disposed) setSearch({ query, hits: [] });
        });
    };
    const timer = window.setTimeout(run, 120);
    runNow.current = run;
    return () => {
      disposed = true;
      runNow.current = null;
      window.clearTimeout(timer);
    };
  }, [enabled, query]);
  const searchNow = useCallback(() => runNow.current?.(), []);
  const hits = useMemo(() => {
    const firstHit = new Map<string, PaperLibrarySearchHit>();
    for (const hit of search.query === query ? search.hits : []) {
      const identity = paperSearchIdentity(hit);
      if (!firstHit.has(identity)) firstHit.set(identity, hit);
    }
    return firstHit;
  }, [search, query]);
  return { hits, searchNow };
}
