import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BookOpen,
  Check,
  ExternalLink,
  Quote,
  Search,
} from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { baseArxivId } from "./arxiv-id";
import { CheckboxField } from "../components/ui/checkbox-field";
import { InlineMessage } from "../components/ui/inline-message";
import { notifySuccess } from "../telemetry/app-notify";
import { InfinityLoader } from "../components/ui/activity-icons";
import { EmptyState } from "../components/ui/empty-state";
import { PanelHeader } from "../components/ui/panel-header";
import { SearchField } from "../components/ui/search-field";
import { ResizableDrawer } from "../components/ui/resizable-drawer";

/** Notification source label for literature discovery. */
const LITERATURE_SOURCE = "Literature";

export { baseArxivId };

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

// Show a small first batch and reveal more as the user scrolls; fetch deeper
// backend pages only once the already-loaded ones are exhausted.
const INITIAL_VISIBLE = 10;
const REVEAL_STEP = 10;
const SCROLL_THRESHOLD_PX = 160;

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** Identity across pages/sources, so the same paper is shown once. */
function dedupKey(work: LiteratureHit): string {
  return work.arxivId ? baseArxivId(work.arxivId) : work.doi ?? work.title;
}

function hitKey(work: LiteratureHit): string {
  return `${work.source}:${work.arxivId ?? work.doi ?? work.title}`;
}

/**
 * The byline under a result. The two prose fragments are passed in rather than
 * translated here: this runs per row, outside any component, so it has no
 * access to the active catalog of its own.
 */
function hitMeta(work: LiteratureHit, prose: { etAl: string; cites: string }): string {
  if (work.source === "alphaxiv") {
    return [work.year ? String(work.year) : null, work.votes != null ? `▲ ${work.votes}` : null]
      .filter(Boolean)
      .join(" · ");
  }
  return [
    work.authors.slice(0, 3).join(", ") + (work.authors.length > 3 ? prose.etAl : ""),
    work.year ? String(work.year) : null,
    work.citedByCount != null ? prose.cites : null,
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
   * The query and mode the results on screen actually came from.
   *
   * "Load more" read the live box instead, so typing a new query without
   * pressing Search — or toggling precise mode — and then scrolling to the
   * bottom appended page 2 of the *new* search underneath the old results,
   * with no separator and nothing said. Two literatures, one list.
   */
  const searchedRef = useRef<{ query: string; precise: boolean } | null>(null);
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
    searchedRef.current = { query: trimmed, precise };
    try {
      const page = await invoke<LiteraturePage>("search_literature", {
        query: trimmed,
        precise,
        page: 0,
      });
      const hits = dedupeFresh(page.hits);
      setResults(hits);
      setVisible(INITIAL_VISIBLE);
      setHasMore(page.hasMore);
      if (!hits.length) setNotice(t`No hits. Try broader terms or turn off precise mode.`);
    } catch (reason) {
      setResults([]);
      setHasMore(false);
      setError(message(reason));
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
      const page = await invoke<LiteraturePage>("search_literature", {
        query: searched.query,
        precise: searched.precise,
        page: nextPage,
      });
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
      setError(message(reason));
      setHasMore(false);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
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
        <PanelHeader
          className="drawer-header"
          icon={<Search size={16} />}
          title={t`Discover literature`}
          onClose={props.onClose}
        />
        <form
          className="literature-search"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <SearchField
            aria-label={t`Search literature`}
            placeholder={t`Attention Is All You Need, diffusion, …`}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onClear={() => setQuery("")}
            autoFocus
            showIcon={false}
          />
          <CheckboxField
            className="literature-precise"
            checked={precise}
            label={t`Title/abstract only`}
            onChange={(event) => setPrecise(event.target.checked)}
          />
          <button type="submit" disabled={loading || !query.trim()}>
            {loading ? <InfinityLoader size={14} /> : <Search size={14} />}
            {t`Search`}
          </button>
        </form>
        {error ? <InlineMessage level="error">{error}</InlineMessage> : null}
        {notice ? <InlineMessage level="info">{notice}</InlineMessage> : null}
        <div className="literature-results">
          {results.slice(0, visible).map((work) => {
            const key = hitKey(work);
            return (
            <article className="literature-result" key={key}>
              <div className="literature-result-body">
                <span className={`lit-source lit-source-${work.source}`}>
                  {work.source === "alphaxiv" ? "alphaXiv" : "OpenAlex"}
                </span>
                <strong>{work.title}</strong>
                <p>{hitMeta(work, {
                  etAl: t` et al.`,
                  cites: t`${work.citedByCount} cites`,
                })}</p>
                {work.snippet ? <p className="lit-snippet">{work.snippet}</p> : null}
                <div className="literature-result-ids">
                  {work.arxivId ? <em>arXiv:{work.arxivId}</em> : null}
                  {work.doi ? <em>{work.doi}</em> : null}
                </div>
              </div>
              <div className="literature-result-actions">
                {work.arxivId ? (
                  isImported(work.arxivId) ? (
                    <span className="lit-imported" title={t`Already in Papers`}>
                      <Check size={13} /> {t`Imported`}
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === key}
                      title={t`Add bibliography entry and cache the arXiv paper`}
                      onClick={() => {
                        setBusyId(key);
                        setError("");
                        Promise.resolve(props.onImportArxiv(work.arxivId!))
                          .then(() => {
                            notifySuccess(LITERATURE_SOURCE, t`Imported arXiv:${work.arxivId}`);
                            setJustImported((current) => new Set(current).add(baseArxivId(work.arxivId!)));
                          })
                          .catch((reason) => setError(message(reason)))
                          .finally(() => setBusyId(null));
                      }}
                    >
                      {busyId === key ? <InfinityLoader size={13} /> : <BookOpen size={13} />}
                      {t`Add`}
                    </button>
                  )
                ) : null}
                <button
                  type="button"
                  title={t`Resolve into bibliography entry`}
                  onClick={() => props.onAddBib(work.doi || work.title)}
                >
                  <Quote size={13} /> {t`Bib`}
                </button>
                {work.landingUrl || work.doi ? (
                  <a
                    href={work.landingUrl || `https://doi.org/${work.doi}`}
                    target="_blank"
                    rel="noreferrer"
                    title={t`Open landing page`}
                  >
                    <ExternalLink size={13} />
                  </a>
                ) : null}
              </div>
            </article>
            );
          })}
          {(visible < results.length || hasMore) && (
            <button
              type="button"
              className="lit-load-more"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? <InfinityLoader size={13} /> : null}
              {loadingMore ? t`Loading…` : t`Load more`}
            </button>
          )}
          {!loading && !results.length && !error && !notice && (
            <EmptyState description={t`Search alphaXiv and OpenAlex to find related work before importing evidence`} />
          )}
        </div>
    </ResizableDrawer>
  );
}
