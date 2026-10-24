import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowDown, ArrowRight, Check, CircleAlert, CornerDownLeft, Plus, X } from "lucide-react";
import { ScrollArea } from "../components/ui/scroll-area";
import { InfinityLoader } from "../components/ui/activity-icons";
import { CopyButton } from "../components/copy-button";
import { SearchField } from "../components/ui/search-field";
import { paperKey, toMessage } from "../app-utils";
import { notifyError } from "../telemetry/app-notify";
import type { PaperSummary } from "../app-types";
import type { CitationInfo } from "../editor/latex/latex-text";
import { formatCount } from "../i18n";
import { findInLibrary, identityOfInput, referenceKind, type ReferenceKind } from "../papers/paper-add";
import { paperLinkUrl } from "../papers/paper-source";
import { usePaperImportProgressFill } from "../papers/paper-import-progress";
import { paperSearchIdentity, rankPapers, usePaperTextSearch, type RecentPaperImport } from "./paper-library-search";
import {
  groupPapers, paperFilter, paperOrder, paperReadingState, readablePaper, usePaperFacts,
  type PaperFilter, type PaperGroup, type PaperSort,
} from "./paper-library-view";
import { useCompositionGuard } from "./use-composition-guard";
import { EmptyIllustration } from "../components/ui/empty-illustration";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { ResearchArt } from "../components/ui/research-art";
import { CARD_INDEX } from "../components/ui/research-art-card-index";
import { FluidHoverSurface } from "../components/ui/fluid-hover-surface";
import { PaperInspector } from "./paper-inspector";
import { PaperListToolbar } from "./paper-list-toolbar";
import { PaperRow, type PaperFetchState } from "./paper-row";
import { usePaperListWindow, type RowSpan } from "./paper-list-window";
import type { SymbolOccurrence } from "./references-panel";


export type PaperLibraryProps = {
  projectKey: string;
  papers: PaperSummary[];
  /**
   * Whether `papers` has been read: until then an empty list is not an empty
   * library. A read that failed carries its reason.
   */
  load?: { status: "loading" | "ready" } | { status: "error"; error: string };
  /** An Overleaf sync is under way while the library is empty: it may be bringing the bibliography. */
  syncing?: boolean;
  /** Read the paper list again after a failed read. */
  onRetryLoad?: () => void;
  /** The bibliography's entries, for each paper's venue. */
  citations?: CitationInfo[];
  /** Changes whenever the manuscript may cite differently; rescans its citations. */
  citationUsageRevision?: unknown;
  activePaper: PaperSummary | null;
  onReveal: (path: string) => void;
  onPaper: (paper: PaperSummary) => void;
  onLikelyPaper?: (paper: PaperSummary) => void;
  onFetchFullText: (paper: PaperSummary) => void;
  /** Stops the downloads under way; each paper is left as it was. */
  onCancelFetch: () => void;
  paperFetchStates: Record<string, PaperFetchState>;
  onDeletePaper: (paper: PaperSummary) => void;
  onEditBibEntry: (paper: PaperSummary) => void;
  /** Opens a citation of a paper at its line in the manuscript. */
  onOpenCitationUse?: (usage: SymbolOccurrence) => void;
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
  /** Open the Add papers sheet, seeded with what the box holds. */
  onAddPapers: (seed: string) => void;
  onSearchLiterature: (query: string) => void;
};

/** Whether this window just added `paper`: its row says so, in place of a toast. */
function isJustAdded(paper: PaperSummary, justAdded: ReadonlySet<string> | undefined): boolean {
  return Boolean(justAdded && ((paper.citationKey && justAdded.has(paper.citationKey)) || (paper.arxivId && justAdded.has(paper.arxivId))));
}


/** The width of the list and inspector together from which a selected paper shows its inspector. */
const INSPECTOR_MIN_WIDTH = 860;

/*
 * The list's widths reach its CSS as attributes, not container queries.
 * WebKit restyles everything inside a query container whose width changes,
 * and with the list and each row a container, every frame of a panel divider
 * drag beside 600 papers restyled every row drawn: 8 ms of an 18 ms frame.
 * An attribute changes only when its width crosses a step (app-shell.css).
 */
