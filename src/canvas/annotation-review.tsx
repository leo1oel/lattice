import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useLingui } from "@lingui/react/macro";
import { isolateHistory } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { ArrowDown, RotateCcw } from "lucide-react";
import {
  applyProofreadEdits,
  chosenEdits,
  proofreadContext,
  reviewProofread,
  type ProofreadContext,
  type ProofreadReview,
} from "../agent/proofread-edits";
import { comboText, parseKeyName } from "../app/key-combos";
import { showWarning } from "../app/notify";
import { pendingProposals, type AcceptedRevision, type AnnotationRounds } from "../app/annotation-rounds";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { InlineEdits, type InlineEdit } from "../components/ui/inline-edits";
import { InlineMessage } from "../components/ui/inline-message";
import { Textarea } from "../components/ui/textarea";
import { annotationReviewAnchor, setAnnotationReviewEffect } from "../editor/annotation-review-anchor";
import { AnnotationPin } from "../editor/comments/annotation-pin";
import { resolveCommentAnchor, type EditorComment } from "../editor/comments/editor-comment-data";
import type { ProtectedKind } from "../editor/latex/latex-protected";
import { useLatestRef } from "../hooks/use-latest-ref";
import type { AnnotationReviewBridge } from "./annotation-review-bridge";

/* eslint-disable lingui/no-unlocalized-strings -- key names, drawn as glyphs */
const ACCEPT_KEYS = comboText(parseKeyName("Mod-Enter"));
const REJECT_KEYS = comboText(parseKeyName("Backspace"));
/* eslint-enable lingui/no-unlocalized-strings */

export type AnnotationReviewProps = {
  bridge: AnnotationReviewBridge;
  activeFile: string;
  /** Changes whenever the editor is rebuilt, which drops the card's widget. */
  editorKey: string;
  editable: boolean;
  viewRef: RefObject<EditorView | null>;
  /** Every annotation; the card follows the one under review as it changes. */
  annotations: readonly EditorComment[];
  rounds: AnnotationRounds;
};

/**
 * Reviewing the agent's proposal for one annotation, in place: a card under
 * the annotated passage, read like Proofread's (`InlineEdits`), with the
 * note it answers and the agent's reason. Accept writes the edits still
 * chosen as one undo step; Reject keeps the passage; Try again asks for
 * another with what the writer wants instead; ↓ moves to the next proposal.
 *
 * Only a subscription until a review is asked for: the canvas renders often,
 * and the review's state and effects would otherwise run on every render for
 * a card most sessions never open.
 */
export const AnnotationReviewLayer = memo(function AnnotationReviewLayer(props: AnnotationReviewProps) {
  const { rounds } = props;
  const request = useSyncExternalStore(rounds.subscribe, () => rounds.getSnapshot().review);
  return request ? <AnnotationReviewSession {...props} request={request} /> : null;
});

function AnnotationReviewSession(props: AnnotationReviewProps & { request: { id: string; nonce: string } }) {
  const { t } = useLingui();
  const { bridge, request, rounds, viewRef } = props;
  const running = useSyncExternalStore(rounds.subscribe, () => rounds.getSnapshot().running);
  const proposals = useMemo(() => pendingProposals(props.annotations), [props.annotations]);
  /** The card on screen: its annotation, the element it renders into, and the LaTeX around its passage. */
  const [open, setOpen] = useState<{ id: string; host: HTMLElement; context: ProofreadContext } | null>(null);
  const openRef = useLatestRef(open);
  const propsRef = useLatestRef(props);

  const close = useMemo(() => () => {
    const view = viewRef.current;
    if (view && annotationReviewAnchor(view.state)) view.dispatch({ effects: setAnnotationReviewEffect.of(null) });
    setOpen(null);
  }, [viewRef]);
  // The review ended: its card leaves the editor.
  useLayoutEffect(() => () => {
    const view = viewRef.current;
    if (view && annotationReviewAnchor(view.state)) view.dispatch({ effects: setAnnotationReviewEffect.of(null) });
  }, [viewRef]);

  // A rebuilt editor (another file, a reload) has lost the card's widget.
  useLayoutEffect(() => {
    const current = openRef.current;
    const view = viewRef.current;
    if (current && (!view || annotationReviewAnchor(view.state)?.host !== current.host)) setOpen(null);
  }, [openRef, props.activeFile, props.editorKey, viewRef]);

  // A request names an annotation to review: place its card under the passage,
  // once its file is the one in the editor.
  const handledRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (handledRef.current === request.nonce) return;
    const { activeFile, annotations } = propsRef.current;
    const annotation = annotations.find((item) => item.id === request.id);
    const view = viewRef.current;
    if (!annotation || !view || annotation.path !== activeFile) return;
    handledRef.current = request.nonce;
    const range = resolveCommentAnchor(view.state.doc.toString(), annotation);
    if (!range) {
      close();
      showWarning(t`The annotated passage changed or moved, so its proposal cannot be placed. Ask the agent again from the Annotations panel.`);
      return;
    }
    const host = document.createElement("div");
    host.className = "annotation-review-host";
    view.dispatch({
      effects: [
        setAnnotationReviewEffect.of({ id: annotation.id, from: range.from, to: range.to, host }),
        // Center the passage; the card under it follows into view.
        EditorView.scrollIntoView(range.from, { y: "center" }),
      ],
    });
    setOpen({ id: annotation.id, host, context: proofreadContext(view.state.doc.toString(), range.from, range.to) });
  }, [close, props.activeFile, props.editorKey, propsRef, request, t, viewRef]);

  useLayoutEffect(() => bridge.connect({
    accept: () => {
      const card = openRef.current?.host.querySelector<HTMLElement>("[data-annotation-accept]");
      if (!card || (card as HTMLButtonElement).disabled) return false;
      card.click();
      return true;
    },
    dismiss: () => {
      if (!openRef.current) return false;
      rounds.closeReview();
      viewRef.current?.focus();
      return true;
    },
  }), [bridge, openRef, rounds, viewRef]);

  const annotation = open ? props.annotations.find((item) => item.id === open.id) : undefined;
  return open && annotation ? createPortal(
    <AnnotationReviewCard
      key={`${annotation.id}:${annotation.revision?.round ?? 0}:${annotation.revision?.text ?? annotation.revision?.state ?? ""}`}
      annotation={annotation}
      context={open.context}
      viewRef={viewRef}
      editable={props.editable}
      running={running.has(annotation.id)}
      position={proposals.findIndex((item) => item.id === annotation.id)}
      total={proposals.length}
      onAccepted={rounds.accepted}
      onRejected={rounds.rejected}
      onRetry={rounds.retry}
      onNavigate={rounds.navigate}
      onClose={rounds.closeReview}
    />,
    open.host,
  ) : null;
}

