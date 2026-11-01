import { useMemo, type KeyboardEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import type { ProofreadAsk, ProofreadCategory, ProofreadMode } from "../agent/agent-proofread";
import { chosenEdits, type ProofreadReview } from "../agent/proofread-edits";
import { comboText, parseKeyName } from "../app/key-combos";
import type { ProtectedKind } from "../editor/latex/latex-protected";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { InlineEdits, type InlineEdit } from "../components/ui/inline-edits";
import { InlineMessage } from "../components/ui/inline-message";
import { SegmentedControl } from "../components/ui/segmented-control";

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

/* eslint-disable lingui/no-unlocalized-strings -- key names, drawn as glyphs */
const ACCEPT_KEYS = comboText(parseKeyName("Mod-Enter"));
const DISMISS_KEYS = comboText(parseKeyName("Escape"));
/* eslint-enable lingui/no-unlocalized-strings */

/**
 * The inline proofread under the selected source: the selection read in
 * place as one paragraph, each of the agent's edits struck and inserted with
 * the reason it gave. Clicking an edit keeps the original; ⌘↩ applies the
 * edits still made and Esc discards them all. Edits Lattice held back,
 * because they would have changed protected LaTeX, show where they were,
 * locked. A rewrite by the writer's own instruction shows that instruction
 * where the strength switch would be.
 */
export function ProofreadCard(props: {
  original: string;
  ask: ProofreadAsk;
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
  const { ask, original, state } = props;
  const instruction = typeof ask === "string" ? null : ask.instruction;
  const ready = state.status === "ready" ? state : null;
  const offered = ready?.review.edits.length ?? 0;
  const held = ready?.review.held ?? [];
  const kept = useMemo(() => ready ? chosenEdits(ready.review, ready.rejected).length : 0, [ready]);
  const categories = useMemo((): Record<ProofreadCategory, string> => ({
    spelling: t`spelling`,
    grammar: t`grammar`,
    punctuation: t`punctuation`,
    "word choice": t`word choice`,
    clarity: t`clarity`,
    concision: t`concision`,
    flow: t`flow`,
    consistency: t`consistency`,
    translation: t`translation`,
  }), [t]);
  // A held edit's tag names what it would have changed, in a word.
  const heldTags = useMemo((): Record<ProtectedKind, string> => ({
    math: t`math`,
    reference: t`citation`,
    comment: t`% comment`,
    command: t`command`,
    environment: t`environment`,
    verbatim: t`verbatim`,
    paragraph: t`paragraph break`,
  }), [t]);
  // That an edit is a choice is said in its own tooltip, after its reason,
  // rather than as a hint line beside the answers.
  const keepHint = t`Click to keep the original`;
  const edits = useMemo((): InlineEdit[] => ready ? [
    ...ready.review.edits.map((edit): InlineEdit => {
      const status = ready.rejected.has(edit.id) ? "kept" : "applied";
      const note = edit.reason?.note || undefined;
      return {
        ...edit,
        status,
        tag: edit.reason?.category ? categories[edit.reason.category] : undefined,
        detail: status === "applied" ? [note, keepHint].filter(Boolean).join(" · ") : note,
      };
    }),
    ...heldRuns(original, ready.review).map((edit): InlineEdit => ({ ...edit, status: "held", tag: heldTags[edit.kind] })),
  ] : [], [categories, heldTags, keepHint, original, ready]);
  const polishing = ask === "polish";
  const summary = state.status === "loading" ? instruction !== null ? t`Rewriting…` : polishing ? t`Polishing…` : t`Proofreading…`
    : state.status === "error" ? instruction !== null ? t`Could not rewrite` : polishing ? t`Could not polish` : t`Could not proofread`
      : offered === 0 ? held.length ? t`No safe edits` : t`No changes suggested`
        : offered === 1 ? t`1 edit` : t`${offered} edits`;
  // Focus inside the card (an edit reached with Tab) is out of the editor's
  // keymap, which the card's widget ignores, so the card answers the keys too.
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      event.preventDefault();
      if (offered > 0) props.onAccept();
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onDismiss();
    }
  };
  return (
    <div
      className="proofread-card"
      role="group"
      aria-label={instruction !== null ? t`Rewrite suggestion` : polishing ? t`Polish suggestion` : t`Proofread suggestion`}
      aria-busy={state.status === "loading"}
      data-status={state.status}
      data-mode={instruction !== null ? "custom" : ask}
      onKeyDown={onKeyDown}
    >
      <div className="proofread-card-header">
        {typeof ask === "string" ? (
          <SegmentedControl
            value={ask}
            onChange={(next) => {
              if (next !== ask) props.onMode(next);
            }}
            items={[
              { value: "proofread", label: t`Proofread` },
              { value: "polish", label: t`Polish` },
            ]}
            ariaLabel={t`Editing strength`}
            className="proofread-card-mode"
          />
        ) : (
          <span className="proofread-card-instruction" title={ask.instruction}>{ask.instruction}</span>
        )}
        <span className="proofread-card-summary" role="status">
          {state.status === "loading" && <InfinityLoader size={12} />}
          <span className="proofread-card-summary-text">{summary}</span>
          {ready?.model && <span className="proofread-card-model">{ready.model}</span>}
        </span>
      </div>
      {edits.length > 0 && (
        <InlineEdits
          className="proofread-card-text"
          text={original}
          edits={edits}
          onToggle={(id) => props.onChoose(id, ready?.rejected.has(id) ?? false)}
        />
      )}
      {held.length > 0 && <HeldNotice count={held.length} kinds={[...new Set(held.map((edit) => edit.kind))]} />}
      {state.status === "error" && <InlineMessage level="error" className="proofread-card-error">{state.message}</InlineMessage>}
      <div className="proofread-card-actions">
        {offered > 0 ? (
          <>
            <Button size="compact" variant="tinted" disabled={!props.editable || kept === 0} onClick={props.onAccept}>
              {offered === 1 ? t`Accept` : kept === offered ? t`Accept all` : t`Accept ${kept} of ${offered}`}
              <kbd>{ACCEPT_KEYS}</kbd>
            </Button>
            {kept < offered && offered > 1 && (
              <Button size="compact" variant="ghost" disabled={!props.editable} onClick={props.onAcceptAll}>{t`Accept all`}</Button>
            )}
            <Button size="compact" variant="ghost" onClick={props.onDismiss}>
              {t`Discard`} <kbd>{DISMISS_KEYS}</kbd>
            </Button>
          </>
        ) : state.status === "error" ? (
          <>
            {state.retryable && <Button size="compact" variant="tinted" onClick={props.onRetry}>{t`Try again`}</Button>}
            <Button size="compact" variant="ghost" onClick={props.onDismiss}>{t`Dismiss`} <kbd>{DISMISS_KEYS}</kbd></Button>
          </>
        ) : (
          <Button size="compact" variant="ghost" onClick={props.onDismiss}>
            {state.status === "loading" ? t`Cancel` : t`Done`} <kbd>{DISMISS_KEYS}</kbd>
          </Button>
        )}
      </div>
    </div>
  );
}

