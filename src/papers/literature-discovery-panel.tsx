import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, Check, ChevronDown, ExternalLink, Plus, Quote, Search } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { toMessage } from "../app-utils";
import { formatCount } from "../i18n";
import { baseArxivId } from "./arxiv-id";
import { Button } from "../components/ui/button";
import { buttonClassName } from "../components/ui/button-styles";
import { CheckboxField } from "../components/ui/checkbox-field";
import { InlineMessage } from "../components/ui/inline-message";
import { notifySuccess } from "../telemetry/app-notify";
import { InfinityLoader } from "../components/ui/activity-icons";
import { EmptyState } from "../components/ui/empty-state";
import { ResearchArt } from "../components/ui/research-art";
import { READING_FOLIO } from "../components/ui/research-art-reading-folio";
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
  /** alphaXiv: the full-text passage that matched. */
  snippet?: string | null;
  /** OpenAlex: the work's abstract, for the preview. */
  abstract?: string | null;
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
 * The byline under a result: who and when, as a Papers row has it. alphaXiv
 * names no authors, so its rows say which arXiv paper they are instead. The
 * prose fragment is passed in rather than translated here: this runs per row,
 * outside any component, so it has no access to the active catalog of its own.
 */
function hitByline(work: LiteratureHit, etAl: string): string[] {
  const authors = work.authors.length
    ? work.authors.slice(0, 2).join(", ") + (work.authors.length > 2 ? etAl : "")
    : work.arxivId ? `arXiv ${work.arxivId}` : "";
  return [authors, work.year ? String(work.year) : ""].filter(Boolean);
}

function sourceName(work: LiteratureHit): string {
  return work.source === "alphaxiv" ? "alphaXiv" : "OpenAlex";
}

/** Where a result came from and how it ranks there, in full ("9,214 cites"). */
function hitDetails(work: LiteratureHit, rank: string | null): string {
  return [sourceName(work), rank, work.arxivId ? `arXiv:${work.arxivId}` : work.doi]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The count at a row's end, short enough to sit beside the byline: "9.2K" as
 * Elicit and Matter print theirs. Chinese keeps whole numbers up to 9,999 and
 * then counts in 万 ("22.8 万"), with formatCount's space before the unit.
 */
function compactCount(value: number, locale: string): string {
  if (locale.startsWith("zh") && Math.abs(value) < 10_000) return formatCount(value, locale);
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 })
    .format(value)
    .replace(/(\d)(?=[万亿])/, "$1 ");
}

/** The page a result opens: its landing page, its DOI, or its arXiv abstract. */
function hitPage(work: LiteratureHit): string | null {
  if (work.landingUrl) return work.landingUrl;
  if (work.doi) return `https://doi.org/${work.doi}`;
  return work.arxivId ? `https://arxiv.org/abs/${work.arxivId}` : null;
}

