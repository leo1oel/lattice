import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Check, ChevronRight, ClipboardCheck, Images, Minus } from "lucide-react";
import { PanelHeader } from "../components/ui/panel-header";
import { Input } from "../components/ui/input";
import { ResizableDrawer } from "../components/ui/resizable-drawer";
import type { BodyBoundary, ProjectDeadline, SubmissionItem } from "../app-types";
import { formatCount } from "../i18n";
import { spaceMixedScript } from "../trellis/trellis-titles";
import { DeadlineCard } from "./deadline-card";
import { itemCondition, itemPasses, type LinkedFileStat } from "./submission-item-state";
import { SubmissionItems } from "./submission-items";

export type ManuscriptChecklistData = {
  /** Null when the project has no countable root document. */
  words: number | null;
  /**
   * "texcount" counts the root document and its includes; anything else is the
   * backend's estimate of the root document alone, which says nothing about
   * how the whole manuscript sits against its budget.
   */
  wordSource: string;
  wordBudget: number | null;
  pages: number | null;
  /** Where the main body ends, before its appendix or references; the page budget counts only the body. */
  body: BodyBoundary;
  pageBudget: number | null;
  deadline: ProjectDeadline | null;
  /** The project template's name ("NeurIPS"), offered as a new deadline's name. */
  venue: string;
  todos: number;
  unusedLabels: number;
  unusedCitations: number;
  buildOk: boolean | null;
  buildMessage: string;
  /** The writer's own items, below the automatic checks. */
  items: SubmissionItem[];
  /** The disk state of the files those items link, by path; a path not read yet is absent. */
  fileStats: Record<string, LinkedFileStat>;
  /** Project files offered when linking one to an item. */
  filePaths: string[];
};

/** A blank or non-numeric budget clears the limit. */
function parseBudget(value: string): number | null {
  const budget = value.trim() ? Number(value) : NaN;
  return Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : null;
}

/**
 * How far a count sits from its limit. The track spans the larger of the two,
 * so an overshoot keeps its proportion: the part past the limit mark is drawn
 * as its own segment instead of pinning the bar at full. The sentence beside
 * it carries the meaning, so the bar itself is hidden from assistive tech.
 */
function BudgetMeter(props: { value: number; limit: number }) {
  const span = Math.max(props.value, props.limit) || 1;
  const percent = (amount: number) => `${(amount / span) * 100}%`;
  const over = props.value > props.limit;
  return (
    <span className={`checklist-meter${over ? " over" : ""}`} aria-hidden="true">
      {props.limit > 0 && <span className="checklist-meter-fill" style={{ width: percent(Math.min(props.value, props.limit)) }} />}
      {over && <span className="checklist-meter-over" style={{ left: percent(props.limit), width: percent(props.value - props.limit) }} />}
    </span>
  );
}

/**
 * A check's result as a mark, so colour never carries it alone: a tick when it
 * passes, an exclamation when it needs attention, a dash when it cannot be
 * settled. Lucide has no bare exclamation, so that one is drawn here from the
 * strokes of its CircleAlert.
 */
function CheckStatus(props: { ok: boolean | null }) {
  return (
    <i className="checklist-status" aria-hidden="true">
      {props.ok == null
        ? <Minus size={12} />
        : props.ok
          ? <Check size={12} />
          : (
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M12 5v9M12 19h.01" />
            </svg>
          )}
    </i>
  );
}

function BudgetRow(props: {
  label: string;
  value: string;
  ok: boolean | null;
  meter?: { value: number; limit: number; distance: string };
  detail?: string;
  onClick?: () => void;
}) {
  const tone = props.ok == null ? "" : props.ok ? "ok" : "warn";
  const Tag = props.onClick ? "button" : "div";
  return (
    <Tag
      type={props.onClick ? "button" : undefined}
      className={`checklist-row ${tone}`}
      onClick={props.onClick}
    >
      <CheckStatus ok={props.ok} />
      <strong>{props.label}</strong>
      <span>{props.value}{props.onClick ? <ChevronRight size={13} aria-hidden="true" /> : null}</span>
      {props.meter ? <BudgetMeter value={props.meter.value} limit={props.meter.limit} /> : null}
      {props.meter || props.detail
        ? (
          <small>
            {props.meter ? <b>{props.meter.distance}</b> : null}
            {props.meter && props.detail ? " · " : null}
            {props.detail}
          </small>
        )
        : null}
    </Tag>
  );
}

