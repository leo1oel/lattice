import { useLingui } from "@lingui/react/macro";
import { Badge } from "../components/ui/badge";
import type { BibSummary } from "./bib-document";
import { EntryPaperAction } from "./bib-entry-detail";
import type { EntryPaperState } from "./bib-entry-paper";

/**
 * One reference in the list. Its own component, so moving the window of rows
 * drawn renders only the rows it brings in, and a row whose reference, flags
 * and place are unchanged is not drawn again.
 */
export function BibRow(props: {
  id: string;
  summary: BibSummary;
  citationKey: string;
  selected: boolean;
  unused: boolean;
  citedCount: number;
  paperState: EntryPaperState;
  top: number;
  height: number;
  onSelect: (key: string) => void;
  onOpenPaper: (key: string) => void;
}) {
  const { t } = useLingui();
  const { summary, citationKey, citedCount } = props;
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.selected}
      className="bib-row"
      style={{ top: props.top, height: props.height }}
      onClick={() => props.onSelect(citationKey)}
    >
      <span className="bib-row-year">{summary.year}</span>
      <span className="bib-row-title">{summary.title || <em>{t`Untitled`}</em>}</span>
      <span className="bib-row-meta">
        {summary.shortAuthors && <span className="bib-row-authors">{summary.shortAuthors}</span>}
        {summary.venue && <i className="bib-row-venue">{summary.venue}</i>}
      </span>
      {/* The type is left to the detail: a reference list does not set it. */}
      <span className="bib-row-foot">
        <code className="bib-row-key">{citationKey}</code>
        {props.unused
          ? <Badge size="compact" tone="warning" className="bib-row-badge">{t`Unused`}</Badge>
          : citedCount > 0 && (
            <span className="bib-row-cited" title={t`Citations in the manuscript: ${citedCount}`}>
              {/* One dot a citation, up to five; the count says the rest. */}
              <span className="bib-row-dots" aria-hidden="true">
                {Array.from({ length: Math.min(citedCount, 5) }, (_, dot) => <i key={dot} />)}
              </span>
              <span aria-hidden="true">{citedCount}</span>
              <span className="sr-only">{t`Cited ×${citedCount}`}</span>
            </span>
          )}
      </span>
      <EntryPaperAction iconOnly state={props.paperState} onOpen={() => props.onOpenPaper(citationKey)} />
    </div>
  );
}