/** From this width the list is a table (`data-table`). */
const TABLE_MIN_WIDTH = 680;
/** The list's widths below which its error state stacks (`data-below`). */
const LIST_STEPS = [240];
/** The list's height below which its empty state lets its drawing go (`data-short`). */
const EMPTY_ART_MIN_HEIGHT = 190;
/** The rows' content widths below which their lines give way (`data-row-below` on `.paper-rows`). */
const ROW_STEPS = [300, 260, 200];

function setSteps(element: HTMLElement, name: string, width: number, steps: readonly number[]) {
  const below = steps.filter((step) => width < step).join(" ");
  if ((element.getAttribute(name) ?? "") === below) return;
  if (below) element.setAttribute(name, below);
  else element.removeAttribute(name);
}

const contentWidth = (entry: ResizeObserverEntry) => entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;

/** The ref of a `.paper-list` scroll area: marks the steps its own width has passed, and whether it is short. */
function observeListSteps(list: HTMLDivElement | null) {
  if (!list || typeof ResizeObserver === "undefined") return undefined;
  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const width = contentWidth(entry);
    list.toggleAttribute("data-table", width >= TABLE_MIN_WIDTH);
    setSteps(list, "data-below", width, LIST_STEPS);
    list.toggleAttribute("data-short", (entry.contentBoxSize?.[0]?.blockSize ?? entry.contentRect.height) < EMPTY_ART_MIN_HEIGHT);
  });
  observer.observe(list);
  return () => observer.disconnect();
}

/** The ref of `.paper-rows`: marks the steps its rows' content box has passed. */
function observeRowSteps(rows: HTMLDivElement | null) {
  if (!rows || typeof ResizeObserver === "undefined") return undefined;
  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    // Each row spans the rows' box; its content box is that less its own inline padding.
    const padding = Number.parseFloat(getComputedStyle(rows).getPropertyValue("--paper-row-padding-inline")) || 0;
    setSteps(rows, "data-row-below", contentWidth(entry) - 2 * padding, ROW_STEPS);
  });
  observer.observe(rows);
  return () => observer.disconnect();
}

