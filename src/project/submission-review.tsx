import { useLingui } from "@lingui/react/macro";
import { CheckStatus } from "./check-status";
import type { ReviewRow, SubmissionReview } from "./submission-review-state";

/** Findings past this many are counted, not listed, so one noisy check cannot push the rest off the drawer. */
const LISTED_FINDINGS = 5;

type OpenAt = (path: string, line: number) => void;

function ReviewRowView(props: { row: ReviewRow; label: string; value: string; detail?: string; onOpenAt: OpenAt }) {
  const { t } = useLingui();
  const { row } = props;
  const tone = row.ok == null ? "" : row.ok ? "ok" : "warn";
  const hidden = row.findings.length - LISTED_FINDINGS;
  return (
    <div className={`checklist-row ${tone}`}>
      <CheckStatus ok={row.ok} />
      <strong>{props.label}</strong>
      <span>{props.value}</span>
      {props.detail ? <small>{props.detail}</small> : null}
      {row.findings.length > 0 && (
        <ul className="checklist-findings">
          {row.findings.slice(0, LISTED_FINDINGS).map((finding, index) => {
            const { file, line } = finding;
            return (
              <li key={index}>
                {file != null && line != null && (
                  <button type="button" onClick={() => props.onOpenAt(file, line)}>{`${file}:${line}`}</button>
                )}
                <span className="checklist-finding-text" title={finding.text}>{finding.text || t`Unnamed font`}</span>
              </li>
            );
          })}
          {hidden > 0 && <li><span className="checklist-finding-text">{hidden === 1 ? t`1 more` : t`${hidden} more`}</span></li>}
        </ul>
      )}
    </div>
  );
}

/**
 * The review's rows under their headings: the anonymity checks under the
 * venue they follow (a camera-ready copy keeps only a note), then the fonts.
 */
export function SubmissionReviewGroups(props: { review: SubmissionReview; rows: ReviewRow[]; onOpenAt: OpenAt }) {
  const { t } = useLingui();
  const { review } = props;
  const venue = review.venue ?? "";
  const labels: Record<ReviewRow["id"], string> = {
    authors: t`Author names`,
    acknowledgements: t`Acknowledgements and thanks`,
    links: t`Links to your accounts`,
    "self-citation": t`Self-citing wording`,
    "pdf-author": t`Author in PDF metadata`,
    type3: t`Type 3 fonts`,
    unembedded: t`Fonts not embedded`,
  };
  const view = (row: ReviewRow) => {
    const authors = row.id === "authors";
    const value = authors
      ? review.mode === "anonymous" ? t`Hidden` : review.mode === "authors-shown" ? t`Shown` : t`Unknown`
      : row.ok == null ? t`Build to check` : row.findings.length ? `${row.findings.length}` : t`None`;
    const detail = !authors
      ? undefined
      : review.mode === "authors-shown"
        ? t`The template's option prints the authors; remove it for review`
        : review.mode === "unknown" ? t`The template's options were not found` : undefined;
    return <ReviewRowView key={row.id} row={row} label={labels[row.id]} value={value} detail={detail} onOpenAt={props.onOpenAt} />;
  };
  const fonts = (row: ReviewRow) => row.id === "type3" || row.id === "unembedded";
  const blind = props.rows.filter((row) => !fonts(row));
  return (
    <>
      {review.mode === "camera-ready" && (
        <section className="checklist-review">
          <h3>{t`Double-blind review`}</h3>
          <p>{t`${venue} camera-ready copy: anonymity is not checked.`}</p>
        </section>
      )}
      {blind.length > 0 && (
        <section className="checklist-review">
          <h3>{t`Double-blind review · ${venue}`}</h3>
          <div className="checklist-rows">{blind.map(view)}</div>
        </section>
      )}
      <section className="checklist-review">
        <h3>{t`PDF fonts`}</h3>
        <div className="checklist-rows">{props.rows.filter(fonts).map(view)}</div>
      </section>
    </>
  );
}
