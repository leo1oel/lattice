import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, Check, ExternalLink, Plus, Quote, Search } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { toMessage } from "../app-utils";
import { baseArxivId } from "./arxiv-id";
import { CheckboxField } from "../components/ui/checkbox-field";
import { InlineMessage } from "../components/ui/inline-message";
import { notifySuccess } from "../telemetry/app-notify";
import { InfinityLoader } from "../components/ui/activity-icons";
import { EmptyState } from "../components/ui/empty-state";
import { EmptyIllustration } from "../components/ui/empty-illustration";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";
import { PanelHeader } from "../components/ui/panel-header";
import { SearchField } from "../components/ui/search-field";
import { ResizableDrawer } from "../components/ui/resizable-drawer";

/** Notification source label for literature discovery. */
const LITERATURE_SOURCE = "Literature";

export type LiteratureHit = {
  source: "alphaxiv" | "openalex" | string;
  arxivId?: string | null;
  title: string;
  year?: number | null;
  authors: string[];
  citedByCount?: number | null;
  votes?: number | null;
  snippet?: string | null;
  doi?: string | null;
  landingUrl?: string | null;
};

type LiteraturePage = { hits: LiteratureHit[]; hasMore: boolean };
type LiteratureSearch = { query: string; precise: boolean };

function searchLiterature(search: LiteratureSearch, page: number): Promise<LiteraturePage> {
  return invoke<LiteraturePage>("search_literature", { ...search, page });
}

// Show a small first batch and reveal more as the user scrolls; fetch deeper
// backend pages only once the already-loaded ones are exhausted.
const INITIAL_VISIBLE = 10;
const REVEAL_STEP = 10;
const SCROLL_THRESHOLD_PX = 160;

/** Identity across pages/sources, so the same paper is shown once. */
function dedupKey(work: LiteratureHit): string {
  return work.arxivId ? baseArxivId(work.arxivId) : work.doi ?? work.title;
}

function hitKey(work: LiteratureHit): string {
  return `${work.source}:${work.arxivId ?? work.doi ?? work.title}`;
}

/**
 * The byline under a result: who and when, as a Papers row has it. The prose
 * fragment is passed in rather than translated here: this runs per row,
 * outside any component, so it has no access to the active catalog of its own.
 */
function hitByline(work: LiteratureHit, etAl: string): string[] {
  const authors = work.authors.slice(0, 2).join(", ") + (work.authors.length > 2 ? etAl : "");
  return [authors, work.year ? String(work.year) : ""].filter(Boolean);
}

/**
 * What a result's tooltip adds: where it came from, how it ranks there
 * (alphaXiv votes, OpenAlex citations) and its identifier. The row itself
 * leaves these out, so a narrow panel keeps its width for the title.
 */
