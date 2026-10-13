import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDown, ArrowUpRight, Check, ExternalLink, File, FileDown, FileText, FolderOpen, Globe, ListFilter, Pencil, Plus, SlidersHorizontal, X } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu";
import { Badge } from "../components/ui/badge";
import { ScrollArea } from "../components/ui/scroll-area";
import { DestructiveButton } from "../components/ui/destructive-button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { CopyButton } from "../components/copy-button";
import { SearchField } from "../components/ui/search-field";
import { paperKey, toMessage } from "../app-utils";
import { notifyError } from "../telemetry/app-notify";
import type { PaperSummary } from "../app-types";
import type { CitationInfo } from "../editor/latex/latex-text";
import { formatCount } from "../i18n";
import { baseArxivId, explicitArxivId } from "../papers/arxiv-id";
import { paperShortAuthors, paperSourceLabel } from "../papers/paper-identity";
import { paperLinkUrl, paperPdfUrl } from "../papers/paper-source";
import { usePaperImportProgressFill } from "../papers/paper-import-progress";
import { beginPaperDrag } from "../papers/paper-drag";
import { citationHealthLabel, citationHealthParts, citationHealthTitle } from "./citation-health";
import { paperSearchIdentity, rankPapers, usePaperTextSearch, type RecentPaperImport } from "./paper-library-search";
import {
  groupPapers, paperFilter, paperOrder, paperReadingState, readablePaper, usePaperFacts,
  type PaperFilter, type PaperGroup, type PaperSort,
} from "./paper-library-view";
import { useCompositionGuard } from "./use-composition-guard";
import { EmptyIllustration } from "../components/ui/empty-illustration";
import { Button } from "../components/ui/button";
import { ResearchArt } from "../components/ui/research-art";
import { CARD_INDEX } from "../components/ui/research-art-card-index";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";

type PaperFetchState = "loading" | "success";

export type PaperLibraryProps = {
  projectKey: string;
  papers: PaperSummary[];
  /** The bibliography's entries, for each paper's venue. */
  citations?: CitationInfo[];
  /** Changes whenever the manuscript may cite differently; rescans its citations. */
  citationUsageRevision?: unknown;
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
  recentImport?: RecentPaperImport | null;
};

