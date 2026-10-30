import { useLingui } from "@lingui/react/macro";
import { CheckStatus } from "./check-status";
import type { ReviewGroup } from "./submission-review-state";

/** Findings past this many are counted, not listed, so one noisy check cannot push the rest off the drawer. */
const LISTED_FINDINGS = 5;

function ReviewRowView(props: { row: ReviewGroup["rows"][number]; onOpenAt: (path: string, line: number) => void }) {
  const { t } = useLingui();
  const { row } = props;
  const tone = row.ok == null ? "" : row.ok ? "ok" : "warn";
  const hidden = row.findings.length - LISTED_FINDINGS;
  return (
    <div className={`checklist-row ${tone}`}>
      <CheckStatus ok={row.ok} />
      <strong>{row.label}</strong>
      <span>{row.value}</span>
      {row.detail ? <small>{row.detail}</small> : null}
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

export function SubmissionReviewGroups(props: { groups: ReviewGroup[]; onOpenAt: (path: string, line: number) => void }) {
  return props.groups.map((group) => (
    <section key={group.id} className="checklist-review">
      <h3>{group.title}</h3>
      {group.note && <p>{group.note}</p>}
      {group.rows.length > 0 && (
        <div className="checklist-rows">
          {group.rows.map((row) => <ReviewRowView key={row.id} row={row} onOpenAt={props.onOpenAt} />)}
        </div>
      )}
    </section>
  ));
}
