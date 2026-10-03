import { Fragment, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BookMarked, BookOpen, Check, Download, ExternalLink, FolderOpen, Pencil, Plus, TriangleAlert, X } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../components/ui/context-menu";
import { ScrollArea } from "../components/ui/scroll-area";
import { DestructiveButton } from "../components/ui/destructive-button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { SearchField } from "../components/ui/search-field";
import { paperKey } from "../app-utils";
import type { PaperSummary } from "../app-types";
import { baseArxivId, explicitArxivId } from "../papers/arxiv-id";
import { paperShortAuthors, paperSourceLabel } from "../papers/paper-identity";
import { canDownloadPaper } from "../papers/paper-source";
import { usePaperImportProgressFill } from "../papers/paper-import-progress";
import { beginPaperDrag } from "../papers/paper-drag";
import { citationHealthLabel, citationHealthTitle } from "./citation-health";
import { paperSearchIdentity, rankPapers, usePaperTextSearch, type RecentPaperImport } from "./paper-library-search";
import { useCompositionGuard } from "./use-composition-guard";
import { EmptyIllustration } from "../components/ui/empty-illustration";

type PaperFetchState = "loading" | "success";

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
  recentImport?: RecentPaperImport | null;
};

function paperStateIcon(
  paper: PaperSummary,
  fetchState: PaperFetchState | undefined,
  readable: boolean,
  downloadable: boolean,
) {
  if (fetchState === "loading") return <InfinityLoader size={14} />;
  if (fetchState === "success") return <Check size={14} />;
  if (readable) return <BookOpen size={14} />;
  if (downloadable) return <Download size={14} />;
  return paper.url ? <ExternalLink size={14} /> : <BookMarked size={14} />;
}

