import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BookOpen,
  Check,
  ExternalLink,
  LoaderCircle,
  Quote,
  Search,
  X,
} from "lucide-react";

/** Versionless arXiv id, mirroring Rust `papers::arxiv_base_id`. */
export function baseArxivId(id: string): string {
  const match = /^(.*?)v\d+$/.exec(id.trim());
  return match ? match[1] : id.trim();
}

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

function hitMeta(work: LiteratureHit): string {
  if (work.source === "alphaxiv") {
    return [work.year ? String(work.year) : null, work.votes != null ? `▲ ${work.votes}` : null]
      .filter(Boolean)
      .join(" · ");
  }
  return [
    work.authors.slice(0, 3).join(", ") + (work.authors.length > 3 ? " et al." : ""),
    work.year ? String(work.year) : null,
    work.citedByCount != null ? `${work.citedByCount} cites` : null,
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
      if (!hits.length) setNotice("No hits. Try broader terms or turn off precise mode.");
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
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const nextPage = pageRef.current + 1;
    try {
      const page = await invoke<LiteraturePage>("search_literature", {
        query: query.trim(),
        precise,
        page: nextPage,
      });
      pageRef.current = nextPage;
      const fresh = dedupeFresh(page.hits);
      setResults((current) => [...current, ...fresh]);
      setHasMore(page.hasMore);
      setVisible((current) => current + REVEAL_STEP);
    } catch (reason) {
      setError(message(reason));
      setHasMore(false);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside
        className="history-drawer literature-drawer"
        onMouseDown={(event) => event.stopPropagation()}
        onScroll={(event) => {
          const el = event.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_THRESHOLD_PX) void loadMore();
        }}
      >
        <div className="drawer-header">
          <div><Search size={16} /><span>Discover literature</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
        <p className="drawer-copy">
          alphaXiv full-text first, then OpenAlex citations (arXiv-only). Import an arXiv snapshot only when you intend to cite it; until then these hits stay outside project evidence.
        </p>
        <form
          className="literature-search"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <input
            type="search"
            placeholder="Attention Is All You Need, diffusion, …"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoFocus
          />
          <label className="literature-precise">
            <input
              type="checkbox"
              checked={precise}
              onChange={(event) => setPrecise(event.target.checked)}
            />
            Title/abstract only
          </label>
          <button type="submit" disabled={loading || !query.trim()}>
            {loading ? <LoaderCircle className="spin" size={14} /> : <Search size={14} />}
            Search
          </button>
        </form>
        {error ? <p className="history-diff-error">{error}</p> : null}
        {notice ? <p className="git-notice">{notice}</p> : null}
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
                <p>{hitMeta(work)}</p>
                {work.snippet ? <p className="lit-snippet">{work.snippet}</p> : null}
                <div className="literature-result-ids">
                  {work.arxivId ? <em>arXiv:{work.arxivId}</em> : null}
                  {work.doi ? <em>{work.doi}</em> : null}
                </div>
              </div>
              <div className="literature-result-actions">
                {work.arxivId ? (
                  isImported(work.arxivId) ? (
                    <span className="lit-imported" title="Already in Papers">
                      <Check size={13} /> Imported
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={busyId === key}
                      title="Import arXiv snapshot + bibliography entry"
                      onClick={() => {
                        setBusyId(key);
                        setError("");
                        Promise.resolve(props.onImportArxiv(work.arxivId!))
                          .then(() => {
                            setNotice(`Imported arXiv:${work.arxivId}`);
                            setJustImported((current) => new Set(current).add(baseArxivId(work.arxivId!)));
                          })
                          .catch((reason) => setError(message(reason)))
                          .finally(() => setBusyId(null));
                      }}
                    >
                      {busyId === key ? <LoaderCircle className="spin" size={13} /> : <BookOpen size={13} />}
                      Import
                    </button>
                  )
                ) : null}
                <button
                  type="button"
                  title="Resolve into bibliography entry"
                  onClick={() => props.onAddBib(work.doi || work.title)}
                >
                  <Quote size={13} /> Bib
                </button>
                {work.landingUrl || work.doi ? (
                  <a
                    href={work.landingUrl || `https://doi.org/${work.doi}`}
                    target="_blank"
                    rel="noreferrer"
                    title="Open landing page"
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
              {loadingMore ? <LoaderCircle className="spin" size={13} /> : null}
              {loadingMore ? "Loading…" : "Load more"}
            </button>
          )}
          {!loading && !results.length && !error && !notice && (
            <p className="empty-history">Search alphaXiv and OpenAlex to find related work before importing evidence.</p>
          )}
        </div>
      </aside>
    </div>
  );
}