/** The Papers panel: one box that searches the library and imports what it does not hold. */
export function PaperLibrary(props: PaperLibraryProps) {
  const { t } = useLingui();
  // An import shows its progress in its own row under the box; a download
  // of a paper already listed still fills the box, as it always has. One
  // clock serves both, as only one runs at a time.
  const fetching = !props.importing && Object.values(props.paperFetchStates).some((state) => state === "loading");
  const importFillRef = usePaperImportProgressFill(fetching || props.importing, props.importStageId);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const { compositionProps, isComposing } = useCompositionGuard();
  const query = props.importInput.trim();
  const textSearch = usePaperTextSearch(query);
  const { hits: textHits, searchNow } = textSearch;
  // An empty list is the empty library only once it has been read, and no
  // Overleaf sync that may be bringing the bibliography is still under way.
  const syncing = useFirstSyncWhileEmpty(props.projectKey, Boolean(props.syncing));
  const loadStatus = props.load?.status !== "ready" ? props.load?.status ?? "ready" : syncing ? "syncing" : "ready";
  // What the box would add, and whether the library already holds it: an
  // arXiv id or DOI is known before anything reaches the network.
  const kind = referenceKind(props.importInput);
  const duplicate = kind === "arxiv" || kind === "doi" ? findInLibrary(props.papers, identityOfInput(query)) : undefined;
  // A paper the library holds opens (or fetches its full text) instead of importing twice.
  const addPaper = () => {
    if (duplicate) {
      if (readablePaper(duplicate)) props.onPaper(duplicate);
      else if (duplicate.arxivId || duplicate.url) props.onFetchFullText(duplicate);
    } else if (query && !props.importing) props.onImport();
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
      <div className="paper-pending-track" aria-hidden="true"><span ref={importFillRef} style={{ width: "0%" }} /></div>
    </div>
  );
  // What Enter (or a click) will do with what was typed, said before it
  // happens; a known arXiv id or DOI says where it already is instead. The
  // paper the box just added is its own row, marked so, and is not said twice.
  const kindLabels: Record<ReferenceKind, string> = { arxiv: "arXiv", doi: "DOI", url: t`Web page`, bibtex: "BibTeX", title: t`Title` };
  const duplicateCite = duplicate?.citationKey ? `\\cite{${duplicate.citationKey}}` : null;
  /** The add rows above the list; a title offers a lookup only when nothing in the library matches it. */
  const addRows = (matches: number) => {
    if (props.importing) return <div className="paper-add">{pending}</div>;
    if (!kind || (duplicate && isJustAdded(duplicate, props.justAdded))) return null;
    const addRow = duplicate ? (
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
    ) : kind !== "title" || !matches ? (
      <button type="button" className="paper-add-row" onClick={addPaper}>
        <Plus size={13} className="paper-add-icon" aria-hidden="true" />
        <span className="paper-add-text">
          <strong className="paper-add-title">
            {kind === "title" ? t`Look up and add` : t`Add`} <q>{query}</q>
          </strong>
        </span>
        <span className="paper-add-kind">{kindLabels[kind]}</span>
        {kind !== "title" && <CornerDownLeft size={12} className="paper-add-enter" aria-hidden="true" />}
      </button>
    ) : null;
    return (
      <div className="paper-add">
        {addRow}
        {kind === "title" && (
          <button type="button" className="paper-add-row" data-quiet="" onClick={() => props.onSearchLiterature(query)}>
            <ArrowRight size={13} className="paper-add-icon" aria-hidden="true" />
            <span className="paper-add-text">
              <strong className="paper-add-title">{t`Search the literature for`} <q>{query}</q></strong>
            </span>
          </button>
        )}
      </div>
    );
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
            // While a paper is fetched, the tip says which step it is on.
            title={fetching ? props.importStage ?? t`Working…` : undefined}
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
              if (fetching && event.key === "Escape") {
                event.preventDefault();
                props.onCancelFetch();
                return;
              }
              if (event.key !== "Enter" || isComposing(event)) return;
              event.preventDefault();
              if (kind && kind !== "title") addPaper();
              else if (!fetching) searchNow();
            }}
            // A download under way says what it is doing where the box's
            // text was, and offers Cancel beside it; the status gives way to
            // an ellipsis first, and Cancel to its icon in a narrow panel.
            trailing={fetching ? (
              <>
                <span id="paper-import-status" className="paper-import-status" role="status" aria-atomic="true">
                  {props.importStage ?? t`Working…`}
                </span>
                <button
                  type="button"
                  className="paper-import-cancel"
                  onClick={props.onCancelFetch}
                  title={t`Cancel download`}
                  aria-label={t`Cancel download`}
                >
                  <X size={13} className="paper-import-cancel-icon" aria-hidden="true" />
                  <span className="paper-import-cancel-label">{t`Cancel`}</span>
                </button>
              </>
            ) : (
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
            <div className="paper-import-track" aria-hidden="true">
              <span ref={importFillRef} style={{ width: "0%" }} />
            </div>
          )}
        </div>
        {props.papers.length ? <PaperShelf {...props} query={query} textHits={textHits} textSearch={textSearch} addRows={addRows} hasKind={Boolean(kind)} /> : (
          <ScrollArea
            ref={observeListSteps}
            className="paper-list"
            orientation="both"
            contentClassName="paper-list-content"
            aria-busy={loadStatus === "loading" || loadStatus === "syncing" || undefined}
          >
            {addRows(0)}
            {!kind && !props.importing && loadStatus !== "ready" && (
              <PaperLoadStatus load={props.load} syncing={loadStatus === "syncing"} onRetry={props.onRetryLoad} />
            )}
            {!kind && !props.importing && loadStatus === "ready" && (
              <EmptyState
                className="papers-empty-state"
                fill
                icon={<ResearchArt drawing={CARD_INDEX} />}
                title={t`No papers yet`}
                // Only focuses the field: what to add is the writer's to type.
                actions={<Button size="compact" onClick={() => importInputRef.current?.focus()}>{t`Add your first paper`}</Button>}
              />
            )}
          </ScrollArea>
        )}
      </div>
    </aside>
  );
}

/**
 * Whether the first Overleaf sync to run while the library is empty is still
 * under way. Only that one may bring a bibliography that is not on disk yet;
 * later ones (live mode syncs every few seconds) leave an empty library
 * empty, so it does not trade its empty state for a status line each time.
 */
