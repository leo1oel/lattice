/**
 * The Build button's card: the build as the sequence it was, pass by pass.
 *
 * Every row is a pass latexmk really ran, in its order and with its own time
 * (`src-tauri/src/latex/build_steps.rs` reads them off latexmk's output): a
 * second pdflatex for references, biber in place of bibtex, xdvipdfmx after
 * XeLaTeX, the prewarm's draft passes on a cold build, or none at all when the
 * PDF was already up to date. SyncTeX is not a pass of its own (the engine
 * writes it during its last run), so its row says whether the map came with
 * the PDF rather than timing it. While a build runs the card fills in as each
 * pass starts, and the pass still running counts its own time.
 *
 * The card is a hover card: what it says is also the button's accessible
 * description, and its one action (the first problem) is F8 and the
 * diagnostics bar's too.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, ChevronRight, Minus, X } from "lucide-react";
import type { BuildStep } from "../app-types";
import type { BuildOutcome, BuildProgressStore } from "../app/use-build-pipeline";
import { InfinityLoader } from "../components/ui/activity-icons";
import { diagnosticCountsText } from "../build/build-result-text";

const ENGINES = new Set(["pdflatex", "xelatex", "lualatex", "latex", "platex", "uplatex"]);
const BIBLIOGRAPHY = new Set(["bibtex", "bibtex8", "bibtexu", "pbibtex", "upbibtex", "biber"]);
const INDEX = new Set(["makeindex", "mendex", "upmendex", "xindy", "texindy"]);
const PDF_OUTPUT = new Set(["xdvipdfmx", "dvipdfmx", "dvipdfm", "dvipdf", "ps2pdf"]);

/** "0.6s"; a pass too quick to show a tenth still took some time. */
function seconds(ms: number): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a duration, in the unit the Build button writes its time in
  return ms < 50 ? "<0.1s" : `${(ms / 1000).toFixed(1)}s`;
}

/** `performance.now()`, every tenth of a second while `on`. */
function useTicking(on: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setNow(performance.now()), 100);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

type StepState = "done" | "running" | "failed" | "warning" | "none";

function StepMark({ state }: { state: StepState }) {
  return (
    <i className="build-sequence-mark" data-state={state} aria-hidden="true">
      {state === "running" ? <InfinityLoader size={14} />
        : state === "done" ? <Check size={11} />
          : state === "failed" ? <X size={11} />
            : state === "warning" ? (
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                <path d="M12 5v9M12 19h.01" />
              </svg>
            ) : <Minus size={11} />}
    </i>
  );
}

const noSubscription = () => () => {};
const noProgress = () => null;

