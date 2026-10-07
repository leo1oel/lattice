import { Suspense, useMemo } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, Lock, SpellCheck, WandSparkles, X } from "lucide-react";
import type { ProofreadMode } from "../agent/agent-proofread";
import {
  applyProofreadEdits,
  chosenEdits,
  proofreadEditPreview,
  type ProofreadEdit,
  type ProofreadReview,
} from "../agent/proofread-edits";
import type { ProtectedKind } from "../editor/latex/latex-protected";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { IconButton } from "../components/ui/icon-button";
import { InlineMessage } from "../components/ui/inline-message";
import { SegmentedControl } from "../components/ui/segmented-control";
import { ProofreadDiff } from "./canvas-lazy-editors";

export type ProofreadCardState =
  | { status: "loading" }
  | {
    status: "ready";
    review: ProofreadReview;
    /** Ids of the offered edits the writer turned down; every other one is applied. */
    rejected: ReadonlySet<number>;
    /** The model that answered, once the runtime reports one. */
    model?: string;
  }
  | { status: "error"; message: string; retryable: boolean };

/**
 * The inline proofread under the selected source: the agent's suggestion
 * split into edits the writer accepts or rejects one by one, the chosen
 * result as a word-level diff against the original, and the edits Lattice
 * held back because they would have changed protected LaTeX.
 */