function useFirstSyncWhileEmpty(projectKey: string, syncing: boolean): boolean {
  // Adjusted while rendering, from the previous render's values: a sync that
  // has ended is the only news here, and an effect would paint it a frame late.
  const [seen, setSeen] = useState({ projectKey, syncing, settled: false });
  if (seen.projectKey !== projectKey) setSeen({ projectKey, syncing, settled: false });
  else if (seen.syncing !== syncing) setSeen({ projectKey, syncing, settled: seen.settled || !syncing });
  return syncing && !(seen.projectKey === projectKey && seen.settled);
}

/**
 * The library while its list is not there yet: one quiet line where the rows
 * will be, on their icon gutter, or why the read failed and a retry. Never
 * the empty library's invitation, which would say a library being read is
 * empty.
 */
function PaperLoadStatus({ load, syncing, onRetry }: {
  load: PaperLibraryProps["load"];
  syncing: boolean;
  onRetry?: () => void;
}) {
  const { t } = useLingui();
  if (load?.status === "error") {
    return (
      <div className="papers-load-status" data-state="error" role="status">
        <CircleAlert size={14} className="papers-load-icon" aria-hidden="true" />
        <span className="papers-load-text">
          <strong>{t`Couldn’t read your references`}</strong>
          <span className="papers-load-detail" title={load.error}>{load.error}</span>
        </span>
        {onRetry && <Button size="compact" onClick={onRetry}>{t`Try again`}</Button>}
      </div>
    );
  }
  return (
    <div className="papers-load-status" role="status">
      <span className="papers-load-icon"><InfinityLoader size={12} /></span>
      <span className="papers-load-text">{syncing ? t`Syncing references…` : t`Loading references…`}</span>
    </div>
  );
}

/**
 * Where the full-text half of a search has got, above what it found: the
 * list shows metadata matches at once, and a slow or failed pass over the
 * saved text says so, so a short list (or none) is not read as the library
 * lacking the paper. A quick pass, the usual case, never shows this.
 */
function PaperTextSearchStatus({ search }: { search: ReturnType<typeof usePaperTextSearch> }) {
  const { t } = useLingui();
  if (search.status === "failed") {
    const label = t`Saved-text search unavailable`;
    return (
      <div className="paper-text-search" data-state="failed" role="status">
        <CircleAlert size={13} className="paper-add-icon" aria-hidden="true" />
        <span className="paper-text-search-text" title={search.error ? `${label}\n${search.error}` : label}>{label}</span>
        <Button size="compact" onClick={search.retry}>{t`Try again`}</Button>
      </div>
    );
  }
  if (search.status !== "searching") return null;
  return (
    <div className="paper-text-search" role="status">
      <span className="paper-add-icon"><InfinityLoader size={12} /></span>
      <span className="paper-text-search-text">{t`Searching saved text…`}</span>
    </div>
  );
}

/**
 * The library once it holds a paper: how many, how they are filtered, sorted
 * and grouped, and the list itself. Its own component, so an empty library
 * (every startup without papers) runs none of it.
 */
