import type { ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowUpRight, ExternalLink, File, FileDown, FileText, FolderOpen, Globe, Pencil } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../components/ui/context-menu";
import { Badge } from "../components/ui/badge";
import { DestructiveButton } from "../components/ui/destructive-button";
import { InfinityLoader } from "../components/ui/activity-icons";
import { CopyButton } from "../components/copy-button";
import { paperKey } from "../app-utils";
import type { PaperSummary } from "../app-types";
import { formatCount } from "../i18n";
import { paperShortAuthors, paperSourceLabel } from "../papers/paper-identity";
import { paperLinkUrl, paperPdfUrl } from "../papers/paper-source";
import { beginPaperDrag } from "../papers/paper-drag";
import { citationHealthLabel, citationHealthParts, citationHealthTitle } from "./citation-health";
import { paperReadingState, readablePaper } from "./paper-library-view";

export type PaperFetchState = "loading" | "success";

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

/** Whether a click on `paper` opens or fetches something. */
const canActivate = (paper: PaperSummary) => readablePaper(paper) || Boolean(paper.arxivId || paper.url);

export type PaperRowProps = {
  paper: PaperSummary;
  /** The row's place in the whole list, for its ids. */
  index: number;
  rowId: string;
  projectKey: string;
  fetchState: PaperFetchState | undefined;
  venue: string;
  uses: number | null;
  snippet: string | undefined;
  active: boolean;
  selected: boolean;
  wide: boolean;
  /** Added from this window: the row says so and keeps its key out to copy, in place of a toast. */
  recent: boolean;
  /** Set when the list draws only some rows: the ref that measures the row, and its place in its group for a screen reader. */
  observe: ((row: HTMLElement | null) => (() => void) | undefined) | undefined;
  position: number | undefined;
  groupSize: number | undefined;
  onLikely: ((paper: PaperSummary) => void) | undefined;
  onSelect: (key: string) => void;
  onActivate: (paper: PaperSummary) => void;
  onOpenLink: (link: string) => void;
  onEditBibEntry: (paper: PaperSummary) => void;
  onDelete: (paper: PaperSummary) => void;
  onReveal: (path: string) => void;
};

/**
 * One paper in the list. Its own component, so the rows a list re-render
 * leaves as they were are not drawn again: a long list's window moving as it
 * scrolls draws only the rows it brings in.
 */
export function PaperRow(props: PaperRowProps) {
  const { t } = useLingui();
  const { paper, index, rowId, fetchState, venue, uses, snippet, active, selected, wide, recent, observe, position, groupSize } = props;
  const readable = readablePaper(paper);
  const readingState = paperReadingState(paper);
  const healthLabel = citationHealthLabel(paper.citationHealth);
  const health = citationHealthParts(paper.citationHealth);
  const healthTitle = citationHealthTitle(paper.citationHealth);
  const authors = paperShortAuthors(paper);
  const year = paper.year?.trim();
  // A row names its paper by title, authors and year alone; where
  // it came from stands in only when the entry records neither.
  const source = authors || year ? null : paperSourceLabel(paper);
  const citeKey = paper.citationKey;
  const link = paperLinkUrl(paper);
  const reportIntent = () => {
    if (readable) props.onLikely?.(paper);
  };
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
      ref={observe}
      role="listitem"
      // A list that draws only some rows tells a screen reader how many it holds.
      aria-setsize={groupSize}
      aria-posinset={position === undefined ? undefined : position + 1}
      data-paper-key={paperKey(paper)}
      className={`paper-row ${paper.hasFullText ? "" : "cited-only "}${healthLabel ? `citation-${paper.citationHealth?.kind} ` : ""}${recent ? "just-added " : ""}${active ? "active" : ""}`}
      data-citation-health={paper.citationHealth?.kind}
      data-reading={readingState}
      data-item-selected={selected || undefined}
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
        // fetches. A cited webpage is fetchable the same way. Wide, every
        // paper can be selected, so none is disabled; the keyboard selects
        // as it moves, as a pointer's first click does.
        disabled={!wide && (fetchState === "loading" || !canActivate(paper))}
        onPointerEnter={reportIntent}
        onFocus={() => {
          reportIntent();
          if (wide) props.onSelect(paperKey(paper));
        }}
        onClick={(event) => {
          if (wide && event.detail === 1) props.onSelect(paperKey(paper));
          else props.onActivate(paper);
        }}
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
            <button className="row-open-link" title={t`Open link in browser`} aria-label={t({ message: `Open ${{ title: paper.title }} in browser` })} onClick={() => props.onOpenLink(link)}><ExternalLink size={14} /></button>
          )}
          {citeKey && (
            <button className="row-edit-bib" title={t`Edit bibliography entry`} onClick={() => props.onEditBibEntry(paper)}><Pencil size={14} /></button>
          )}
          <DestructiveButton
            className="row-delete"
            title={t({ message: `Remove ${{ title: paper.title }}` })}
            iconSize={14}
            onClick={() => props.onDelete(paper)}
          />
        </div>
      </div>
      {snippet && <small id={snippetId} className="paper-snippet" aria-hidden="true">{snippet}</small>}
      {health && <div className="paper-tags">{healthNotice}</div>}
      <span id={factsId} className="sr-only">
        {[recent && t`Just added`, stateText, usesText, citeKey && t({ message: `Citation key ${{ key: citeKey }}` }), !healthLabel && healthTitle]
          .filter(Boolean).join(". ")}
      </span>
    </div>
  );
  // The right-click menu opens the paper's web page, and one with a
  // local file reveals it as a tree file's menu does; a paper with
  // neither stays bare.
  const revealPath = `.research/papers/${paper.arxivId}/${paper.hasFullText ? "paper.md" : "blog.md"}`;
  return (
    <>
      {readable || link ? (
        <ContextMenu>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
            {link && (
              <ContextMenuItem onSelect={() => props.onOpenLink(link)}>
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
    </>
  );
}