export function ProofreadCard(props: {
  path: string;
  original: string;
  mode: ProofreadMode;
  state: ProofreadCardState;
  editable: boolean;
  onAccept: () => void;
  onAcceptAll: () => void;
  onDismiss: () => void;
  onRetry: () => void;
  onMode: (mode: ProofreadMode) => void;
  onChoose: (id: number, accepted: boolean) => void;
}) {
  const { t } = useLingui();
  const { mode, original, state } = props;
  const ready = state.status === "ready" ? state : null;
  const offered = ready?.review.edits.length ?? 0;
  const held = ready?.review.held ?? [];
  const chosen = useMemo(() => ready ? chosenEdits(ready.review, ready.rejected) : [], [ready]);
  const kept = chosen.length;
  const result = useMemo(() => applyProofreadEdits(original, chosen), [chosen, original]);
  const polishing = mode === "polish";
  const summary = state.status === "loading" ? polishing ? t`Polishing…` : t`Proofreading…`
    : state.status === "error" ? polishing ? t`Could not polish` : t`Could not proofread`
      : offered === 0 ? held.length ? t`No safe edits` : t`No changes suggested`
        : offered === 1 ? t`1 suggested edit` : t`${offered} suggested edits`;
  const Icon = polishing ? WandSparkles : SpellCheck;
  return (
    <div
      className="proofread-card"
      role="group"
      aria-label={polishing ? t`Polish suggestion` : t`Proofread suggestion`}
      aria-busy={state.status === "loading"}
      data-status={state.status}
      data-mode={mode}
    >
      <div className="proofread-card-header">
        {state.status === "loading" ? <InfinityLoader size={14} /> : <Icon size={14} strokeWidth={1.8} aria-hidden />}
        <SegmentedControl
          value={mode}
          onChange={(next) => {
            if (next !== mode) props.onMode(next);
          }}
          items={[
            { value: "proofread", label: t`Proofread`, title: t`Correct grammar, spelling and punctuation only` },
            { value: "polish", label: t`Polish`, title: t`Also improve flow and academic clarity` },
          ]}
          ariaLabel={t`Editing strength`}
          className="proofread-card-mode"
        />
        <span className="proofread-card-summary" role="status">
          {summary}
          {ready?.model && <span className="proofread-card-model" title={t`Model`}>{ready.model}</span>}
        </span>
      </div>
      {offered > 0 && (
        <div className="proofread-card-diff">
          {result === original ? (
            <p className="proofread-card-note proofread-card-diff-empty">{t`No edits selected. The selection stays as written.`}</p>
          ) : (
            <Suspense fallback={<p className="proofread-card-note" role="status"><InfinityLoader size={12} /> {t`Rendering diff…`}</p>}>
              <ProofreadDiff path={props.path} before={original} after={result} />
            </Suspense>
          )}
        </div>
      )}
      {ready && offered > 1 && (
        <ul className="proofread-card-edits" aria-label={t`Suggested edits`}>
          {ready.review.edits.map((edit) => {
            const accepted = !ready.rejected.has(edit.id);
            return (
              <li key={edit.id} className="proofread-edit" data-accepted={accepted}>
                <EditPreview original={original} edit={edit} />
                <span className="proofread-edit-choice">
                  <IconButton size="compact" label={t`Reject this edit`} aria-pressed={!accepted} onClick={() => props.onChoose(edit.id, false)}>
                    <X aria-hidden />
                  </IconButton>
                  <IconButton size="compact" label={t`Accept this edit`} aria-pressed={accepted} onClick={() => props.onChoose(edit.id, true)}>
                    <Check aria-hidden />
                  </IconButton>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {held.length > 0 && (
        <div className="proofread-card-held">
          <HeldNotice count={held.length} kinds={[...new Set(held.map((edit) => edit.kind))]} />
          <ul className="proofread-card-edits" aria-label={t`Edits held back`}>
            {held.map((edit) => (
              <li key={edit.id} className="proofread-edit" data-held>
                <EditPreview original={original} edit={edit} />
                <Lock size={12} strokeWidth={1.8} className="proofread-edit-lock" aria-label={t`Not offered`} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {state.status === "loading" && (
        <p className="proofread-card-note">
          {polishing
            ? t`The agent is improving flow and clarity. Math, citations, comments and LaTeX commands must stay as written; Lattice holds back any edit that changes them.`
            : t`The agent is correcting grammar, spelling and punctuation. Math, citations, comments and LaTeX commands must stay as written; Lattice holds back any edit that changes them.`}
        </p>
      )}
      {ready && offered === 0 && !held.length && (
        <p className="proofread-card-note">{polishing ? t`The selection already reads well.` : t`The selection already reads cleanly.`}</p>
      )}
      {state.status === "error" && <InlineMessage level="error" className="proofread-card-error">{state.message}</InlineMessage>}
      <div className="proofread-card-actions">
        {offered > 0 ? (
          <>
            <Button size="compact" variant="ghost" onClick={props.onDismiss}>
              {offered === 1 ? t`Reject` : t`Reject all`} <kbd>esc</kbd>
            </Button>
            {chosen.length < offered && (
              <Button size="compact" disabled={!props.editable} onClick={props.onAcceptAll}>{t`Accept all`}</Button>
            )}
            <Button size="compact" variant="primary" disabled={!props.editable || chosen.length === 0} onClick={props.onAccept}>
              {offered === 1 ? t`Accept` : chosen.length === offered ? t`Accept all` : t`Accept ${kept} of ${offered}`} <kbd>⌘↵</kbd>
            </Button>
          </>
        ) : state.status === "error" ? (
          <>
            <Button size="compact" variant="ghost" onClick={props.onDismiss}>{t`Dismiss`}</Button>
            {state.retryable && <Button size="compact" onClick={props.onRetry}>{t`Try again`}</Button>}
          </>
        ) : (
          <Button size="compact" variant="ghost" onClick={props.onDismiss}>
            {state.status === "loading" ? t`Cancel` : t`Done`} <kbd>esc</kbd>
          </Button>
        )}
      </div>
    </div>
  );
}

/** One edit in a line of its own context: what it removes struck through, what it adds after. */
function EditPreview(props: { original: string; edit: ProofreadEdit }) {
  const { before, deleted, inserted, after } = proofreadEditPreview(props.original, props.edit);
  return (
    <span className="proofread-edit-preview">
      {before && <span className="proofread-edit-context">{before}</span>}
      {deleted && <del>{deleted}</del>}
      {inserted && <ins>{inserted}</ins>}
      {after && <span className="proofread-edit-context">{after}</span>}
    </span>
  );
}

/** Why some of the suggestion is not offered, naming what those edits would have changed. */
function HeldNotice(props: { count: number; kinds: ProtectedKind[] }) {
  const { t } = useLingui();
  const names: Record<ProtectedKind, string> = {
    math: t`math`,
    reference: t`citations or references`,
    comment: t`comments`,
    command: t`LaTeX commands`,
    environment: t`environments`,
    verbatim: t`verbatim code`,
    paragraph: t`paragraph breaks`,
  };
  const changed = props.kinds.map((kind) => names[kind]).join(", ");
  const { count } = props;
  return (
    <InlineMessage level="warning">
      {count === 1
        ? t`Held back 1 edit that would change ${changed}. Lattice only offers edits that leave LaTeX intact.`
        : t`Held back ${count} edits that would change ${changed}. Lattice only offers edits that leave LaTeX intact.`}
    </InlineMessage>
  );
}