/** The Papers panel: one box that searches the library and imports what it does not hold. */
export function PaperLibrary(props: PaperLibraryProps) {
  const { t } = useLingui();
  const progressActive = props.importing || Object.values(props.paperFetchStates).some((state) => state === "loading");
  const importFillRef = usePaperImportProgressFill(progressActive, props.importStageId);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const { compositionProps, isComposing } = useCompositionGuard();
  const query = props.importInput.trim();
  useEffect(() => {
    if (props.recentImport?.query === query && viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [props.recentImport, query]);
  const { hits: textHits, searchNow } = usePaperTextSearch(query);
  const filteredPapers = useMemo(
    () => rankPapers(props.papers, props.importInput, textHits, props.recentImport),
    [props.importInput, props.papers, props.recentImport, textHits],
  );

  const activatePaper = (paper: PaperSummary) => {
    if (paper.hasFullText || paper.hasBlog) props.onPaper(paper);
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
    ? [t`Add your first paper`, t`Paste an arXiv ID, DOI, URL or title above`]
    : filteredPapers.length ? null
      : [t`No matching papers`, t`Press + to import it`];

  return (
    <aside className="navigator">
      <div className="navigator-section papers-section">
        <div className="paper-import-control" data-importing={progressActive || undefined}>
          <SearchField
            aria-label={t`Search or import papers`}
            aria-busy={progressActive}
            readOnly={progressActive}
            title={progressActive ? props.importStage ?? t`Working…` : undefined}
            aria-describedby={progressActive ? "paper-import-status" : undefined}
            containerClassName="import-box"
            controlSize="compact"
            placeholder={t`Search or add by title, arXiv ID, DOI, or URL`}
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
        <ScrollArea
          className="paper-list"
          viewportRef={viewportRef}
          orientation="both"
          contentClassName="paper-list-content"
          viewportProps={{ role: "list", "aria-label": t`Papers` }}
        >
          {filteredPapers.map((paper) => {
            const fetchState = props.paperFetchStates[paperKey(paper)];
            const readable = paper.hasFullText || paper.hasBlog;
            const downloadable = canDownloadPaper(paper);
            const healthLabel = citationHealthLabel(paper.citationHealth);
            const healthTitle = citationHealthTitle(paper.citationHealth);
            const authors = paperShortAuthors(paper);
            const source = paperSourceLabel(paper);
            const snippet = textHits.get(paperSearchIdentity(paper))?.snippet.trim();
            const reportIntent = () => {
              if (readable) props.onLikelyPaper?.(paper);
            };
            const row = (
              <div
                className={`paper-row ${paper.hasFullText ? "" : "cited-only "}${healthLabel ? `citation-${paper.citationHealth?.kind} ` : ""}${props.activePaper && paperKey(props.activePaper) === paperKey(paper) ? "active" : ""}`}
                data-citation-health={paper.citationHealth?.kind}
                // How many 22px actions sit beside the title (see .paper-row-actions).
                style={{ "--paper-row-actions": 1 + Number(Boolean(paper.citationKey)) + Number(Boolean(healthLabel && paper.citationHealth?.link)) } as CSSProperties}
                draggable
                onDragStart={(event) => beginPaperDrag(event.dataTransfer, props.projectKey, paper)}
              >
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
                  // Knowing the preprint is as good as having it: clicking
                  // fetches. A cited webpage is fetchable the same way.
                  disabled={fetchState === "loading" || (!readable && !paper.arxivId && !paper.url)}
                  onPointerEnter={reportIntent}
                  onFocus={reportIntent}
                  onClick={() => activatePaper(paper)}
                >
                  <span className={`paper-state-icon ${fetchState ?? (readable ? "available" : "idle")}`}>
                    {paperStateIcon(paper, fetchState, readable, downloadable)}
                  </span>
                  <span className="paper-row-text">
                    <strong>{paper.title}</strong>
                    {(authors || source) && (
                      <small className="paper-byline">
                        {authors && <span className="paper-authors">{authors}</span>}
                        {source && <span>{source}</span>}
                      </small>
                    )}
                    {snippet
                      ? <small className="paper-snippet">{snippet}</small>
                      : paper.citationKey && <code className="paper-cite-key">{paper.citationKey}</code>}
                    {!readable && !downloadable && <small>{t`Citation only — no downloadable full text found`}</small>}
                    {healthLabel && <small className="paper-citation-health" role="status">{healthLabel}</small>}
                  </span>
                </button>
                <div className="paper-row-actions">
                  {healthLabel && paper.citationHealth?.link && (
                    <button
                      className="row-citation-health"
                      title={t({ message: `${{ notice: healthTitle }}. Open notice` })}
                      aria-label={t({ message: `${{ notice: healthLabel }}. Open notice` })}
                      onClick={() => void openUrl(paper.citationHealth!.link!).catch(() => undefined)}
                    >
                      <TriangleAlert size={12} />
                    </button>
                  )}
                  {paper.citationKey && (
                    <button className="row-edit-bib" title={t`Edit bibliography entry`} onClick={() => props.onEditBibEntry(paper)}><Pencil size={12} /></button>
                  )}
                  <DestructiveButton
                    className="row-delete"
                    title={t({ message: `Remove ${{ title: paper.title }}` })}
                    iconSize={12}
                    onClick={() => props.onDeletePaper(paper)}
                  />
                </div>
                {!healthLabel && healthTitle && <span className="sr-only">{healthTitle}</span>}
              </div>
            );
            // A cited-only paper has no local file to act on, so it stays bare;
            // one with full text gets the same right-click menu as a tree file.
            const revealPath = `.research/papers/${paper.arxivId}/${paper.hasFullText ? "paper.md" : "blog.md"}`;
            return (
              <Fragment key={paperKey(paper)}>
                {readable ? (
                  <ContextMenu>
                    <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
                    <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
                      <ContextMenuItem onSelect={() => props.onReveal(revealPath)}>
                        <FolderOpen size={14} />{t`Show in Finder`}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                ) : row}
              </Fragment>
            );
          })}
          {emptyState && (
            <div className="papers-empty-state">
              {/* Beside the text, not above it: the card sits in a short panel
                  at startup, and a taller card would overflow it. */}
              <EmptyIllustration kind={total ? "search" : "papers"} size="compact" />
              <div className="papers-empty-text">
                <strong>{emptyState[0]}</strong>
                <p>{emptyState[1]}</p>
              </div>
            </div>
          )}
          {!!filteredPapers.length && (
            <p className="paper-list-end">
              {filteredPapers.length !== total
                ? filteredPapers.length === 1
                  ? t({ message: `1 of ${{ total }} papers` })
                  : t({ message: `${{ filtered: filteredPapers.length }} of ${{ total }} papers` })
                : total === 1
                  ? t`1 paper`
                  : t({ message: `${{ count: total }} papers` })}
            </p>
          )}
        </ScrollArea>
      </div>
    </aside>
  );
}
