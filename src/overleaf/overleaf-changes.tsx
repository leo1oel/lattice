/**
 * Overleaf's tracked-change suggestions, as a panel you can actually work in.
 *
 * A suggestion is read, not decoded: the sentence around it in the reading
 * font, trimmed at word edges, with the change marked in its author's colour
 * (the colour they have in comments, chat and the presence stack); who and
 * when on one quiet line; accept and reject as two labelled icons at that
 * line's end. Suggestions sit under the section of the paper they are in, so
 * "the abstract" reads apart from "the method" without opening anything.
 *
 * The one thing this panel does not do is decide whether accepting or
 * rejecting is allowed; `props.canAct` (and the per-button disabling it
 * drives) comes from the caller, which already knows the account's Overleaf
 * permission.
 */
import { Check, Hash, X } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import { InfinityLoader } from "../components/ui/activity-icons";
import { EmptyState } from "../components/ui/empty-state";
import { IconButton } from "../components/ui/icon-button";
import { InlineMessage } from "../components/ui/inline-message";
import { ResearchArt } from "../components/ui/research-art";
import { PROOF_MARKS } from "../components/ui/research-art-proof-marks";
import { formatCommentTimestamp } from "../editor/comments/editor-comments";
import { parseLatexOutline, flattenOutline } from "../editor/latex/latex-outline";
import { lineCounter } from "../editor/latex/latex-text";
import { hueColor } from "../components/ui/collab-colors";
import { formatCount } from "../i18n";
import { trackedChangeContext } from "./overleaf-editor-extensions";
import { PersonAvatar } from "./overleaf-person-avatar";
import type { TrackedChange } from "./use-overleaf-realtime";

/** How much of the sentence to show either side of a suggestion, before trimming to whole words. */
const CONTEXT_CHARS = 64;

/** `text` without the word cut off at its far end, whitespace collapsed; whether anything was cut. */
function wholeWords(text: string, side: "before" | "after", atEdge: boolean): { text: string; cut: boolean } {
  const collapsed = text.replace(/\s+/g, " ");
  if (atEdge) return { text: collapsed, cut: false };
  const trimmed = side === "before" ? collapsed.replace(/^\S*\s?/, "") : collapsed.replace(/\s?\S*$/, "");
  return { text: trimmed, cut: true };
}

/**
 * The section each suggestion is in, by title, in document order. The
 * abstract counts as a section of its own; anything before the first section
 * heading is the front matter.
 */