function hitDetails(work: LiteratureHit, prose: { votes: string; cites: string }): string {
  return [
    work.source === "alphaxiv" ? "alphaXiv" : "OpenAlex",
    work.votes != null ? prose.votes : work.citedByCount != null ? prose.cites : null,
    work.arxivId ? `arXiv:${work.arxivId}` : work.doi,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function LiteratureDiscoveryPanel(props: {
  onClose: () => void;
  onImportArxiv: (arxivId: string) => Promise<void> | void;
  onAddBib: (query: string) => void;
  /** Versionless arXiv ids already in the library, shown as done. */
  importedIds: Set<string>;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [precise, setPrecise] = useState(true);
  const [results, setResults] = useState<LiteratureHit[]>([]);
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [justImported, setJustImported] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pageRef = useRef(0);
  /**
   * The query and mode the results on screen came from. "Load more" pages
   * this search, never the live box: an edited but unsubmitted query would
   * otherwise append another search's page 2 under these results.
   */
  const searchedRef = useRef<LiteratureSearch | null>(null);
  const seenRef = useRef(new Set<string>());
  const loadingMoreRef = useRef(false);

  const isImported = (arxivId?: string | null): boolean => {
    if (!arxivId) return false;
    const base = baseArxivId(arxivId);
    return props.importedIds.has(base) || justImported.has(base);
  };

  const dedupeFresh = (hits: LiteratureHit[]): LiteratureHit[] =>
    hits.filter((hit) => {
      const key = dedupKey(hit);
      if (seenRef.current.has(key)) return false;
      seenRef.current.add(key);
      return true;
    });

  const search = async () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    setNotice("");
    pageRef.current = 0;
    seenRef.current = new Set();
    const searched = { query: trimmed, precise };
    searchedRef.current = searched;
    try {
      const page = await searchLiterature(searched, 0);
      const hits = dedupeFresh(page.hits);
      setResults(hits);
      setVisible(INITIAL_VISIBLE);
      setHasMore(page.hasMore);
      if (!hits.length) setNotice(t`No hits. Try broader terms or turn off precise mode.`);
    } catch (reason) {
      setResults([]);
      setHasMore(false);
      setError(toMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    // Reveal already-fetched results first; only hit the network when they run out.
    if (visible < results.length) {
      setVisible((current) => Math.min(current + REVEAL_STEP, results.length));
      return;
    }
    if (!hasMore || loadingMoreRef.current) return;
    const searched = searchedRef.current;
    if (!searched) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const nextPage = pageRef.current + 1;
    try {
      const page = await searchLiterature(searched, nextPage);
      // A new search may have started while this page was in flight; its
      // results, paging, and seen-set belong to the old query — drop them.
      if (searchedRef.current !== searched) return;
      pageRef.current = nextPage;
      const fresh = dedupeFresh(page.hits);
      setResults((current) => [...current, ...fresh]);
      setHasMore(page.hasMore);
      setVisible((current) => current + REVEAL_STEP);
    } catch (reason) {
      if (searchedRef.current !== searched) return;
      setError(toMessage(reason));
      setHasMore(false);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  const importArxiv = (work: LiteratureHit, key: string) => {
    setBusyId(key);
    setError("");
    Promise.resolve(props.onImportArxiv(work.arxivId!))
      .then(() => {
        notifySuccess(LITERATURE_SOURCE, t`Imported arXiv:${work.arxivId}`);
        setJustImported((current) => new Set(current).add(baseArxivId(work.arxivId!)));
      })
      .catch((reason) => setError(toMessage(reason)))
      .finally(() => setBusyId(null));
  };

  return (
    <ResizableDrawer
      className="literature-drawer"
      onClose={props.onClose}
      onScroll={(event) => {
        const el = event.currentTarget;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD_PX) void loadMore();
      }}
    >
      <PanelHeader className="drawer-header" icon={<Search size={16} />} title={t`Discover literature`} onClose={props.onClose} />
      <form
        className="literature-search"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <SearchField
          aria-label={t`Search literature`}
          aria-busy={loading}
          controlSize="compact"
          placeholder={t`Attention Is All You Need, diffusion, …`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
          autoFocus
          trailing={(
            <button type="submit" className="literature-search-submit" disabled={loading || !query.trim()} title={t`Search`} aria-label={t`Search`}>
              {loading ? <InfinityLoader size={14} /> : <ArrowRight size={14} />}
            </button>
          )}
        />
        <CheckboxField
          className="literature-precise"
          checked={precise}
          label={t`Title/abstract only`}
          onChange={(event) => setPrecise(event.target.checked)}
        />
      </form>
      {error ? <InlineMessage level="error">{error}</InlineMessage> : null}
      {notice ? <InlineMessage level="info">{notice}</InlineMessage> : null}
      <div role="list" aria-label={t`Results`} className="literature-results fluid-hover-surface">
        <FluidHoverSurface selector=".literature-result" follow={null} />
        {results.slice(0, visible).map((work) => {
          const key = hitKey(work);
          const imported = isImported(work.arxivId);
          const details = hitDetails(work, {
            votes: t`${work.votes} votes`,
            cites: t`${work.citedByCount} cites`,
          });
          const byline = hitByline(work, t` et al.`);
          const landing = work.landingUrl || (work.doi ? `https://doi.org/${work.doi}` : null);
          return (
            <div role="listitem" className="literature-result" key={key} title={details}>
              <strong className="literature-title">{work.title}</strong>
              {/* Like a Papers row: the byline at rest; hovered or focused, the
                  actions come in over its end, so they never take the title's
                  width or change the row's height. */}
              <div className="literature-meta">
                <small className="literature-byline">
                  {byline.map((part, index) => <span key={index}>{part}</span>)}
                  {imported && (
                    <span className="literature-imported" role="img" title={t`Already in Papers`} aria-label={t`Already in Papers`}>
                      <Check size={12} aria-hidden="true" />
                    </span>
                  )}
                </small>
                <div className="literature-result-actions">
                  {work.arxivId && !imported && (
                    <button
                      type="button"
                      disabled={busyId === key}
                      title={t`Add bibliography entry and cache the arXiv paper`}
                      aria-label={t({ message: `Add ${{ title: work.title }} to Papers` })}
                      onClick={() => importArxiv(work, key)}
                    >
                      {busyId === key ? <InfinityLoader size={12} /> : <Plus size={13} />}
                    </button>
                  )}
                  <button
                    type="button"
                    title={t`Resolve into bibliography entry`}
                    aria-label={t({ message: `Add a bibliography entry for ${{ title: work.title }}` })}
                    onClick={() => props.onAddBib(work.doi || work.title)}
                  >
                    <Quote size={12} />
                  </button>
                  {landing && (
                    <a href={landing} target="_blank" rel="noreferrer" title={t`Open landing page`} aria-label={t`Open landing page`}>
                      <ExternalLink size={12} />
                    </a>
                  )}
                </div>
              </div>
              {work.snippet ? <p className="literature-snippet">{work.snippet}</p> : null}
              <span className="sr-only">{details}</span>
            </div>
          );
        })}
      </div>
      {(visible < results.length || hasMore) && (
        <button type="button" className="lit-load-more" disabled={loadingMore} onClick={() => void loadMore()}>
          {loadingMore ? <InfinityLoader size={13} /> : null}
          {loadingMore ? t`Loading…` : t`Load more`}
        </button>
      )}
      {!loading && !results.length && !error && !notice && (
        <EmptyState icon={<EmptyIllustration kind="papers" />} description={t`Search alphaXiv and OpenAlex for related work`} />
      )}
    </ResizableDrawer>
  );
}
