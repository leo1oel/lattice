import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDownUp, ArrowRight, ArrowUpRight, Check, CornerDownLeft, Download, ExternalLink, FolderOpen, ListFilter, Pencil, Plus, X } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../components/ui/context-menu";
import { Badge } from "../components/ui/badge";
import { ScrollArea } from "../components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { DestructiveButton } from "../components/ui/destructive-button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { CopyButton } from "../components/copy-button";
import { SearchField } from "../components/ui/search-field";
import { paperKey, toMessage } from "../app-utils";
import { notifyError } from "../telemetry/app-notify";
import type { PaperSummary } from "../app-types";
import { findInLibrary, identityOfInput, referenceKind, type ReferenceKind } from "../papers/paper-add";
import { paperShortAuthors, paperSourceLabel } from "../papers/paper-identity";
import { canDownloadPaper, paperLinkUrl } from "../papers/paper-source";
import { usePaperImportProgressFill } from "../papers/paper-import-progress";
import { beginPaperDrag } from "../papers/paper-drag";
import { citationHealthLabel, citationHealthParts, citationHealthTitle } from "./citation-health";
import { paperSearchIdentity, rankPapers, usePaperTextSearch, type RecentPaperImport } from "./paper-library-search";
import { useCompositionGuard } from "./use-composition-guard";
import { EmptyIllustration } from "../components/ui/empty-illustration";
import { Button } from "../components/ui/button";
import { ResearchArt } from "../components/ui/research-art";
import { CARD_INDEX } from "../components/ui/research-art-card-index";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";

type PaperFetchState = "loading" | "success";
/** "title" is the library's own order (by title), or best match first while searching. */
type PaperSort = "title" | "year" | "author";
type PaperFilter = "all" | "downloaded" | "notDownloaded" | "flagged";

export type PaperLibraryProps = {
  projectKey: string;
  papers: PaperSummary[];
  activePaper: PaperSummary | null;
  onReveal: (path: string) => void;
  onPaper: (paper: PaperSummary) => void;
  onLikelyPaper?: (paper: PaperSummary) => void;
  onFetchFullText: (paper: PaperSummary) => void;
  paperFetchStates: Record<string, PaperFetchState>;
  onDeletePaper: (paper: PaperSummary) => void;
  onEditBibEntry: (paper: PaperSummary) => void;
  importInput: string;
  setImportInput: (value: string) => void;
  onImport: () => void;
  onCancelImport: () => void;
  importing: boolean;
  /** Human-readable pipeline stage while an import or fetch is running. */
  importStage?: string | null;
  importStageId?: string | null;
  /** What the running import was given: the pending row names it by this. */
  importLabel?: string | null;
  recentImport?: RecentPaperImport | null;
  /** Citation keys or arXiv ids this window just added; their rows say so, with the key to copy. */
  justAdded?: ReadonlySet<string>;
  /** The project's bibliography file, which an add writes to. */
  bibliographyName?: string;
  /** Open the Add papers sheet, seeded with what the box holds. */
  onAddPapers: (seed: string) => void;
  onSearchLiterature: (query: string) => void;
};

const readablePaper = (paper: PaperSummary) => paper.hasFullText || paper.hasBlog;

const PAPER_FILTERS: Record<PaperFilter, (paper: PaperSummary) => boolean> = {
  all: () => true,
  downloaded: readablePaper,
  notDownloaded: (paper) => !readablePaper(paper),
  flagged: (paper) => Boolean(citationHealthLabel(paper.citationHealth)),
};

/**
 * The chosen sort as a comparison, or none for the library's own order (by
 * title, best match first while searching). A paper with no year or author
 * goes last.
 */
function paperOrder(sort: PaperSort): ((a: PaperSummary, b: PaperSummary) => number) | undefined {
  if (sort === "title") return undefined;
  const key = (paper: PaperSummary) => (sort === "year" ? paper.year?.trim() : paperShortAuthors(paper)) || "";
  return (a, b) => {
    const [left, right] = [key(a), key(b)];
    return Number(!left) - Number(!right)
      || (sort === "year" ? right.localeCompare(left, undefined, { numeric: true }) : left.localeCompare(right));
  };
}