function sectionsOf(source: string, changes: TrackedChange[], labels: { abstract: string; front: string }) {
  const headings = flattenOutline(parseLatexOutline(source)).filter((node) => node.kind !== "input");
  const abstractFrom = source.indexOf("\\begin{abstract}");
  const abstractTo = abstractFrom < 0 ? -1 : source.indexOf("\\end{abstract}", abstractFrom);
  const lineOf = lineCounter(source);
  const groups: Array<{ title: string; changes: TrackedChange[] }> = [];
  for (const change of changes) {
    const line = lineOf(change.position);
    const inAbstract = abstractFrom >= 0 && change.position > abstractFrom && (abstractTo < 0 || change.position < abstractTo);
    let heading: string | null = null;
    for (const node of headings) {
      if (node.line > line) break;
      heading = node.title;
    }
    const title = inAbstract ? labels.abstract : heading ?? labels.front;
    const last = groups.at(-1);
    if (last?.title === title) last.changes.push(change);
    else groups.push({ title, changes: [change] });
  }
  return groups;
}

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
  // `lineCounter` only walks forward, so sections are read in document order.
  const sorted = [...props.changes].sort((a, b) => a.position - b.position);
  const actionable = props.canAct && props.documentOpen;
  const disabledTitle = !props.documentOpen
    ? t`Open the file this suggestion is in first`
    : !props.canAct
      ? t`This account cannot accept or reject suggestions here`
      : undefined;
  // Failures are surfaced by the hook above the list.
  const accept = (changes: TrackedChange[]) => void props.onAccept(changes.map((change) => change.id)).catch(() => undefined);
  const reject = (changes: TrackedChange[]) => void props.onReject(changes).catch(() => undefined);

  const renderChange = (change: TrackedChange) => {
    const { prefix, quote, suffix } = trackedChangeContext(props.source, change, CONTEXT_CHARS);
    // Shorter than asked for means it ran into the start or end of the file, so nothing was cut.
    const before = wholeWords(prefix, "before", prefix.length < CONTEXT_CHARS);
    const after = wholeWords(suffix, "after", suffix.length < CONTEXT_CHARS);
    const working = props.busy === change.id;
    const color = hueColor(change.hue);
    const author = props.authorName(change.userId);
    const mark = { borderColor: color, textDecorationColor: color, background: hueColor(change.hue, change.deletion ? 0.1 : 0.14) };
    return (
      <li className="overleaf-change" key={change.id}>
        <div className="overleaf-change-meta">
          <PersonAvatar name={author} color={color} size="small" />
          <span className="overleaf-change-author">{author}</span>
          {/* Overleaf's own review panel words them this way. */}
          <span className="overleaf-change-kind">
            {change.deletion
              ? t({ message: "deleted", context: "tracked change, after its author" })
              : t({ message: "added", context: "tracked change, after its author" })}
          </span>
          {change.timestamp && (
            <time dateTime={change.timestamp} title={new Date(change.timestamp).toLocaleString(i18n.locale)}>
              {formatCommentTimestamp(change.timestamp, undefined, i18n.locale, "narrow")}
            </time>
          )}
          <span className="overleaf-change-actions">
            <IconButton
              size="compact"
              className="overleaf-change-accept"
              label={t`Accept`}
              tooltip={disabledTitle ?? t`Accept`}
              disabled={!actionable || working}
              onClick={() => accept([change])}
            >
              {working ? <InfinityLoader size={12} /> : <Check size={15} aria-hidden="true" />}
            </IconButton>
            <IconButton
              size="compact"
              className="overleaf-change-reject"
              label={t`Reject`}
              tooltip={disabledTitle ?? t`Reject`}
              disabled={!actionable || working}
              onClick={() => reject([change])}
            >
              <X size={15} aria-hidden="true" />
            </IconButton>
          </span>
        </div>
        <button type="button" className="overleaf-change-text" title={t`Show this in the editor`} onClick={() => props.onReveal(change.position)}>
          <span className="overleaf-change-context">{before.cut && "…"}{before.text}</span>
          {change.deletion
            ? <del style={mark}>{quote || t`(no text)`}</del>
            : <ins style={mark}>{quote || t`(no text)`}</ins>}
          <span className="overleaf-change-context">{after.text}{after.cut && "…"}</span>
        </button>
      </li>
    );
  };

  const sections = sectionsOf(props.source, sorted, { abstract: t`Abstract`, front: t`Before the first section` });
  const count = formatCount(sorted.length, i18n.locale);

  return (
    <>
      {props.error && <InlineMessage level="error" className="overleaf-change-inline">{props.error}</InlineMessage>}

      {sorted.length > 0 && (
        <div className="overleaf-collab-toolbar">
          <span className="overleaf-collab-count">{sorted.length === 1 ? t`1 suggestion` : t`${count} suggestions`}</span>
          {sorted.length > 1 && (
            <span className="overleaf-change-bulk-actions">
              <button
                type="button"
                className="overleaf-collab-text-button"
                disabled={!actionable || props.busy !== null}
                title={disabledTitle}
                onClick={() => accept(sorted)}
              >
                {props.busy === "all" ? <InfinityLoader size={12} /> : <Check size={13} aria-hidden="true" />}
                {t`Accept all`}
              </button>
              <button
                type="button"
                className="overleaf-collab-text-button"
                disabled={!actionable || props.busy !== null}
                title={disabledTitle}
                onClick={() => reject(sorted)}
              >
                <X size={13} aria-hidden="true" />
                {t`Reject all`}
              </button>
            </span>
          )}
        </div>
      )}

      <div className="overleaf-change-list">
        {!sorted.length && !props.error && (
          <EmptyState
            className="overleaf-collab-empty"
            icon={<ResearchArt drawing={PROOF_MARKS} />}
            title={props.documentOpen ? t`No suggestions in this file` : t`Open a file to see its suggestions`}
            description={props.documentOpen
              ? t`When a collaborator edits with Track changes on, each edit waits here for you to accept or reject`
              : t`Overleaf keeps suggestions with each file; they show here for the file in front`}
          />
        )}
        {sections.map((section, index) => (
          <section key={`${index}:${section.title}`} className="overleaf-change-section">
            <h3 className="overleaf-collab-group">
              <Hash size={12} aria-hidden="true" />
              <span>{section.title}</span>
              <span className="overleaf-collab-group-count">{formatCount(section.changes.length, i18n.locale)}</span>
            </h3>
            <ol className="overleaf-change-rows">{section.changes.map(renderChange)}</ol>
          </section>
        ))}
      </div>
    </>
  );
}