export function LiteratureDiscoveryPanel(props: {
  /** A query handed over from the Papers box, searched as the panel opens. */
  initialQuery?: string;
  onClose: () => void;
  onImportArxiv: (arxivId: string) => Promise<void> | void;
  onAddBib: (query: string) => void;
  /** Versionless arXiv ids already in the library, shown as done. */
  importedIds: Set<string>;
}) {
  const { t, i18n } = useLingui();
  const previewId = useId();
  const [query, setQuery] = useState(props.initialQuery ?? "");
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
  /** The query the results on screen answer, for the line above them. */
  const [shownQuery, setShownQuery] = useState("");
  /** The result whose preview is open; one at a time, as Elicit's details pane. */
  const [openKey, setOpenKey] = useState<string | null>(null);
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
      setShownQuery(trimmed);
      setOpenKey(null);
      setVisible(INITIAL_VISIBLE);
      setHasMore(page.hasMore);
      if (!hits.length) setNotice(t`No hits. Try broader terms or turn off precise mode.`);
    } catch (reason) {
      setResults([]);
      setHasMore(false);
      setOpenKey(null);
      setError(toMessage(reason));
    } finally {
      setLoading(false);
    }
  };

  // A query handed over from the Papers box is searched once, as the panel opens.
  const searchOnOpenRef = useRef(Boolean(props.initialQuery?.trim()));
  useEffect(() => {
    if (!searchOnOpenRef.current) return;
    searchOnOpenRef.current = false;
    void search();
  });

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

  const count = formatCount(results.length, i18n.locale);
  const resultCount = hasMore
    ? t`${count}+ results for “${shownQuery}”`
    : results.length === 1 ? t`1 result for “${shownQuery}”` : t`${count} results for “${shownQuery}”`;

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
      {results.length > 0 && (
        // How many and from where, before the first row, as Elicit leads its table.
        <p className="literature-count">
          <span className="literature-count-query">{resultCount}</span>
          <span className="literature-count-sources">{[...new Set(results.map(sourceName))].join(" · ")}</span>
        </p>
      )}
      <div role="list" aria-label={t`Results`} className="literature-results fluid-hover-surface">
        <FluidHoverSurface selector=".literature-result" follow={null} />
        {results.slice(0, visible).map((work, index) => {
          const key = hitKey(work);
          const imported = isImported(work.arxivId);
          const busy = busyId === key;
          const expanded = openKey === key;
          const id = `${previewId}-${index}`;
          const votes = work.votes ?? null;
          const cites = work.votes == null ? work.citedByCount ?? null : null;
          // The row's signal is short ("9.2K cites"); the preview spells it out.
          const signal = votes != null
            ? votes === 1 ? t`1 vote` : t`${compactCount(votes, i18n.locale)} votes`
            : cites != null
              ? cites === 1 ? t`1 cite` : t`${compactCount(cites, i18n.locale)} cites`
              : null;
          const rank = votes != null
            ? votes === 1 ? t`1 vote` : t`${formatCount(votes, i18n.locale)} votes`
            : cites != null
              ? cites === 1 ? t`1 cite` : t`${formatCount(cites, i18n.locale)} cites`
              : null;
          const byline = hitByline(work, t` et al.`);
          const page = hitPage(work);
          const addToPapers = () => importArxiv(work, key);
          const citationOnly = () => props.onAddBib(work.doi || work.title);
          const inPapers = (
            <span className="literature-in">
              <Check size={12} aria-hidden="true" />
              {t`In Papers`}
            </span>
          );
          return (
            <div role="listitem" className="literature-result" data-expanded={expanded || undefined} key={key}>
              {/* The whole row opens its preview, as an Elicit result does: one
                  button beneath the row's text, so the title and byline stay
                  plain text to a screen reader and the actions sit above it. */}
              <button
                type="button"
                className="literature-open"
                aria-expanded={expanded}
                aria-controls={expanded ? id : undefined}
                aria-label={work.title}
                onClick={() => setOpenKey(expanded ? null : key)}
              />
              <strong className="literature-title">{work.title}</strong>
              {/* Like a Papers row: the byline and, at its end, how the work
                  ranks or that it is already in Papers. Hovered or focused, the
                  actions come in over the signal, so they never take the
                  title's width or change the row's height. Opened, the preview
                  holds them instead. */}
              <div className="literature-meta">
                <small className="literature-byline">
                  {byline.map((part, partIndex) => <span key={partIndex}>{part}</span>)}
                </small>
                {imported ? inPapers : signal ? <span className="literature-signal">{signal}</span> : null}
                {!imported && !expanded && (
                  <div className="literature-result-actions">
                    {work.arxivId && (
                      <button
                        type="button"
                        className="literature-add"
                        disabled={busy}
                        title={t`Add bibliography entry and cache the arXiv paper`}
                        aria-label={t({ message: `Add ${{ title: work.title }} to Papers` })}
                        onClick={addToPapers}
                      >
                        {busy ? <InfinityLoader size={12} /> : <Plus size={13} aria-hidden="true" />}
                        <span>{t`Add`}</span>
                      </button>
                    )}
                    <button
                      type="button"
                      title={t`Citation only: add the bibliography entry without the paper`}
                      aria-label={t({ message: `Add a bibliography entry for ${{ title: work.title }}` })}
                      onClick={citationOnly}
                    >
                      <Quote size={12} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
              {expanded ? (
                <div className="literature-preview" id={id}>
                  {work.abstract
                    ? <p className="literature-abstract">{work.abstract}</p>
                    : work.snippet
                      ? <p className="literature-passage">{work.snippet}</p>
                      : <p className="literature-abstract-none">{t`No abstract from this source`}</p>}
                  <dl className="literature-facts">
                    {work.authors.length > 0 && (
                      <div><dt>{t`Authors`}</dt><dd>{work.authors.join(", ")}</dd></div>
                    )}
                    <div><dt>{t({ message: "Source", context: "where a literature result came from" })}</dt><dd>{[sourceName(work), rank].filter(Boolean).join(" · ")}</dd></div>
                    {work.arxivId
                      ? <div><dt>arXiv</dt><dd>{work.arxivId}</dd></div>
                      : work.doi ? <div><dt>DOI</dt><dd>{work.doi}</dd></div> : null}
                  </dl>
                  <div className="literature-preview-actions">
                    {imported ? inPapers : work.arxivId ? (
                      <Button variant="tinted" size="compact" disabled={busy} onClick={addToPapers}>
                        {busy ? <InfinityLoader size={12} /> : <Plus size={13} aria-hidden="true" />}
                        {t`Add to Papers`}
                      </Button>
                    ) : null}
                    <Button variant="secondary" size="compact" onClick={citationOnly}>
                      <Quote size={12} aria-hidden="true" />
                      {t({ message: "Citation only", context: "add a literature result as a bibliography entry only" })}
                    </Button>
                    {page && (
                      <a className={buttonClassName({ variant: "secondary", size: "compact" })} data-slot="button" href={page} target="_blank" rel="noreferrer">
                        <ExternalLink size={12} aria-hidden="true" />
                        {t`Open page`}
                      </a>
                    )}
                  </div>
                </div>
              ) : work.snippet ? <p className="literature-snippet">{work.snippet}</p> : null}
              <ChevronDown size={12} className="literature-chevron" aria-hidden="true" />
              <span className="sr-only">{hitDetails(work, rank)}</span>
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
        <EmptyState
          className="literature-empty"
          fill
          icon={<ResearchArt drawing={READING_FOLIO} />}
          title={t`Find your next source`}
          description={t`Search alphaXiv and OpenAlex by title or topic`}
        />
      )}
    </ResizableDrawer>
  );
}