/** How far apart two held edits of one kind may be and still read as one. */
const HELD_RUN_GAP = 24;

/**
 * The held edits as the paragraph shows them: a construct the agent changed
 * in two places (`$q k$` → `$\hat{q k}$`) is one locked span with one tag,
 * not a tag on each end. Held edits never show their insertion, so joining
 * them changes nothing but the drawing.
 */
function heldRuns(original: string, review: ProofreadReview) {
  const runs: Array<{ id: number; from: number; to: number; insert: string; kind: ProtectedKind }> = [];
  for (const edit of [...review.held].sort((left, right) => left.from - right.from)) {
    const last = runs.at(-1);
    const gap = last ? original.slice(last.to, edit.from) : "";
    const offeredBetween = last && review.edits.some((offered) => offered.from >= last.to && offered.to <= edit.from);
    if (last && last.kind === edit.kind && !offeredBetween && gap.length <= HELD_RUN_GAP && !gap.includes("\n")) {
      runs[runs.length - 1] = { ...last, to: edit.to, insert: last.insert + gap + edit.insert };
    } else {
      runs.push({ id: edit.id, from: edit.from, to: edit.to, insert: edit.insert, kind: edit.kind });
    }
  }
  return runs;
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
    <InlineMessage level="warning" className="proofread-card-held">
      {count === 1
        ? t`Held back 1 edit that would change ${changed}`
        : t`Held back ${count} edits that would change ${changed}`}
    </InlineMessage>
  );
}