export function BuildSequence({ building, progress: progressStore, outcome, place, idle, hint, onProblem }: {
  building: boolean;
  progress: BuildProgressStore | null;
  outcome: BuildOutcome | null;
  /** The document it compiled and how long ago, when it has finished. */
  place: string | null;
  /** What the button does, said before there is any build to show. */
  idle: string;
  hint: string;
  onProblem: () => void;
}) {
  const { t } = useLingui();
  const live = useSyncExternalStore(progressStore?.subscribe ?? noSubscription, progressStore?.get ?? noProgress);
  const progress = building ? live : null;
  const now = useTicking(building);
  if (!building && !outcome) {
    return (
      <div className="build-sequence" data-idle="">
        <strong className="build-sequence-idle">{idle}</strong>
        <div className="build-sequence-hint">{hint}</div>
      </div>
    );
  }
  const elapsed = building ? Math.max(0, now - (progress?.startedAt ?? now)) : null;
  const steps = (building ? progress?.steps : outcome?.steps) ?? [];
  const lasted = (step: BuildStep) => step.durationMs ?? Math.max(0, (elapsed ?? 0) - step.startedMs);
  const failed = !building && outcome?.status === "failed";
  // latexmk halts on the first error, so a failed build stopped in its last real pass.
  const failedAt = failed ? steps.reduce((at, step, index) => step.draft ? at : index, -1) : -1;
  const stateOf = (step: BuildStep, index: number): StepState =>
    step.durationMs === null ? "running" : index === failedAt ? "failed" : "done";
  const last = steps.at(-1);
  const totalMs = elapsed ?? (outcome?.status === "succeeded" ? outcome.seconds * 1000
    : last ? last.startedMs + lasted(last) : null);
  const pages = !building && outcome?.pages ? outcome.pages === 1 ? t`1 page` : t`${outcome.pages} pages` : null;
  const facts = [pages, totalMs === null ? null : seconds(totalMs)].filter(Boolean).join(" · ");

  /** What a pass did, beside its program's name. */
  const role = ({ tool, run, draft }: BuildStep): string | null => {
    if (draft) return t`draft pass ${run}`;
    if (ENGINES.has(tool)) return t`pass ${run}`;
    if (BIBLIOGRAPHY.has(tool)) return t`bibliography`;
    if (INDEX.has(tool)) return t`index`;
    if (tool === "makeglossaries") return t`glossary`;
    if (PDF_OUTPUT.has(tool)) return t`PDF output`;
    if (tool === "dvips") return t`PostScript output`;
    return run > 1 ? t`run ${run}` : null;
  };
  const total = steps.reduce((sum, step) => sum + lasted(step), 0);
  const issue = !building ? outcome?.issue ?? null : null;
  const where = issue?.file ? [issue.file.split("/").pop(), issue.line].filter(Boolean).join(":") : null;

  return (
    <div className="build-sequence" data-building={building || undefined}>
      <div className="build-sequence-head">
        <strong className="build-sequence-verdict">{building ? t`Building…` : failed ? t`Build failed` : t`Built`}</strong>
        {facts && <span className="build-sequence-facts">{facts}</span>}
        {place && <span className="build-sequence-place">{place}</span>}
      </div>
      {steps.length > 0 && (
        <div className="build-sequence-track" aria-hidden="true">
          {steps.map((step, index) => (
            <span
              key={index}
              data-state={stateOf(step, index)}
              data-draft={step.draft || undefined}
              // Every pass keeps a sliver, so a quick bibtex between two
              // pdflatex runs still shows as its own segment.
              style={{ flexGrow: Math.max(lasted(step), total * 0.03) }}
            />
          ))}
        </div>
      )}
      <ol className="build-sequence-steps">
        {steps.map((step, index) => {
          const state = stateOf(step, index);
          const what = role(step);
          return (
            <li key={index} data-state={state}>
              <StepMark state={state} />
              <span className="build-sequence-step">
                <span className="build-sequence-tool">{step.tool}</span>
                {what && <span className="build-sequence-role">{what}</span>}
              </span>
              <span className="build-sequence-time">{seconds(lasted(step))}</span>
            </li>
          );
        })}
        {building && steps.length === 0 && (
          <li data-state="running">
            <StepMark state="running" />
            <span className="build-sequence-step">
              <span className="build-sequence-tool">latexmk</span>
              <span className="build-sequence-role">{t`starting`}</span>
            </span>
          </li>
        )}
        {!building && outcome?.status === "succeeded" && steps.length === 0 && (
          <li data-state="none">
            <StepMark state="none" />
            <span className="build-sequence-step">
              <span className="build-sequence-tool">{t`Nothing to rerun`}</span>
              <span className="build-sequence-role">{t`the PDF was already up to date`}</span>
            </span>
          </li>
        )}
        {/* A failed build's PDF, and its map, are the previous build's. */}
        {!building && outcome?.status === "succeeded" && outcome.synctex != null && (
          <li data-state={outcome.synctex ? "done" : "none"}>
            <StepMark state={outcome.synctex ? "done" : "none"} />
            <span className="build-sequence-step">
              {/* eslint-disable-next-line lingui/no-unlocalized-strings -- a product name */}
              <span className="build-sequence-tool">SyncTeX</span>
              <span className="build-sequence-role">{outcome.synctex ? t`source ↔ PDF` : t`not written`}</span>
            </span>
          </li>
        )}
      </ol>
      {issue && outcome && (
        <button type="button" className="build-sequence-issue" data-level={issue.level} onClick={onProblem}>
          <StepMark state={issue.level === "error" ? "failed" : "warning"} />
          <span className="build-sequence-step">
            <span className="build-sequence-tool">{diagnosticCountsText({ ...outcome.counts, info: 0 })}</span>
            <span className="build-sequence-role">
              <span className="build-sequence-message">{issue.message}</span>
              {where && <span className="build-sequence-where">{where}</span>}
            </span>
          </span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
      <div className="build-sequence-hint">{hint}</div>
    </div>
  );
}
