/**
 * Overleaf's tracked-change suggestions, as a panel you can actually work in.
 *
 * Modeled on `overleaf-comments.tsx` on purpose: a suggestion is a comment
 * that already knows what it wants to do to the text, so the same shape —
 * quote the span, show who and when, act on it inline — carries over. The
 * one thing this panel does not do is decide whether accepting or rejecting
 * is allowed; `props.canAct` (and the per-button disabling it drives) comes
 * from the caller, which already knows the account's Overleaf permission.
 */
import { Check, LoaderCircle, X } from "lucide-react";
import { trackedChangeContext } from "./overleaf-track-changes";
import type { TrackedChange } from "./use-overleaf-realtime";
import { formatCommentTimestamp } from "./editor-comments";
import "./overleaf-changes.css";

export function OverleafChangesPanel(props: {
  changes: TrackedChange[];
  /** The open document's current text, to quote the context around each suggestion. */
  source: string;
  authorName: (userId: string | null) => string;
  /** False when the open file has no live Overleaf document to act against. */
  documentOpen: boolean;
  /** False for a read-only or suggest-only account: neither button works for them. */
  canAct: boolean;
  /** The id of whichever suggestion is mid-request; "all" for a bulk action. */
  busy: string | null;
  error: string | null;
  onAccept: (changeIds: string[]) => Promise<void>;
  onReject: (changes: TrackedChange[]) => Promise<void>;
  /** Put the caret on the suggested span. */
  onReveal: (position: number) => void;
}) {
  const sorted = [...props.changes].sort((a, b) => a.position - b.position);
  const actionable = props.canAct && props.documentOpen;
  const disabledTitle = !props.documentOpen
    ? "Open the file this suggestion is in first."
    : !props.canAct
      ? "This account cannot accept or reject suggestions here."
      : undefined;

  const run = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch {
      // The hook surfaces the reason above the list.
    }
  };

  const renderChange = (change: TrackedChange) => {
    const { prefix, quote, suffix } = trackedChangeContext(props.source, change);
    const working = props.busy === change.id;
    const color = `hsl(${change.hue}, 70%, 50%)`;
    return (
      <article className="overleaf-change" key={change.id}>
        <button
          type="button"
          className="overleaf-change-quote"
          style={{ borderLeftColor: color }}
          title="Show this in the editor"
          onClick={() => props.onReveal(change.position)}
        >
          <span className="overleaf-change-context">{prefix}</span>
          <span
            className={`overleaf-change-span${change.deletion ? " deletion" : " insertion"}`}
            style={change.deletion ? { textDecorationColor: color } : { borderBottomColor: color }}
          >
            {quote || "(no text)"}
          </span>
          <span className="overleaf-change-context">{suffix}</span>
        </button>

        <div className="overleaf-change-meta">
          <span>{props.authorName(change.userId)}</span>
          <span className="overleaf-change-kind">
            {change.deletion ? "suggests deleting" : "suggests inserting"}
          </span>
          {change.timestamp && <time>{formatCommentTimestamp(change.timestamp)}</time>}
        </div>

        <div className="overleaf-change-actions">
          <button
            type="button"
            disabled={!actionable || working}
            title={disabledTitle}
            onClick={() => void run(() => props.onAccept([change.id]))}
          >
            {working ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}
            Accept
          </button>
          <button
            type="button"
            className="danger"
            disabled={!actionable || working}
            title={disabledTitle}
            onClick={() => void run(() => props.onReject([change]))}
          >
            {working ? <LoaderCircle className="spin" size={12} /> : <X size={12} />}
            Reject
          </button>
        </div>
      </article>
    );
  };

  return (
    <>
      <p className="drawer-copy">
        Suggestions made on Overleaf, or by anyone with track changes on. Accepting turns the
        suggested text into ordinary text; rejecting undoes it. Both sides see the result at once.
      </p>

      {props.error && <p className="overleaf-change-error" role="alert">{props.error}</p>}

      {sorted.length > 1 && (
        <div className="overleaf-change-bulk-actions">
          <button
            type="button"
            disabled={!actionable || props.busy !== null}
            title={disabledTitle}
            onClick={() => void run(() => props.onAccept(sorted.map((change) => change.id)))}
          >
            {props.busy === "all" ? <LoaderCircle className="spin" size={12} /> : <Check size={12} />}
            Accept all ({sorted.length})
          </button>
          <button
            type="button"
            className="danger"
            disabled={!actionable || props.busy !== null}
            title={disabledTitle}
            onClick={() => void run(() => props.onReject(sorted))}
          >
            {props.busy === "all" ? <LoaderCircle className="spin" size={12} /> : <X size={12} />}
            Reject all
          </button>
        </div>
      )}

      <div className="overleaf-change-list">
        {!sorted.length && !props.error && (
          <p className="git-empty">
            No suggestions in this document
            {props.documentOpen ? "" : " — open it to see any it has"}.
          </p>
        )}
        {sorted.map(renderChange)}
      </div>
    </>
  );
}