function AnnotationReviewCard(props: {
  annotation: EditorComment;
  /** The LaTeX around the passage that its protected spans need to parse the same way. */
  context: ProofreadContext;
  viewRef: RefObject<EditorView | null>;
  editable: boolean;
  running: boolean;
  position: number;
  total: number;
  onAccepted: (id: string, applied: AcceptedRevision) => void;
  onRejected: (id: string) => void;
  onRetry: (id: string, guidance: string) => void;
  onNavigate: (from: string, step: 1 | -1) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const { annotation, viewRef } = props;
  const revision = annotation.revision;
  const cardRef = useRef<HTMLDivElement>(null);
  const [rejectedEdits, setRejectedEdits] = useState<ReadonlySet<number>>(new Set());
  const [retrying, setRetrying] = useState(false);
  const [guidance, setGuidance] = useState("");
  const [error, setError] = useState<string | null>(null);
  const original = revision?.original ?? "";
  const proposal = revision?.state === "proposed" ? revision.text ?? "" : null;

  // The passage the proposal was made for, where it stands now; null once it changed.
  const anchored = () => {
    const view = viewRef.current;
    const anchor = view && annotationReviewAnchor(view.state);
    if (!view || anchor?.id !== annotation.id) return null;
    return view.state.sliceDoc(anchor.from, anchor.to) === original ? { view, from: anchor.from, to: anchor.to } : null;
  };

  const { context } = props;
  const review = useMemo((): ProofreadReview | null => {
    if (proposal === null) return null;
    const reviewed = reviewProofread(original, proposal, context);
    // A citation is what "Add a citation" asks for: offer it rather than hold it back.
    if (annotation.intent !== "cite") return reviewed;
    const allowed = reviewed.held.filter((edit) => edit.kind === "reference");
    return { edits: [...reviewed.edits, ...allowed].sort((a, b) => a.from - b.from), held: reviewed.held.filter((edit) => edit.kind !== "reference") };
  }, [annotation.intent, context, original, proposal]);

  const heldTags = useMemo((): Record<ProtectedKind, string> => ({
    math: t`math`,
    reference: t`citation`,
    comment: t`% comment`,
    command: t`command`,
    environment: t`environment`,
    verbatim: t`verbatim`,
    paragraph: t`paragraph break`,
  }), [t]);
  const edits = useMemo((): InlineEdit[] => review ? [
    ...review.edits.map((edit): InlineEdit => ({ ...edit, status: rejectedEdits.has(edit.id) ? "kept" : "applied" })),
    ...review.held.map((edit): InlineEdit => ({ ...edit, status: "held", tag: heldTags[edit.kind] })),
  ] : [], [heldTags, rejectedEdits, review]);
  const chosen = review ? chosenEdits(review, rejectedEdits) : [];
  const offered = review?.edits.length ?? 0;

  useEffect(() => {
    // The card takes focus so its keys (⌘↩, ⌫, ↓) answer at once.
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  const accept = () => {
    if (!review || !props.editable) return;
    const place = anchored();
    if (!place) {
      setError(t`The passage changed after the agent read it. Try again to have it read the passage as it is now.`);
      return;
    }
    const revised = applyProofreadEdits(original, chosen);
    if (chosen.length) {
      place.view.dispatch({
        changes: chosen.map((edit) => ({ from: place.from + edit.from, to: place.from + edit.to, insert: edit.insert })),
        effects: setAnnotationReviewEffect.of(null),
        annotations: isolateHistory.of("full"),
        userEvent: "input.annotation",
      });
    }
    const doc = place.view.state.doc;
    const to = place.from + revised.length;
    props.onAccepted(annotation.id, {
      from: place.from,
      to,
      quote: revised,
      prefix: doc.sliceString(Math.max(0, place.from - 32), place.from),
      suffix: doc.sliceString(to, Math.min(doc.length, to + 32)),
    });
  };
  const reject = () => props.onRejected(annotation.id);
  const askAgain = () => {
    props.onRetry(annotation.id, guidance);
    setRetrying(false);
    setGuidance("");
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLTextAreaElement) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setRetrying(false);
      } else if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        askAgain();
      }
      return;
    }
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (proposal !== null && !props.running) accept();
    } else if ((event.key === "Backspace" || event.key === "Delete") && plain) {
      event.preventDefault();
      if (proposal !== null && !props.running) reject();
    } else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && plain && props.total > 1) {
      event.preventDefault();
      props.onNavigate(annotation.id, event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      props.onClose();
      viewRef.current?.focus();
    }
  };

  const status = props.running ? "running" : revision?.state === "proposed" ? "proposed" : "settled";
  const position = props.position >= 0 ? props.position + 1 : null;
  const total = props.total;
  return (
    <div
      ref={cardRef}
      className="annotation-review-card"
      role="group"
      tabIndex={-1}
      aria-label={t`Proposal for annotation ${annotation.number}`}
      aria-busy={props.running}
      data-status={status}
      onKeyDown={onKeyDown}
    >
      <div className="annotation-review-head">
        <AnnotationPin number={annotation.number ?? 0} status={props.running ? "open" : "proposed"} />
        <span className="annotation-review-note">{annotation.body}</span>
      </div>
      {props.running ? (
        <p className="annotation-review-status" role="status">
          <InfinityLoader size={12} /> {t`Asking the agent again…`}
        </p>
      ) : proposal !== null && review ? (
        <>
          {offered + review.held.length > 0 ? (
            <InlineEdits
              className="annotation-review-text"
              text={original}
              edits={edits}
              onToggle={(id) => setRejectedEdits((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })}
            />
          ) : <p className="annotation-review-status">{t`The agent suggests leaving the passage as it is.`}</p>}
          {revision?.reason && <p className="annotation-review-reason">{t`Agent: ${revision.reason}`}</p>}
          {review.held.length > 0 && (
            <InlineMessage level="warning" className="annotation-review-held">
              {t`Some changes would alter LaTeX the note did not ask about, so Lattice holds them back.`}
            </InlineMessage>
          )}
        </>
      ) : revision?.state === "asked" ? (
        <p className="annotation-review-status">{t`The agent asks: ${revision.question ?? ""}`}</p>
      ) : (
        <p className="annotation-review-status">{t`This proposal has been decided.`}</p>
      )}
      {error && <InlineMessage level="error" className="annotation-review-error">{error}</InlineMessage>}
      {retrying ? (
        <div className="annotation-review-retry">
          <Textarea
            autoFocus
            rows={2}
            value={guidance}
            placeholder={t`What should the agent change? (optional)`}
            aria-label={t`What should the agent change?`}
            onChange={(event) => setGuidance(event.target.value)}
          />
          <div className="annotation-review-actions">
            <Button size="compact" variant="tinted" onClick={askAgain}>{t`Ask again`}</Button>
            <Button size="compact" variant="ghost" onClick={() => setRetrying(false)}>{t`Cancel`}</Button>
          </div>
        </div>
      ) : (
        <div className="annotation-review-actions">
          {proposal !== null && !props.running && (
            <>
              <Button
                size="compact"
                variant="tinted"
                data-annotation-accept=""
                disabled={!props.editable || (offered > 0 && chosen.length === 0)}
                onClick={accept}
              >
                {t`Accept`} <kbd>{ACCEPT_KEYS}</kbd>
              </Button>
              <Button size="compact" variant="ghost" onClick={reject}>
                {t`Reject`} <kbd>{REJECT_KEYS}</kbd>
              </Button>
            </>
          )}
          {!props.running && (
            <Button size="compact" variant="ghost" onClick={() => setRetrying(true)}>
              <RotateCcw size={13} />
              {t`Try again…`}
            </Button>
          )}
          {position && total > 1 && (
            <Button
              size="compact"
              variant="ghost"
              className="annotation-review-next"
              onClick={() => props.onNavigate(annotation.id, 1)}
            >
              <span className="annotation-review-next-label">{t`${position} of ${total}`} ·</span>
              <ArrowDown size={13} />
              {t`next`}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
