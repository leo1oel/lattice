import { useId } from "react";
import { useLingui } from "@lingui/react/macro";
import { bibTextToPlain } from "./bib-document";
import type { ResolvedCitationDraft } from "./bib-entry-dialog";
import { readableAuthors, recordVenue } from "./paper-add";

/** A record with no venue, or an arXiv one, is the preprint; anything else was published. */
const isPreprint = (venue: string) => !venue || /arxiv|preprint/i.test(venue);

/**
 * The records a lookup could not tell apart, as one radio list: each reads
 * as it would be cited (serif title, people's names, italic venue), with
 * whether it is the published version or the preprint and how it was matched.
 * The host's own button takes the chosen one.
 */
export function CitationCandidates(props: {
  candidates: readonly ResolvedCitationDraft[];
  chosen: number;
  onChoose: (index: number) => void;
  /** Taking a record without the host's button: a double-click, or Enter on a radio. */
  onUse?: (index: number) => void;
}) {
  const { t } = useLingui();
  const name = useId();
  return (
    <div role="radiogroup" aria-label={t`Citation candidates`} className="bib-candidate-list">
      {props.candidates.map((candidate, index) => {
        const venue = recordVenue(candidate);
        const authors = readableAuthors(candidate.author);
        const preprint = isPreprint(venue);
        return (
          <label
            key={`${candidate.key}-${index}`}
            className="bib-candidate"
            data-chosen={props.chosen === index || undefined}
            onDoubleClick={() => props.onUse?.(index)}
          >
            <input
              type="radio"
              name={name}
              checked={props.chosen === index}
              onChange={() => props.onChoose(index)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !props.onUse) return;
                event.preventDefault();
                props.onUse(index);
              }}
            />
            <span className="bib-candidate-body">
              <strong>{bibTextToPlain(candidate.title)}</strong>
              <span className="bib-candidate-byline">
                {[authors || t`Authors unavailable`, candidate.year || t`Year unavailable`].join(" · ")}
              </span>
              <em>{venue || t`Venue unavailable`}</em>
              <span className="bib-candidate-evidence">
                <span className="bib-candidate-kind" data-kind={preprint ? "preprint" : "published"}>
                  {preprint ? t`Preprint` : t`Published`}
                </span>
                <CitationEvidence evidence={candidate.evidence} authorsPresent={Boolean(candidate.author)} />
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** How a record was found and matched, in one quiet line. */
export function CitationEvidence(props: {
  evidence?: ResolvedCitationDraft["evidence"];
  authorsPresent: boolean;
}) {
  const { t } = useLingui();
  const { evidence } = props;
  const sourceUrl = evidence?.url && /^https?:\/\//i.test(evidence.url) ? evidence.url : undefined;
  const authorMatch = evidence?.author_match === "matched" ? t`Compatible author names`
    : evidence?.author_match === "partial" ? t`Partial author information`
      : props.authorsPresent ? t`Authors unchecked` : t`Authors unavailable and unchecked`;
  return (
    <span className="bib-citation-evidence">
      {evidence?.source && <span>{sourceUrl
        ? <a className="bib-evidence-source" href={sourceUrl} target="_blank" rel="noreferrer">{evidence.source}</a>
        : evidence.source}</span>}
      {evidence?.title_match && <span>{evidence.title_match === "exact" ? t`Exact title match` : t`Similar title match`}</span>}
      <span>{authorMatch}</span>
    </span>
  );
}
