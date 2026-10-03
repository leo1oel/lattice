import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { ChevronRight, ClipboardCheck } from "lucide-react";
import { PanelHeader } from "../components/ui/panel-header";
import { Input } from "../components/ui/input";
import { ResizableDrawer } from "../components/ui/resizable-drawer";

export type ManuscriptChecklistData = {
  /** Null when the project has no countable root document. */
  words: number | null;
  wordSource: string;
  wordBudget: number | null;
  pages: number | null;
  /** Main-body pages before `\appendix` when SyncTeX can locate it. */
  mainPages: number | null;
  pageBudget: number | null;
  todos: number;
  unusedLabels: number;
  unusedCitations: number;
  buildOk: boolean | null;
  buildMessage: string;
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
  onSaveBudgets: (wordBudget: number | null, pageBudget: number | null) => void;
}) {
  const { t } = useLingui();
  const [wordBudget, setWordBudget] = useState(props.data.wordBudget?.toString() ?? "");
  const [pageBudget, setPageBudget] = useState(props.data.pageBudget?.toString() ?? "");
  const { words, wordBudget: wordLimit, pageBudget: pageLimit } = props.data;
  // A missing count is never a pass: no meter, no colour, only the gap named.
  const wordsOk = wordLimit == null || words == null ? null : words <= wordLimit;
  const countedPages = props.data.mainPages ?? props.data.pages;
  const pagesOk = pageLimit == null || countedPages == null
    ? null
    : countedPages <= pageLimit;
  const totalPages = props.data.pages;
  const mainPages = props.data.mainPages;
  const pageDetail = totalPages == null
    ? pageLimit == null ? undefined : pageLimit === 1 ? t`Limit 1 page` : t`Limit ${pageLimit} pages`
    : mainPages != null && mainPages !== totalPages
      ? t`${totalPages} total · appendix after p.${mainPages}`
      : mainPages == null
        ? t`venue limit usually excludes appendix`
        : undefined;
  const wordDistance = (count: number, limit: number) => {
    const gap = Math.abs(limit - count);
    const amount = gap.toLocaleString();
    if (gap === 0) return t`At the limit`;
    if (count < limit) return gap === 1 ? t`1 word remaining` : t`${amount} words remaining`;
    return gap === 1 ? t`1 word over` : t`${amount} words over`;
  };
  const pageDistance = (count: number, limit: number) => {
    const gap = Math.abs(limit - count);
    if (gap === 0) return t`At the limit`;
    if (count < limit) return gap === 1 ? t`1 page remaining` : t`${gap} pages remaining`;
    return gap === 1 ? t`1 page over` : t`${gap} pages over`;
  };

  return (
    <ResizableDrawer className="checklist-drawer" onClose={props.onClose}>
        <PanelHeader
          className="drawer-header"
          icon={<ClipboardCheck size={16} />}
          title={t`Submission checklist`}
          onClose={props.onClose}
        />
        <div className="checklist-rows">
          <BudgetRow
            label={t`Body words`}
            value={words == null
              ? t`Unavailable`
              : `${words.toLocaleString()}${wordLimit != null ? ` / ${wordLimit.toLocaleString()}` : ""}`}
            ok={wordsOk}
            meter={words != null && wordLimit != null
              ? { value: words, limit: wordLimit, distance: wordDistance(words, wordLimit) }
              : undefined}
            detail={words == null
              ? t`Needs a root document to count from`
              : props.data.wordSource === "texcount" ? t`via texcount -inc` : t`local estimate`}
          />
          <BudgetRow
            label={props.data.mainPages != null ? t`Main pages` : t`PDF pages`}
            value={countedPages == null
              ? t`Build to count`
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
        <div className="checklist-budgets">
          {([
            ["word", t`Word budget`, wordBudget, setWordBudget, t`e.g. 5500`],
            ["page", t`Page budget`, pageBudget, setPageBudget, t`e.g. 9`],
          ] as const).map(([budgetKey, label, value, setValue, placeholder]) => (
            <label key={budgetKey}>
              {label}
              <Input
                controlSize="compact"
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
    </ResizableDrawer>
  );
}