export function ManuscriptChecklistPanel(props: {
  data: ManuscriptChecklistData;
  onClose: () => void;
  onOpenTodos: () => void;
  onOpenFigures?: () => void;
  onSaveBudgets: (wordBudget: number | null, pageBudget: number | null) => void;
  onSaveDeadline: (deadline: ProjectDeadline | null) => void;
  /** Answers whether the list was saved. */
  onSaveItems: (items: SubmissionItem[]) => Promise<boolean>;
  onOpenFile: (path: string) => void;
  onOpenSource: (url: string) => void;
}) {
  const { t } = useLingui();
  const [wordBudget, setWordBudget] = useState(props.data.wordBudget?.toString() ?? "");
  const [pageBudget, setPageBudget] = useState(props.data.pageBudget?.toString() ?? "");
  const { words, wordBudget: wordLimit, pageBudget: pageLimit, pages: totalPages, body } = props.data;
  // A missing or partial count is never a pass: no meter, no colour, only
  // what was counted and why it cannot settle the limit.
  const wordsEstimated = props.data.wordSource !== "texcount";
  const countedWords = wordsEstimated ? null : words;
  const wordsOk = wordLimit == null || countedWords == null ? null : countedWords <= wordLimit;
  // Without an appendix or references the whole PDF is the main body; with an
  // end SyncTeX has not placed, or before the included files show where the
  // body ends, the total would measure a different scope than the budget.
  const countedPages = totalPages == null
    ? null
    : body.kind === "none" ? totalPages : body.kind === "resolved" ? body.mainPages : null;
  const pagesOk = pageLimit == null || countedPages == null ? null : countedPages <= pageLimit;
  const wordLimitNote = wordLimit == null
    ? null
    : wordLimit === 1 ? t`Limit 1 word` : spaceMixedScript(t({ message: `Limit ${{ wordLimit: formatCount(wordLimit) }} words` }));
  const pageLimitNote = pageLimit == null ? null : pageLimit === 1 ? t`Limit 1 page` : t`Limit ${pageLimit} pages`;
  const notes = (...parts: (string | null)[]) => parts.filter(Boolean).join(" · ") || undefined;
  const wordDetail = words == null
    ? notes(t`Needs a root document to count from`, wordLimitNote)
    : wordsEstimated
      ? notes(t`Root document only, estimated without texcount`, wordLimitNote)
      : undefined;
  const pageDetail = totalPages == null
    ? notes(pageLimitNote)
    : body.kind === "unread"
      ? notes(t`${totalPages} total · included files not read`, pageLimitNote)
      : body.kind === "unresolved"
        ? notes(t`${totalPages} total · end of the body not located in the PDF`, pageLimitNote)
        : body.kind === "resolved" && body.mainPages !== totalPages
          ? t({ message: `${{ totalPages }} total · body ends on p.${{ mainPages: body.mainPages }}` })
          : undefined;
  const wordDistance = (count: number, limit: number) => {
    const gap = Math.abs(limit - count);
    const amount = formatCount(gap);
    if (gap === 0) return t`At the limit`;
    if (count < limit) return gap === 1 ? t`1 word remaining` : spaceMixedScript(t`${amount} words remaining`);
    return gap === 1 ? t`1 word over` : spaceMixedScript(t`${amount} words over`);
  };
  const pageDistance = (count: number, limit: number) => {
    const gap = Math.abs(limit - count);
    if (gap === 0) return t`At the limit`;
    if (count < limit) return gap === 1 ? t`1 page remaining` : t`${gap} pages remaining`;
    return gap === 1 ? t`1 page over` : t`${gap} pages over`;
  };

  // The verdict reads the same results the rows show. A result that cannot be
  // settled (no budget, an unmeasured count, no build yet) never counts as a
  // pass, so "Ready" needs every check to pass, and without a failure the
  // verdict only says that nothing blocks. The writer's own items follow the
  // automatic checks: one still open, or whose file went missing or changed
  // after it was confirmed, needs attention however well the rest passes.
  const checks = [
    wordsOk,
    pagesOk,
    props.data.todos === 0,
    props.data.unusedLabels + props.data.unusedCitations === 0,
    props.data.buildOk,
    ...props.data.items.map((item) => itemPasses(itemCondition(item, props.data.fileStats[item.file ?? ""]))),
  ];
  const failing = checks.filter((check) => check === false).length;
  const passing = checks.filter((check) => check === true).length;
  const unsettled = checks.length - passing - failing;
  const verdict = failing
    ? failing === 1 ? t`1 check needs attention` : t`${failing} checks need attention`
    : unsettled ? t`Nothing blocks submission` : t`Ready to submit`;

  return (
    <ResizableDrawer className="checklist-drawer" onClose={props.onClose}>
        <PanelHeader
          className="drawer-header"
          icon={<ClipboardCheck size={16} />}
          title={t`Submission checklist`}
          onClose={props.onClose}
        />
        <DeadlineCard deadline={props.data.deadline} venue={props.data.venue} onSave={props.onSaveDeadline} />
        <div className="checklist-summary">
          <p className="checklist-verdict">{verdict}</p>
          {/* The track's segments say which checks pass, fail or can't run
              yet; the count at its end is the only figure. */}
          <div className="checklist-progress">
            <span className="checklist-track" aria-hidden="true">
              {checks.map((check, index) => (
                <span key={index} data-state={check == null ? "none" : check ? "ok" : "warn"} />
              ))}
            </span>
            <span className="checklist-progress-count">
              <span aria-hidden="true">{`${passing}/${checks.length}`}</span>
              <span className="sr-only">{t`${passing} of ${checks.length} checks pass`}</span>
            </span>
          </div>
        </div>
        <div className="checklist-rows">
          <BudgetRow
            label={t`Body words`}
            value={words == null
              ? t`Unavailable`
              : wordsEstimated
                ? `≈${formatCount(words)}`
                : `${formatCount(words)}${wordLimit != null ? ` / ${formatCount(wordLimit)}` : ""}`}
            ok={wordsOk}
            meter={countedWords != null && wordLimit != null
              ? { value: countedWords, limit: wordLimit, distance: wordDistance(countedWords, wordLimit) }
              : undefined}
            detail={wordDetail}
          />
          <BudgetRow
            label={totalPages != null && body.kind !== "none" ? t`Main pages` : t`PDF pages`}
            value={totalPages == null
              ? t`Build to count`
              : countedPages == null
                ? t`Unavailable`
                : `${countedPages}${pageLimit != null ? ` / ${pageLimit}` : ""}`}
            ok={pagesOk}
            meter={countedPages != null && pageLimit != null
              ? { value: countedPages, limit: pageLimit, distance: pageDistance(countedPages, pageLimit) }
              : undefined}
            detail={pageDetail}
          />
          <BudgetRow
            label={t`TODOs`}
            value={`${props.data.todos}`}
            ok={props.data.todos === 0}
            onClick={props.onOpenTodos}
          />
          <BudgetRow
            label={t`Unused labels / cites`}
            value={`${props.data.unusedLabels} / ${props.data.unusedCitations}`}
            ok={props.data.unusedLabels + props.data.unusedCitations === 0}
          />
          <BudgetRow
            label={t`Last build`}
            value={props.data.buildOk == null ? t`Not built` : props.data.buildOk ? t`OK` : t`Failed`}
            ok={props.data.buildOk}
            detail={props.data.buildMessage}
          />
        </div>
        <SubmissionItems
          items={props.data.items}
          fileStats={props.data.fileStats}
          filePaths={props.data.filePaths}
          onChange={props.onSaveItems}
          onOpenFile={props.onOpenFile}
          onOpenSource={props.onOpenSource}
        />
        {/* A way into a closer check, not a check of its own: no result mark
            and no segment on the track, only the row's shape and where it leads. */}
        {props.onOpenFigures && (
          <div className="checklist-rows">
            <button type="button" className="checklist-row checklist-link" onClick={props.onOpenFigures}>
              <i className="checklist-status" aria-hidden="true"><Images size={12} /></i>
              <strong>{t`Figure inventory`}</strong>
              <span><ChevronRight size={13} aria-hidden="true" /></span>
            </button>
          </div>
        )}
        {/* Two labelled fields need no visible heading; the name stays for assistive technology. */}
        <section className="checklist-limits" aria-label={t`Word and page limits`}>
          <div className="checklist-budgets">
            {([
              ["word", t`Word budget`, wordBudget, setWordBudget, t`No limit`],
              ["page", t`Page budget`, pageBudget, setPageBudget, t`No limit`],
            ] as const).map(([budgetKey, label, value, setValue, placeholder]) => (
              <label key={budgetKey}>
                {label}
                <Input
                  inputMode="numeric"
                  value={value}
                  placeholder={placeholder}
                  onChange={(event) => setValue(event.target.value)}
                />
              </label>
            ))}
            <button type="button" onClick={() => props.onSaveBudgets(parseBudget(wordBudget), parseBudget(pageBudget))}>
              <Trans>Save budgets</Trans>
            </button>
          </div>
        </section>
    </ResizableDrawer>
  );
}