function paperStateIcon(paper: PaperSummary, fetchState: PaperFetchState | undefined, downloadable: boolean) {
  if (fetchState === "loading") return <InfinityLoader size={12} />;
  if (fetchState === "success") return <Check size={12} />;
  if (downloadable) return <Download size={12} />;
  return paper.url ? <ExternalLink size={12} /> : null;
}

/** The Papers panel: one box that searches the library and imports what it does not hold. */
export function PaperLibrary(props: PaperLibraryProps) {
  const { t } = useLingui();
  const rowId = useId();
  // An import shows its progress in its own row under the box; a download
  // of a paper already listed still fills the box, as it always has.
  const fetching = !props.importing && Object.values(props.paperFetchStates).some((state) => state === "loading");
  const importFillRef = usePaperImportProgressFill(fetching, props.importStageId);
  const pendingFillRef = usePaperImportProgressFill(props.importing, props.importStageId);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const { compositionProps, isComposing } = useCompositionGuard();
  const query = props.importInput.trim();
  useEffect(() => {
    if (props.recentImport?.query === query && viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [props.recentImport, query]);
  const { hits: textHits, searchNow } = usePaperTextSearch(query);
  // Sort and filter last for the panel's life; a search narrows what they show.
  const [sort, setSort] = useState<PaperSort>("title");
  const [filter, setFilter] = useState<PaperFilter>("all");
  const filteredPapers = useMemo(
    () => rankPapers(props.papers, props.importInput, textHits, props.recentImport, paperOrder(sort))
      .filter(PAPER_FILTERS[filter]),
    [filter, props.importInput, props.papers, props.recentImport, sort, textHits],
  );

  const activatePaper = (paper: PaperSummary) => {
    if (readablePaper(paper)) props.onPaper(paper);
    else if (paper.arxivId || paper.url) props.onFetchFullText(paper);
  };
  // What the box would add, and whether the library already holds it: an
  // arXiv id or DOI is known before anything reaches the network.
  const kind = referenceKind(props.importInput);
  const duplicate = kind === "arxiv" || kind === "doi" ? findInLibrary(props.papers, identityOfInput(query)) : undefined;
  // A paper the library holds opens (or fetches its full text) instead of importing twice.
  const addPaper = () => {
    if (duplicate) activatePaper(duplicate);
    else if (query && !props.importing) props.onImport();
  };
  const total = props.papers.length;
  const emptyState = !total
    ? [t`Your paper library`, t`Keep sources beside your writing`]
    : filteredPapers.length || kind ? null
      : [t`No matching papers`, t`Try another filter`];
  const sortLabels: Record<PaperSort, string> = { title: t`Title`, year: t`Newest first`, author: t`Author` };
  const filterLabels: Record<PaperFilter, string> = {
    all: t`All papers`,
    downloaded: t`Downloaded`,
    notDownloaded: t`Not downloaded`,
    flagged: t`Flagged`,
  };

  // The import under way, in a row of its own: what was given, the
  // pipeline's three steps, Cancel, and a hairline of progress.
  const stages = [["resolving", t`Metadata`], ["fulltext", t`Full text`], ["overview", t`Overview`]] as const;
  const stageIndex = Math.max(0, stages.findIndex(([id]) => id === props.importStageId));
  const pending = props.importing && (
    <div className="paper-pending">
      <span className="paper-add-icon" aria-hidden="true"><InfinityLoader size={12} /></span>
      <strong className="paper-add-title">{props.importLabel || query || t`Adding paper`}</strong>
      <ol className="paper-pending-steps" aria-hidden="true">
        {stages.map(([id, label], index) => (
          <li key={id} data-state={index < stageIndex ? "done" : index === stageIndex ? "current" : "next"}>
            {index < stageIndex ? <Check size={11} /> : <span className="paper-pending-dot" />}
            {label}
          </li>
        ))}
      </ol>
      <span className="sr-only" role="status" aria-atomic="true">{props.importStage ?? t`Working…`}</span>
      <button type="button" className="paper-pending-cancel" onClick={props.onCancelImport} title={t`Cancel`} aria-label={t`Cancel`}>
        <X size={13} />
      </button>
      <div className="paper-pending-track" aria-hidden="true"><span ref={pendingFillRef} style={{ width: "0%" }} /></div>
    </div>
  );
  // What Enter (or a click) will do with what was typed, said before it
  // happens; a known arXiv id or DOI says where it already is instead.
  const kindLabels: Record<ReferenceKind, string> = { arxiv: "arXiv", doi: "DOI", url: t`Web page`, bibtex: "BibTeX", title: t`Title` };
  const bibliography = props.bibliographyName || "references.bib";
  const duplicateCite = duplicate?.citationKey ? `\\cite{${duplicate.citationKey}}` : null;
  const addRow = !props.importing && kind && (duplicate ? (
    <div className="paper-add-row" data-duplicate="">
      <Check size={13} className="paper-add-icon" aria-hidden="true" />
      <button type="button" className="paper-add-text" title={duplicate.title} onClick={addPaper}>
        <strong className="paper-add-title">{t`Already in Papers`}</strong>
        <span className="paper-add-detail" data-code={duplicateCite ? "" : undefined}>{duplicateCite ?? duplicate.title}</span>
      </button>
      {duplicateCite && (
        <CopyButton className="paper-add-action" text={duplicateCite} iconSize={12} title={t`Copy \\cite command`} aria-label={t({ message: `Copy ${duplicateCite}` })}>
          <span className="paper-add-action-label">{t`Copy`}</span>
        </CopyButton>
      )}
    </div>
  ) : kind !== "title" || !filteredPapers.length ? (
    <button type="button" className="paper-add-row" onClick={addPaper}>
      <Plus size={13} className="paper-add-icon" aria-hidden="true" />
      <span className="paper-add-text">
        <strong className="paper-add-title">
          {kind === "title" ? t`Look up and add` : t`Add`} <q>{query}</q>
        </strong>
        <span className="paper-add-detail">
          {kind === "title"
            ? t`Finds the record, then lets you choose`
            : kind === "arxiv"
              ? t`Adds it to ${bibliography} and fetches the full text`
              : t`Adds it to ${bibliography}, with its full text when there is one`}
        </span>
      </span>
      <span className="paper-add-kind">{kindLabels[kind]}</span>
      {kind !== "title" && <CornerDownLeft size={12} className="paper-add-enter" aria-hidden="true" />}
    </button>
  ) : null);
  const literatureRow = !props.importing && kind === "title" && (
    <button type="button" className="paper-add-row" data-quiet="" onClick={() => props.onSearchLiterature(query)}>
      <ArrowRight size={13} className="paper-add-icon" aria-hidden="true" />
      <span className="paper-add-text">
        <strong className="paper-add-title">{t`Search the literature for`} <q>{query}</q></strong>
      </span>
    </button>
  );

  // Tab walks every control of every paper; the arrows, Home and End move
  // between papers, landing where a click on the row would.
  const movePaperFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(":scope > .paper-row"));
    const from = rows.findIndex((row) => row.contains(event.target as Node));
    if (from < 0) return;
    const to = Math.max(0, Math.min(rows.length - 1, Number.isFinite(step) ? from + step : step > 0 ? rows.length - 1 : 0));
    const target = rows[to].querySelector<HTMLElement>(".paper-open:not(:disabled)")
      ?? rows[to].querySelector<HTMLElement>("button:not(:disabled)");
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  return (
    <aside className="navigator">
      <div className="navigator-section papers-section">
        <div className="paper-import-control" data-importing={fetching || undefined}>
          <SearchField
            ref={importInputRef}
            aria-label={t`Search or import papers`}
            aria-busy={fetching}
            readOnly={fetching}
            // The placeholder is short enough never to truncate at the panel's
            // narrowest; what can be pasted to add a paper is in the tip.
            title={fetching ? props.importStage ?? t`Working…` : t`Search or add by title, arXiv ID, DOI, or URL`}
            aria-describedby={fetching ? "paper-import-status" : undefined}
            containerClassName="import-box"
            controlSize="compact"
            placeholder={t`Search or add papers`}
            value={props.importInput}
            onChange={(event) => props.setImportInput(event.target.value)}
            onClear={fetching ? undefined : () => props.setImportInput("")}
            {...compositionProps}
            // Enter adds an identifier the library does not hold yet, as the
            // add row under the box says it will. A title only searches: the
            // list already filters as you type, so Enter runs the full-text
            // pass now, and the add row looks the title up when chosen.
            onKeyDown={(event) => {
              if (event.key !== "Enter" || isComposing(event)) return;
              event.preventDefault();
              if (kind && kind !== "title") addPaper();
              else if (!fetching) searchNow();
            }}
            trailing={(
              // Everything else there is to add, a pasted list or a whole .bib, goes through the sheet.
              <button
                onClick={() => props.onAddPapers(query)}
                title={t`Add papers…`}
                aria-label={t`Add papers…`}
              >
                <Plus size={14} />
              </button>
            )}
          />
          {fetching && (
            <>
              <div className="paper-import-track" aria-hidden="true">
                <span ref={importFillRef} style={{ width: "0%" }} />
              </div>
              <span id="paper-import-status" className="paper-import-status" role="status" aria-atomic="true">
                {props.importStage ?? t`Working…`}
              </span>
            </>
          )}
        </div>
        {/* How many papers the list holds, and how it is ordered and narrowed.
            The count stands for what is shown, so a search or a filter reads
            as "3 of 7". */}
        {!!total && (
          <div className="paper-list-toolbar">
            <p className="paper-list-count">
              {filteredPapers.length !== total
                ? filteredPapers.length === 1
                  ? t({ message: `1 of ${{ total }} papers` })
                  : t({ message: `${{ filtered: filteredPapers.length }} of ${{ total }} papers` })
                : total === 1
                  ? t`1 paper`
                  : t({ message: `${{ count: total }} papers` })}
            </p>
            <Select value={sort} onValueChange={(value) => setSort(value as PaperSort)}>
              <SelectTrigger size="compact" aria-label={t`Sort papers`} title={t`Sort papers`} className="paper-list-select">
                <ArrowDownUp className="size-3.5" aria-hidden="true" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {(Object.keys(sortLabels) as PaperSort[]).map((value) => <SelectItem key={value} value={value}>{sortLabels[value]}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={filter} onValueChange={(value) => setFilter(value as PaperFilter)}>
              <SelectTrigger size="compact" aria-label={t`Show papers`} title={t`Show papers`} className="paper-list-select">
                <ListFilter className="size-3.5" aria-hidden="true" />
                {/* At rest the filter is its icon alone, so the count keeps its
                    room in a narrow panel; once it narrows, it says how. */}
                <SelectValue>{filter === "all" ? null : filterLabels[filter]}</SelectValue>
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                {(Object.keys(filterLabels) as PaperFilter[]).map((value) => <SelectItem key={value} value={value}>{filterLabels[value]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        <ScrollArea
          className="paper-list"
          viewportRef={viewportRef}
          orientation="both"
          contentClassName="paper-list-content"
        >
          {(pending || addRow || literatureRow) && <div className="paper-add">{pending}{addRow}{literatureRow}</div>}
          {/* Only the papers are list items; the empty state sits after the list. */}
          <div
            role="list"
            aria-label={t`Papers`}
            className="paper-rows fluid-hover-surface"
            onKeyDown={movePaperFocus}
          >
            {/* Tab reaches each paper's own controls, which answer with the focus ring. */}
            <FluidHoverSurface selector=".paper-row" preserveSelection follow={null} />
            {filteredPapers.map((paper, index) => {
              const fetchState = props.paperFetchStates[paperKey(paper)];
              const readable = readablePaper(paper);
              const downloadable = canDownloadPaper(paper);
              const healthLabel = citationHealthLabel(paper.citationHealth);
              const health = citationHealthParts(paper.citationHealth);
              const healthTitle = citationHealthTitle(paper.citationHealth);
              const authors = paperShortAuthors(paper);
              const year = paper.year?.trim();
              // A row names its paper by title, authors and year alone; where
              // it came from stands in only when the entry records neither.
              const source = authors || year ? null : paperSourceLabel(paper);
              const snippet = textHits.get(paperSearchIdentity(paper))?.snippet.trim();
              const citationOnly = !readable && !downloadable;
              const citeKey = paper.citationKey;
              const link = paperLinkUrl(paper);
              const openLink = () => {
                if (!link) return;
                void openUrl(link).catch((reason) => {
                  notifyError(t`Papers`, t`Could not open the article in your browser`, { detail: toMessage(reason) });
                });
              };
              const reportIntent = () => {
                if (readable) props.onLikelyPaper?.(paper);
              };
              const active = Boolean(props.activePaper && paperKey(props.activePaper) === paperKey(paper));
              // Added from this window: the row says so and keeps its key out to copy, in place of a toast.
              const recent = Boolean(props.justAdded && ((citeKey && props.justAdded.has(citeKey)) || (paper.arxivId && props.justAdded.has(paper.arxivId))));
              // Readable papers open on click and need no mark; the rest say,
              // at the end of their byline, what a click does there (download,
              // visit) or that it is under way.
              const stateIcon = fetchState || !readable ? paperStateIcon(paper, fetchState, downloadable) : null;
              const noticeLink = healthLabel ? paper.citationHealth?.link : undefined;
              // A short chip says what happened; who reported it and when
              // follows in quiet type, which may give way to an ellipsis.
              const healthBody = health && (
                <>
                  <Badge size="compact" tone="warning" className="paper-tag">
                    {health.kind}
                    {noticeLink && <ArrowUpRight size={11} aria-hidden="true" />}
                  </Badge>
                  {health.detail && <span className="paper-citation-health-detail">{health.detail}</span>}
                </>
              );
              const healthNotice = health && (noticeLink ? (
                <button
                  className="paper-citation-health"
                  title={t({ message: `${{ notice: healthTitle }}. Open notice` })}
                  aria-label={t({ message: `${{ notice: healthLabel }}. Open notice` })}
                  onClick={() => void openUrl(noticeLink).catch(() => undefined)}
                >
                  {healthBody}
                </button>
              ) : (
                <span className="paper-citation-health" role="status" title={healthTitle}>{healthBody}</span>
              ));
              const titleId = `${rowId}-${index}-title`;
              const bylineId = `${rowId}-${index}-byline`;
              const snippetId = `${rowId}-${index}-snippet`;
              const keyId = `${rowId}-${index}-key`;
              const byline = Boolean(authors || year || source || stateIcon);
              const row = (
                <div
                  role="listitem"
                  className={`paper-row ${paper.hasFullText ? "" : "cited-only "}${healthLabel ? `citation-${paper.citationHealth?.kind} ` : ""}${recent ? "just-added " : ""}${active ? "active" : ""}`}
                  data-citation-health={paper.citationHealth?.kind}
                  draggable
                  onDragStart={(event) => beginPaperDrag(event.dataTransfer, props.projectKey, paper)}
                >
                  {/* The button lies over the whole row, under its other
                      controls, and takes its name from the text beside it
                      (hidden, so it is read once); so the flags line opens the
                      paper too, and the notice there can be a link of its own.
                      The citation key is its description, since the eye
                      sees it only on a lit row. */}
                  <button
                    data-tour={paper.arxivId === "2010.11929" ? "tutorial-vit-paper" : undefined}
                    title={readable
                      ? paper.title
                      : !downloadable && paper.url
                        ? t`Open source page — no downloadable full text found`
                        : paper.arxivId
                          ? t({ message: `Download arXiv ${{ id: paper.arxivId }}` })
                          : paper.url
                            ? t({ message: `Download ${{ url: paper.url }}` })
                            : t({ message: `${{ title: paper.title }} — no local reading available` })}
                    className="paper-open"
                    aria-labelledby={[titleId, byline && bylineId, snippet && snippetId].filter(Boolean).join(" ")}
                    aria-describedby={citeKey ? keyId : undefined}
                    aria-current={active || undefined}
                    // Knowing the preprint is as good as having it: clicking
                    // fetches. A cited webpage is fetchable the same way.
                    disabled={fetchState === "loading" || (!readable && !paper.arxivId && !paper.url)}
                    onPointerEnter={reportIntent}
                    onFocus={reportIntent}
                    onClick={() => activatePaper(paper)}
                  />
                  <strong id={titleId} className="paper-title" aria-hidden="true">{paper.title}</strong>
                  {/* The line under the title is the byline at rest. Hovered,
                      focused or open, the row's citation key (a button that
                      copies it) and its actions join it at the end, so they
                      never cover the title or change the row's height. */}
                  <div className="paper-meta">
                    {byline && (
                      <small id={bylineId} className="paper-byline" aria-hidden="true">
                        {authors && <span className="paper-authors">{authors}</span>}
                        {year && <span className="paper-year">{year}</span>}
                        {source && <span className="paper-source">{source}</span>}
                        {stateIcon && <span className={`paper-state-icon ${fetchState ?? "idle"}`}>{stateIcon}</span>}
                      </small>
                    )}
                    <div className="paper-row-actions">
                      {citeKey && (
                        <CopyButton
                          className="paper-cite-key"
                          text={citeKey}
                          iconSize={11}
                          title={t`Copy citation key`}
                          aria-label={t({ message: `Copy citation key ${{ key: citeKey }}` })}
                        >
                          <code>{citeKey}</code>
                        </CopyButton>
                      )}
                      {link && (
                        <button className="row-open-link" title={t`Open link in browser`} aria-label={t({ message: `Open ${{ title: paper.title }} in browser` })} onClick={openLink}><ExternalLink size={12} /></button>
                      )}
                      {citeKey && (
                        <button className="row-edit-bib" title={t`Edit bibliography entry`} onClick={() => props.onEditBibEntry(paper)}><Pencil size={12} /></button>
                      )}
                      <DestructiveButton
                        className="row-delete"
                        title={t({ message: `Remove ${{ title: paper.title }}` })}
                        iconSize={12}
                        onClick={() => props.onDeletePaper(paper)}
                      />
                    </div>
                  </div>
                  {snippet && <small id={snippetId} className="paper-snippet" aria-hidden="true">{snippet}</small>}
                  {(citationOnly || health || recent) && (
                    <div className="paper-tags">
                      {recent && <Badge size="compact" tone="success" className="paper-tag">{t`Just added`}</Badge>}
                      {citationOnly && <Badge size="compact" className="paper-tag">{t`Citation only`}</Badge>}
                      {healthNotice}
                    </div>
                  )}
                  {citeKey && <span id={keyId} className="sr-only">{t({ message: `Citation key ${{ key: citeKey }}` })}</span>}
                  {!healthLabel && healthTitle && <span className="sr-only">{healthTitle}</span>}
                </div>
              );
              // The right-click menu opens the paper's web page, and one with a
              // local file reveals it as a tree file's menu does; a paper with
              // neither stays bare.
              const revealPath = `.research/papers/${paper.arxivId}/${paper.hasFullText ? "paper.md" : "blog.md"}`;
              return (
                <Fragment key={paperKey(paper)}>
                  {readable || link ? (
                    <ContextMenu>
                      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                      <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
                        {link && (
                          <ContextMenuItem onSelect={openLink}>
                            <ExternalLink size={14} />{t`Open link in browser`}
                          </ContextMenuItem>
                        )}
                        {readable && (
                          <ContextMenuItem onSelect={() => props.onReveal(revealPath)}>
                            <FolderOpen size={14} />{t`Show in Finder`}
                          </ContextMenuItem>
                        )}
                      </ContextMenuContent>
                    </ContextMenu>
                  ) : row}
                </Fragment>
              );
            })}
          </div>
          {emptyState && (
            <div className="papers-empty-state" data-library={total ? undefined : "empty"}>
              {/* Beside the text, not above it: the card sits in a short panel
                  at startup, and a taller card would overflow it. */}
              {total ? <EmptyIllustration kind="search" size="compact" /> : <ResearchArt drawing={CARD_INDEX} />}
              <div className="papers-empty-text">
                <strong>{emptyState[0]}</strong>
                <p>{emptyState[1]}</p>
                {/* Only focuses the field: what to add is the writer's to type. */}
                {!total && <Button size="compact" onClick={() => importInputRef.current?.focus()}>{t`Add your first paper`}</Button>}
              </div>
            </div>
          )}
        </ScrollArea>
      </div>
    </aside>
  );
}
