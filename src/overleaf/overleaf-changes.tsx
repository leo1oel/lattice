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
import { Check, X } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { InfinityLoader } from "../components/ui/activity-icons";
import { InlineMessage } from "../components/ui/inline-message";
import { formatCommentTimestamp } from "../editor/comments/editor-comments";
import { hueColor } from "../components/ui/collab-colors";
import { trackedChangeContext } from "./overleaf-editor-extensions";
import type { TrackedChange } from "./use-overleaf-realtime";

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
  const { i18n, t } = useLingui();
  const sorted = [...props.changes].sort((a, b) => a.position - b.position);
  const actionable = props.canAct && props.documentOpen;
  const disabledTitle = !props.documentOpen
    ? t`Open the file this suggestion is in first`
    : !props.canAct
      ? t`This account cannot accept or reject suggestions here`
      : undefined;

  /** An Accept and a Reject button for `changes`; failures are surfaced by the hook above the list. */
  const actionButtons = (changes: TrackedChange[], working: boolean, disabled: boolean, labels: [string, string]) => (
    ([[Check, labels[0], () => props.onAccept(changes.map((change) => change.id)), ""],
      [X, labels[1], () => props.onReject(changes), "danger"]] as const).map(([Icon, label, action, className]) => (
      <button
        key={label}
        type="button"
        className={className || undefined}
        disabled={!actionable || disabled}
        title={disabledTitle}
        onClick={() => void action().catch(() => undefined)}
      >
        {working ? <InfinityLoader size={12} /> : <Icon size={12} />}
        {label}
      </button>
    ))
  );

  const renderChange = (change: TrackedChange) => {
    const { prefix, quote, suffix } = trackedChangeContext(props.source, change);
    const working = props.busy === change.id;
    const color = hueColor(change.hue);
    return (
      <article className="overleaf-change" key={change.id}>
        <button
          type="button"
          className="overleaf-change-quote"
          style={{ borderLeftColor: color }}
          title={t`Show this in the editor`}
          onClick={() => props.onReveal(change.position)}
        >
          <span className="overleaf-change-context">{prefix}</span>
          <span
            className={`overleaf-change-span${change.deletion ? " deletion" : " insertion"}`}
            style={change.deletion ? { textDecorationColor: color } : { borderBottomColor: color }}
          >
            {quote || t`(no text)`}
          </span>
          <span className="overleaf-change-context">{suffix}</span>
        </button>

        <div className="overleaf-change-meta">
          <span>{props.authorName(change.userId)}</span>
          <span className="overleaf-change-kind">
            {change.deletion ? t`suggests deleting` : t`suggests inserting`}
          </span>
          {change.timestamp && (
            <time>{formatCommentTimestamp(change.timestamp, undefined, i18n.locale)}</time>
          )}
        </div>

        <div className="overleaf-change-actions">
          {actionButtons([change], working, working, [t`Accept`, t`Reject`])}
        </div>
      </article>
    );
  };

  return (
    <>
      <p className="drawer-copy">
        {t`Suggestions made on Overleaf, or by anyone with track changes on. Accepting turns the suggested text into ordinary text; rejecting undoes it. Both sides see the result at once`}
      </p>

      {props.error && <InlineMessage level="error" className="overleaf-change-inline">{props.error}</InlineMessage>}

      {sorted.length > 1 && (
        <div className="overleaf-change-bulk-actions">
          {actionButtons(sorted, props.busy === "all", props.busy !== null, [t({ message: `Accept all (${sorted.length})` }), t`Reject all`])}
        </div>
      )}

      <div className="overleaf-change-list">
        {!sorted.length && !props.error && (
          <p className="git-empty">
            {props.documentOpen
              ? t`No suggestions in this document`
              : t`No suggestions in this document — open it to see any it has`}
          </p>
        )}
        {sorted.map(renderChange)}
      </div>
    </>
  );
}
