import { useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { PanelHeader } from "./components/ui/panel-header";
import { Input } from "./components/ui/input";
import { ResizableDrawer } from "./resizable-drawer";

export type ManuscriptChecklistData = {
  words: number;
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

function BudgetRow(props: {
  label: string;
  value: string;
  ok: boolean | null;
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
      <span>{props.value}</span>
      {props.detail ? <small>{props.detail}</small> : null}
    </Tag>
  );
}

export function ManuscriptChecklistPanel(props: {
  data: ManuscriptChecklistData;
  onClose: () => void;
  onOpenTodos: () => void;
  onSaveBudgets: (wordBudget: number | null, pageBudget: number | null) => void;
}) {
  const [wordBudget, setWordBudget] = useState(props.data.wordBudget?.toString() ?? "");
  const [pageBudget, setPageBudget] = useState(props.data.pageBudget?.toString() ?? "");
  const wordsOk = props.data.wordBudget == null ? null : props.data.words <= props.data.wordBudget;
  const countedPages = props.data.mainPages ?? props.data.pages;
  const pagesOk = props.data.pageBudget == null || countedPages == null
    ? null
    : countedPages <= props.data.pageBudget;
  const pageDetail = props.data.pages == null
    ? undefined
    : props.data.mainPages != null && props.data.mainPages !== props.data.pages
      ? `${props.data.pages} total · appendix after p.${props.data.mainPages}`
      : props.data.mainPages == null
        ? "venue limit usually excludes appendix"
        : undefined;

  return (
    <ResizableDrawer className="checklist-drawer" onClose={props.onClose}>
        <PanelHeader
          className="drawer-header"
          icon={<ClipboardCheck size={16} />}
          title="Submission checklist"
          onClose={props.onClose}
        />
        <p className="drawer-copy">
          Body words use TeXcount when installed (else a local estimate). Set budgets for your venue page/word limits.
        </p>
        <div className="checklist-rows">
          <BudgetRow
            label="Body words"
            value={`${props.data.words.toLocaleString()}${props.data.wordBudget != null ? ` / ${props.data.wordBudget.toLocaleString()}` : ""}`}
            ok={wordsOk}
            detail={props.data.wordSource === "texcount" ? "via texcount -inc" : "local estimate"}
          />
          <BudgetRow
            label={props.data.mainPages != null ? "Main pages" : "PDF pages"}
            value={countedPages == null
              ? "Build to count"
              : `${countedPages}${props.data.pageBudget != null ? ` / ${props.data.pageBudget}` : ""}`}
            ok={pagesOk}
            detail={pageDetail}
          />
          <BudgetRow
            label="TODOs"
            value={`${props.data.todos}`}
            ok={props.data.todos === 0}
            onClick={props.onOpenTodos}
          />
          <BudgetRow
            label="Unused labels / cites"
            value={`${props.data.unusedLabels} / ${props.data.unusedCitations}`}
            ok={props.data.unusedLabels + props.data.unusedCitations === 0}
          />
          <BudgetRow
            label="Last build"
            value={props.data.buildOk == null ? "Not built" : props.data.buildOk ? "OK" : "Failed"}
            ok={props.data.buildOk}
            detail={props.data.buildMessage}
          />
        </div>
        <div className="checklist-budgets">
          <label>
            Word budget
            <Input
              controlSize="compact"
              inputMode="numeric"
              value={wordBudget}
              placeholder="e.g. 5500"
              onChange={(event) => setWordBudget(event.target.value)}
            />
          </label>
          <label>
            Page budget
            <Input
              controlSize="compact"
              inputMode="numeric"
              value={pageBudget}
              placeholder="e.g. 9"
              onChange={(event) => setPageBudget(event.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              const words = wordBudget.trim() ? Number(wordBudget) : null;
              const pages = pageBudget.trim() ? Number(pageBudget) : null;
              props.onSaveBudgets(
                words != null && Number.isFinite(words) ? Math.max(0, Math.floor(words)) : null,
                pages != null && Number.isFinite(pages) ? Math.max(0, Math.floor(pages)) : null,
              );
            }}
          >
            Save budgets
          </button>
        </div>
    </ResizableDrawer>
  );
}