/** A page cited by its address: no arXiv preprint, no DOI, not a PDF. */
function webPagePaper(paper: PaperSummary): boolean {
  if (!paper.url || paper.doi || paperPdfUrl({ arxivId: paper.arxivId })) return false;
  return !/\.pdf(?:$|[?#])/i.test(paper.url);
}

/**
 * The row's leading glyph, on the Project tree's icon gutter: what a click
 * opens. A page with lines is a paper to read; an arrow, one that downloads
 * first; a blank page, a citation with nothing to open; a globe, a web page.
 * The shapes differ, so the ink can stay the one secondary grey.
 */
function paperGlyph(paper: PaperSummary, fetchState: PaperFetchState | undefined): ReactNode {
  if (fetchState === "loading") return <InfinityLoader size={12} />;
  if (webPagePaper(paper)) return <Globe size={14} />;
  if (fetchState === "success") return <FileText size={14} />;
  const state = paperReadingState(paper);
  return state === "fullText" ? <FileText size={14} /> : state === "downloadable" ? <FileDown size={14} /> : <File size={14} />;
}

/** The Papers panel: one box that searches the library and imports what it does not hold. */
export function PaperLibrary(props: PaperLibraryProps) {
  const { t } = useLingui();
  const rowId = useId();
  const progressActive = props.importing || Object.values(props.paperFetchStates).some((state) => state === "loading");
  const importFillRef = usePaperImportProgressFill(progressActive, props.importStageId);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const { compositionProps, isComposing } = useCompositionGuard();
  const query = props.importInput.trim();
  useEffect(() => {
    if (props.recentImport?.query === query && viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [props.recentImport, query]);
  const { hits: textHits, searchNow } = usePaperTextSearch(query);
  const facts = usePaperFacts(props.projectKey, props.citations, props.citationUsageRevision);
  // Sort, filter and grouping last for the panel's life; a search narrows what they show.
  const [sort, setSort] = useState<PaperSort>("title");
  const [filter, setFilter] = useState<PaperFilter>("all");
  const [group, setGroup] = useState<PaperGroup>("none");
  const usesKnown = props.papers.some((paper) => facts.uses(paper) !== null);
  // A filter that needs the manuscript's citations waits for their scan.
  const shownFilter = !usesKnown && (filter === "cited" || filter === "uncited") ? "all" : filter;
  const filteredPapers = useMemo(
    () => rankPapers(props.papers, props.importInput, textHits, props.recentImport, paperOrder(sort, facts))
      .filter(paperFilter(shownFilter, facts)),
    [facts, props.importInput, props.papers, props.recentImport, shownFilter, sort, textHits],
  );
  // Each filter's count is the library's, whatever the search, so the menu
  // reads the same while the writer types.
  const filterCounts = useMemo(() => Object.fromEntries((["all", "cited", "uncited", "fullText", "flagged"] as const).map(
    (value) => [value, props.papers.filter(paperFilter(value, facts)).length],
  )) as Record<PaperFilter, number>, [facts, props.papers]);

  const activatePaper = (paper: PaperSummary) => {
    if (readablePaper(paper)) props.onPaper(paper);
    else if (paper.arxivId || paper.url) props.onFetchFullText(paper);
  };
  const addPaper = () => {
    const id = explicitArxivId(props.importInput);
    const existing = id ? props.papers.find(paper => baseArxivId(paper.arxivId).toLowerCase() === id) : undefined;
    if (existing?.hasFullText) props.onPaper(existing);
    else props.onImport();
  };
  const total = props.papers.length;
  const emptyState = !total
    ? [t`Your paper library`, t`Keep sources beside your writing`]
    : filteredPapers.length ? null
      : [t`No matching papers`, shownFilter === "all" ? t`Press + to import it` : t`Try another filter`];
  const sortLabels: Record<PaperSort, string> = {
    title: t`Title`, year: t`Newest first`, author: t`First author`, venue: t`Venue`, cited: t`Most cited here`,
  };
  const filterLabels: Record<PaperFilter, string> = {
    all: t`All papers`,
    cited: t`Cited in this paper`,
    uncited: t`Not cited yet`,
    fullText: t`With full text`,
    flagged: t`Flagged`,
  };
  const groupLabels: Record<PaperGroup, string> = { none: t`No grouping`, year: t`Year`, venue: t`Venue`, state: t`Reading state` };
  const stateLabels: Record<string, string> = { fullText: t`Full text`, downloadable: t`Not downloaded`, citation: t`Citation only` };
  const sections = groupPapers(filteredPapers, group, facts, (value) => (
    group === "state" ? stateLabels[value] : value || (group === "year" ? t`No year` : t`No venue`)
  ));
  const sortOn = sort !== "title" || group !== "none";

  // Tab walks every control of every paper; the arrows, Home and End move
  // between papers, across groups, landing where a click on the row would.
  const movePaperFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(".paper-row"));
    const from = rows.findIndex((row) => row.contains(event.target as Node));
    if (from < 0) return;
    const to = Math.max(0, Math.min(rows.length - 1, Number.isFinite(step) ? from + step : step > 0 ? rows.length - 1 : 0));
    const target = rows[to].querySelector<HTMLElement>(".paper-open:not(:disabled)")
      ?? rows[to].querySelector<HTMLElement>("button:not(:disabled)");
    if (!target) return;
    event.preventDefault();
    target.focus();
  };

  // A wide list's column headers; each sorts by its column.
  const headerSort = (value: PaperSort, label: string, title?: string) => (
    <button
      type="button"
      className="paper-table-sort"
      aria-pressed={sort === value}
      title={title}
      onClick={() => setSort(value)}
    >
      <span>{label}</span>
      {sort === value && <ArrowDown size={12} aria-hidden="true" />}
    </button>
  );

  const renderRow = (paper: PaperSummary, index: number) => {
    const fetchState = props.paperFetchStates[paperKey(paper)];
    const readable = readablePaper(paper);
    const readingState = paperReadingState(paper);
    const healthLabel = citationHealthLabel(paper.citationHealth);
    const health = citationHealthParts(paper.citationHealth);
    const healthTitle = citationHealthTitle(paper.citationHealth);
    const authors = paperShortAuthors(paper);
    const year = paper.year?.trim();
    const venue = facts.venue(paper);
    const uses = facts.uses(paper);
    // A row names its paper by title, authors and year alone; where
    // it came from stands in only when the entry records neither.
    const source = authors || year ? null : paperSourceLabel(paper);
    const snippet = textHits.get(paperSearchIdentity(paper))?.snippet.trim();
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
    const factsId = `${rowId}-${index}-facts`;
    const byline = Boolean(authors || year || venue || source);
    // What the glyph and the count at the end say, for a screen reader.
    const stateText = webPagePaper(paper)
      ? t`Web page`
      : readingState === "fullText" ? t`Full text in Papers`
        : readingState === "downloadable" ? t`Full text downloads on click` : t`Citation only, no full text`;
    const usesText = uses === null ? null
      : uses ? t({ message: `Cited ${{ count: formatCount(uses) }}× in this paper` }) : t`Not cited in this paper yet`;
    const row = (
      <div
        role="listitem"
        className={`paper-row ${paper.hasFullText ? "" : "cited-only "}${healthLabel ? `citation-${paper.citationHealth?.kind} ` : ""}${active ? "active" : ""}`}
        data-citation-health={paper.citationHealth?.kind}
        data-reading={readingState}
        draggable
        onDragStart={(event) => beginPaperDrag(event.dataTransfer, props.projectKey, paper)}
      >
        {/* The button lies over the whole row, under its other
            controls, and takes its name from the text beside it
            (hidden, so it is read once); so the flags line opens the
            paper too, and the notice there can be a link of its own.
            What it holds, how often it is cited and its citation key
            are its description, since the eye sees the key only on a
            lit row. */}
        <button
          data-tour={paper.arxivId === "2010.11929" ? "tutorial-vit-paper" : undefined}
          title={readable
            ? paper.title
            : readingState === "citation" && paper.url
              ? t`Open source page — no downloadable full text found`
              : paper.arxivId
                ? t({ message: `Download arXiv ${{ id: paper.arxivId }}` })
                : paper.url
                  ? t({ message: `Download ${{ url: paper.url }}` })
                  : t({ message: `${{ title: paper.title }} — no local reading available` })}
          className="paper-open"
          aria-labelledby={[titleId, byline && bylineId, snippet && snippetId].filter(Boolean).join(" ")}
          aria-describedby={factsId}
          aria-current={active || undefined}
          // Knowing the preprint is as good as having it: clicking
          // fetches. A cited webpage is fetchable the same way.
          disabled={fetchState === "loading" || (!readable && !paper.arxivId && !paper.url)}
          onPointerEnter={reportIntent}
          onFocus={reportIntent}
          onClick={() => activatePaper(paper)}
        />
        <span className="paper-glyph" data-fetch={fetchState} aria-hidden="true">{paperGlyph(paper, fetchState)}</span>
        <strong id={titleId} className="paper-title" aria-hidden="true">{paper.title}</strong>
        {/* A wide list's columns; a narrow one folds them into the byline. */}
        <span className="paper-cell paper-cell-authors" aria-hidden="true">{authors || source}</span>
        <span className="paper-cell paper-cell-year" aria-hidden="true">{year}</span>
        <span className="paper-cell paper-cell-venue" aria-hidden="true">{venue}</span>
        <span className="paper-uses" data-zero={uses === 0 || undefined} aria-hidden="true">
          {uses === null ? null : uses ? `${formatCount(uses)}×` : "—"}
        </span>
        {/* The line under the title is the byline at rest. Hovered,
            focused or open, the row's citation key (a button that
            copies it) and its actions join it at the end, so they
            never cover the title or change the row's height. */}
        <div className="paper-meta">
          {byline && (
            <small id={bylineId} className="paper-byline" aria-hidden="true">
              {authors && <span className="paper-authors">{authors}</span>}
              {year && <span className="paper-year">{year}</span>}
              {venue && <span className="paper-venue">{venue}</span>}
              {source && <span className="paper-source">{source}</span>}
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
              <button className="row-open-link" title={t`Open link in browser`} aria-label={t({ message: `Open ${{ title: paper.title }} in browser` })} onClick={openLink}><ExternalLink size={14} /></button>
            )}
            {citeKey && (
              <button className="row-edit-bib" title={t`Edit bibliography entry`} onClick={() => props.onEditBibEntry(paper)}><Pencil size={14} /></button>
            )}
            <DestructiveButton
              className="row-delete"
              title={t({ message: `Remove ${{ title: paper.title }}` })}
              iconSize={14}
              onClick={() => props.onDeletePaper(paper)}
            />
          </div>
        </div>
        {snippet && <small id={snippetId} className="paper-snippet" aria-hidden="true">{snippet}</small>}
        {health && <div className="paper-tags">{healthNotice}</div>}
        <span id={factsId} className="sr-only">
          {[stateText, usesText, citeKey && t({ message: `Citation key ${{ key: citeKey }}` }), !healthLabel && healthTitle]
            .filter(Boolean).join(". ")}
        </span>
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
  };

  const shown = formatCount(filteredPapers.length);
  const totalText = formatCount(total);
  return (
    <aside className="navigator">
      <div className="navigator-section papers-section">
        <div className="paper-import-control" data-importing={progressActive || undefined}>
          <SearchField
            ref={importInputRef}
            aria-label={t`Search or import papers`}
            aria-busy={progressActive}
            readOnly={progressActive}
            // The placeholder is short enough never to truncate at the panel's
            // narrowest; what can be pasted to add a paper is in the tip.
            title={progressActive ? props.importStage ?? t`Working…` : t`Search or add by title, arXiv ID, DOI, or URL`}
            aria-describedby={progressActive ? "paper-import-status" : undefined}
            containerClassName="import-box"
            controlSize="compact"
            placeholder={t`Search or add papers`}
            value={props.importInput}
            onChange={(event) => props.setImportInput(event.target.value)}
            onClear={progressActive ? undefined : () => props.setImportInput("")}
            {...compositionProps}
            // Enter only searches: the list already filters as you type, so it
            // runs the full-text pass now. Adding is the + button's job alone.
            onKeyDown={(event) => {
              if (event.key !== "Enter" || isComposing(event)) return;
              event.preventDefault();
              if (!progressActive) searchNow();
            }}
            trailing={(
              <button
                onClick={props.importing ? props.onCancelImport : addPaper}
                disabled={!props.importing && (progressActive || !query)}
                title={props.importing ? t`Cancel` : t`Add paper`}
                aria-label={props.importing ? t`Cancel` : t`Add paper`}
              >
                {props.importing ? <X size={14} /> : <Plus size={14} />}
              </button>
            )}
          />
          {progressActive && (
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
        {/* How many papers the list holds, and how it is narrowed, ordered
            and grouped. The count stands for what is shown, so a search or a
            filter reads as "3 of 7", and "3/7" where that does not fit. A
            narrow panel keeps the two tools as icons, each with a dot once
            it is set; an active filter is also a chip that clears it. */}
        {!!total && (
          <div className="paper-list-toolbar">
            <p className="paper-list-count">
              <span className="paper-count-long">
                {filteredPapers.length !== total
                  ? filteredPapers.length === 1
                    ? t({ message: `1 of ${{ total: totalText }} papers` })
                    : t({ message: `${{ filtered: shown }} of ${{ total: totalText }} papers` })
                  : total === 1
                    ? t`1 paper`
                    : t({ message: `${{ count: totalText }} papers` })}
              </span>
              <span className="paper-count-short" aria-hidden="true">
                {filteredPapers.length !== total ? `${shown}/${totalText}` : totalText}
              </span>
            </p>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="paper-tool"
                  data-on={shownFilter !== "all" || undefined}
                  aria-label={shownFilter === "all" ? t`Filter papers` : t({ message: `Filter papers: ${{ filter: filterLabels[shownFilter] }}` })}
                  title={t`Filter papers`}
                >
                  <ListFilter size={14} aria-hidden="true" />
                  <span className="paper-tool-label">{t`Filter`}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="paper-menu">
                {(Object.keys(filterLabels) as PaperFilter[]).map((value) => (
                  <DropdownMenuItem
                    key={value}
                    role="menuitemradio"
                    aria-checked={shownFilter === value}
                    disabled={!usesKnown && (value === "cited" || value === "uncited")}
                    onSelect={() => setFilter(value)}
                  >
                    <span className="paper-menu-check">{shownFilter === value && <Check size={14} />}</span>
                    <span className="paper-menu-label">{filterLabels[value]}</span>
                    <span className="paper-menu-count">{formatCount(filterCounts[value])}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="paper-tool"
                  data-on={sortOn || undefined}
                  aria-label={t({ message: `Sort and group: ${{ order: group !== "none" ? groupLabels[group] : sortLabels[sort] }}` })}
                  title={t`Sort and group`}
                >
                  <SlidersHorizontal size={14} aria-hidden="true" />
                  <span className="paper-tool-label">{group !== "none" ? groupLabels[group] : sortLabels[sort]}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="paper-menu">
                <DropdownMenuLabel>{t`Group by`}</DropdownMenuLabel>
                {(Object.keys(groupLabels) as PaperGroup[]).map((value) => (
                  <DropdownMenuItem key={value} role="menuitemradio" aria-checked={group === value} onSelect={() => setGroup(value)}>
                    <span className="paper-menu-check">{group === value && <Check size={14} />}</span>
                    <span className="paper-menu-label">{groupLabels[value]}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t`Sort by`}</DropdownMenuLabel>
                {(Object.keys(sortLabels) as PaperSort[]).map((value) => (
                  <DropdownMenuItem
                    key={value}
                    role="menuitemradio"
                    aria-checked={sort === value}
                    disabled={!usesKnown && value === "cited"}
                    onSelect={() => setSort(value)}
                  >
                    <span className="paper-menu-check">{sort === value && <Check size={14} />}</span>
                    <span className="paper-menu-label">{sortLabels[value]}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {!!total && shownFilter !== "all" && (
          <div className="paper-chips">
            <button
              type="button"
              className="paper-chip"
              title={t`Clear filter`}
              aria-label={t({ message: `Clear filter: ${{ filter: filterLabels[shownFilter] }}` })}
              onClick={() => setFilter("all")}
            >
              <span>{filterLabels[shownFilter]}</span>
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )}
        <ScrollArea
          className="paper-list"
          viewportRef={viewportRef}
          orientation="both"
          contentClassName="paper-list-content"
        >
          {!!filteredPapers.length && (
            <div className="paper-table-head" role="group" aria-label={t`Sort papers`}>
              <span />
              {headerSort("title", t`Title`)}
              {headerSort("author", t`Authors`)}
              {headerSort("year", t`Year`)}
              {headerSort("venue", t`Venue`)}
              {usesKnown ? headerSort("cited", t`Cited`, t`Times cited in this paper`) : <span />}
            </div>
          )}
          {/* Only the papers are list items; a group's heading names its
              list, and the empty state sits after them. */}
          <div className="paper-rows fluid-hover-surface" onKeyDown={movePaperFocus}>
            {/* Tab reaches each paper's own controls, which answer with the focus ring. */}
            <FluidHoverSurface selector=".paper-row" preserveSelection follow={null} />
            {group === "none" ? (
              <div role="list" aria-label={t`Papers`} className="paper-group-list">
                {sections[0]?.papers.map((paper, index) => renderRow(paper, index))}
              </div>
            ) : sections.map((section, sectionIndex) => {
              const nameId = `${rowId}-${sectionIndex}-group`;
              const offset = sections.slice(0, sectionIndex).reduce((count, earlier) => count + earlier.papers.length, 0);
              return (
                <Fragment key={section.id}>
                  {/* A label to the hover fill, which fades across it rather than sliding. */}
                  <div className="paper-group" data-slot="paper-group-label">
                    <span id={nameId} className="paper-group-name">{section.name}</span>
                    <span className="paper-group-count">{formatCount(section.papers.length)}</span>
                  </div>
                  <div role="list" aria-labelledby={nameId} className="paper-group-list">
                    {section.papers.map((paper, index) => renderRow(paper, offset + index))}
                  </div>
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