function PaperShelf(props: PaperLibraryProps & {
  query: string;
  textHits: ReturnType<typeof usePaperTextSearch>["hits"];
  textSearch: ReturnType<typeof usePaperTextSearch>;
  /** The add and pending rows above the list, given how many papers match. */
  addRows: (matches: number) => ReactNode;
  /** The box holds something to add, which the add rows answer in place of the empty state. */
  hasKind: boolean;
}) {
  const { query, textHits } = props;
  const { t } = useLingui();
  const rowId = useId();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (props.recentImport?.query === query && viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [props.recentImport, query]);
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

  // A wide library (a maximised panel) selects a paper on a click and shows
  // it in an inspector beside the list; opening it is the inspector's first
  // action, a double click or Enter. Narrower, a click opens it as before.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWide(entry.contentRect.width >= INSPECTOR_MIN_WIDTH);
    });
    observer.observe(body);
    return () => observer.disconnect();
  }, []);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const inspected = wide && selectedKey ? props.papers.find((paper) => paperKey(paper) === selectedKey) ?? null : null;

  const activatePaper = (paper: PaperSummary) => {
    if (props.paperFetchStates[paperKey(paper)] === "loading") return;
    if (readablePaper(paper)) props.onPaper(paper);
    else if (paper.arxivId || paper.url) props.onFetchFullText(paper);
  };
  const openLink = (link: string) => {
    void openUrl(link).catch((reason) => {
      notifyError(t`Papers`, t`Could not open the article in your browser`, { detail: toMessage(reason) });
    });
  };
  // Closing the inspector (or Escape) leaves the keyboard on the paper it showed.
  const closeInspector = () => {
    const index = selectedKey === null ? -1 : rowKeys.indexOf(selectedKey);
    if (index >= 0) rowWindow.reveal(index, (row) => row.querySelector<HTMLElement>(":scope > .paper-open")?.focus({ preventScroll: true }));
    setSelectedKey(null);
  };
  const inspectedLink = inspected && paperLinkUrl(inspected);
  const total = props.papers.length;
  const emptyState = filteredPapers.length || props.hasKind ? null : t`No matching papers`;
  const stateLabels: Record<string, string> = { fullText: t`Full text`, downloadable: t`Not downloaded`, citation: t`Citation only` };
  const sections = groupPapers(filteredPapers, group, facts, (value) => (
    group === "state" ? stateLabels[value] : value || (group === "year" ? t`No year` : t`No venue`)
  ));
  // Every paper's key in the order the list shows them, and where each group
  // starts: a long list draws only the rows near the view.
  const rowKeys = sections.flatMap((section) => section.papers.map(paperKey));
  const groupStarts = sections.map((_, sectionIndex) => sections.slice(0, sectionIndex).reduce((count, earlier) => count + earlier.papers.length, 0));
  const rowWindow = usePaperListWindow(viewportRef, rowKeys, groupStarts);

  // Tab walks every control of every paper; the arrows, Home and End move
  // between papers, across groups, landing where a click on the row would.
  // A paper the list has not drawn yet is drawn first.
  const movePaperFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity }[event.key];
    if (step === undefined || event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const from = rowKeys.indexOf((event.target as Element).closest<HTMLElement>(".paper-row[data-paper-key]")?.dataset.paperKey ?? "");
    if (from < 0) return;
    const to = Math.max(0, Math.min(rowKeys.length - 1, Number.isFinite(step) ? from + step : step > 0 ? rowKeys.length - 1 : 0));
    const controlIn = (row: HTMLElement) => row.querySelector<HTMLElement>(".paper-open:not(:disabled)")
      ?? row.querySelector<HTMLElement>("button:not(:disabled)");
    const drawn = rowWindow.rowOf(rowKeys[to]!);
    if (drawn && !controlIn(drawn)) return;
    event.preventDefault();
    rowWindow.reveal(to, (row) => controlIn(row)?.focus({ preventScroll: true }));
  };
  /** Rows `from`…`to` of the list as the window draws them: the rows near the view, and gaps for the rest. */
  const drawRows = (papers: readonly PaperSummary[], from: number) => {
    const to = from + papers.length;
    // The gaps keep their keys while the window moves, so each is resized in
    // place rather than replaced, and no drawn row is moved past one: the
    // first and the last are always there (empty, and without the class
    // that spaces the row after it, when no rows stand behind them), and one
    // between two drawn spans is keyed by the row after it. A replaced gap
    // left the list briefly shorter than the view's scroll position, and a
    // moved row lost focus; either way the browser, reading layout
    // mid-commit, pulled the view back up.
    const drawn: ReactNode[] = [];
    const gap = (span: RowSpan, key: string) => (
      <div
        key={key}
        className={span.to > span.from ? "paper-rows-gap" : undefined}
        aria-hidden="true"
        style={{ height: rowWindow.gapHeight(span) }}
      />
    );
    const spans = rowWindow.drawn
      .map((span) => ({ from: Math.max(span.from, from), to: Math.min(span.to, to) }))
      .filter((span) => span.from < span.to);
    if (rowWindow.active) drawn.push(gap({ from, to: spans[0]?.from ?? to }, "gap-start"));
    let at = spans[0]?.from ?? to;
    for (const span of spans) {
      if (span.from > at) drawn.push(gap({ from: at, to: span.from }, `gap-${paperKey(papers[span.from - from]!)}`));
      for (let index = span.from; index < span.to; index += 1) drawn.push(renderRow(papers[index - from]!, index, index - from, papers.length));
      at = span.to;
    }
    if (rowWindow.active) drawn.push(gap({ from: at, to }, "gap-end"));
    return drawn;
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

  const renderRow = (paper: PaperSummary, index: number, position: number, groupSize: number) => (
    <PaperRow
      key={paperKey(paper)}
      paper={paper}
      index={index}
      rowId={rowId}
      projectKey={props.projectKey}
      fetchState={props.paperFetchStates[paperKey(paper)]}
      venue={facts.venue(paper)}
      uses={facts.uses(paper)}
      snippet={textHits.get(paperSearchIdentity(paper))?.snippet.trim()}
      active={Boolean(props.activePaper && paperKey(props.activePaper) === paperKey(paper))}
      selected={wide && selectedKey === paperKey(paper)}
      wide={wide}
      recent={isJustAdded(paper, props.justAdded)}
      observe={rowWindow.active ? rowWindow.observeRow : undefined}
      position={rowWindow.active ? position : undefined}
      groupSize={rowWindow.active ? groupSize : undefined}
      onLikely={props.onLikelyPaper}
      onSelect={setSelectedKey}
      onActivate={activatePaper}
      onOpenLink={openLink}
      onEditBibEntry={props.onEditBibEntry}
      onDelete={props.onDeletePaper}
      onReveal={props.onReveal}
    />
  );

  return (
    <>
        <PaperListToolbar
          shown={filteredPapers.length}
          total={total}
          filter={shownFilter}
          onFilter={setFilter}
          filterCounts={filterCounts}
          usesKnown={usesKnown}
          sort={sort}
          onSort={setSort}
          group={group}
          onGroup={setGroup}
        />
        {/* The list, and beside it in a wide panel the selected paper's inspector. */}
        <div
          ref={bodyRef}
          className="paper-body"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || !inspected || event.defaultPrevented) return;
            event.preventDefault();
            closeInspector();
          }}
        >
        <ScrollArea
          ref={observeListSteps}
          className="paper-list"
          viewportRef={viewportRef}
          viewportProps={{ "data-windowed": rowWindow.active ? "" : undefined }}
          orientation="both"
          contentClassName="paper-list-content"
          aria-busy={props.textSearch.status === "searching" || undefined}
        >
          <PaperTextSearchStatus search={props.textSearch} />
          {props.addRows(filteredPapers.length)}
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
          <div ref={observeRowSteps} className="paper-rows fluid-hover-surface" onKeyDown={movePaperFocus}>
            {/* Tab reaches each paper's own controls, which answer with the focus ring. */}
            <FluidHoverSurface selector=".paper-row" preserveSelection follow={null} />
            {group === "none" ? (
              sections[0] && (
                <div role="list" aria-label={t`Papers`} className="paper-group-list" data-paper-rows-from={0} data-paper-rows-to={sections[0].papers.length}>
                  {drawRows(sections[0].papers, 0)}
                </div>
              )
            ) : sections.map((section, sectionIndex) => {
              const nameId = `${rowId}-${sectionIndex}-group`;
              const offset = groupStarts[sectionIndex]!;
              return (
                <Fragment key={section.id}>
                  {/* A label to the hover fill, which fades across it rather than sliding. */}
                  <div className="paper-group" data-slot="paper-group-label">
                    <span id={nameId} className="paper-group-name">{section.name}</span>
                    <span className="paper-group-count">{formatCount(section.papers.length)}</span>
                  </div>
                  <div role="list" aria-labelledby={nameId} className="paper-group-list" data-paper-rows-from={offset} data-paper-rows-to={offset + section.papers.length}>
                    {drawRows(section.papers, offset)}
                  </div>
                </Fragment>
              );
            })}
          </div>
          {emptyState && (
            <div className="papers-empty-state">
              <EmptyIllustration kind="search" size="compact" />
              <div className="papers-empty-text">
                <strong>{emptyState}</strong>
              </div>
            </div>
          )}
        </ScrollArea>
        {inspected && (
          <PaperInspector
            projectKey={props.projectKey}
            paper={inspected}
            venue={facts.venue(inspected)}
            usages={facts.usages(inspected)}
            // A citation with nothing to download opens its page from the link.
            onOpen={paperReadingState(inspected) !== "citation" ? () => activatePaper(inspected) : undefined}
            onEdit={() => props.onEditBibEntry(inspected)}
            onOpenLink={inspectedLink ? () => openLink(inspectedLink) : undefined}
            onOpenUse={(usage) => props.onOpenCitationUse?.(usage)}
            onClose={closeInspector}
          />
        )}
        </div>
    </>
  );
}
