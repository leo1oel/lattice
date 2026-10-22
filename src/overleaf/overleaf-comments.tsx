/**
 * Overleaf's comment threads, as a panel you can actually work in.
 *
 * A thread reads as a conversation: the quoted span as a thin rule in the
 * reading font, then each message with its author's face and colour (the same
 * one they have in suggestions, chat and the presence stack) and how long ago.
 * Resolving sits quietly in the thread's corner and deleting appears beside it
 * on hover or focus, so a screen of threads is not a screen of buttons; the
 * reply field is always there. A resolved thread folds to one line you can
 * open again.
 *
 * A comment is only useful where the text is, so every thread quotes the span
 * it sits on and jumps to it when clicked — whether or not that file is the
 * one on screen, since `overleaf_comment_anchors` reads every document's
 * ranges rather than just the open one. Threads are grouped by file for the
 * same reason: a reader needs to tell "about this paragraph" apart from
 * "about the conclusion" at a glance, not by opening every thread to find out.
 *
 * `useOverleafComments` keys resolving and deleting on the thread's own
 * anchor, never on whichever file happens to be open. A thread whose span was
 * deleted from the document (Overleaf calls these orphaned) has no anchor, so
 * there is no document to act on; those can still be replied to here, just
 * not resolved or deleted.
 */
import { useEffect, useRef, useState, type Ref } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, ChevronRight, FileText, Pencil, RotateCcw } from "lucide-react";
import type { OverleafComment, OverleafThread } from "../app-types";
import { confirmAction } from "../app-utils";
import { InfinityLoader } from "../components/ui/activity-icons";
import { Button } from "../components/ui/button";
import { formatStamp, isComposingEnter } from "../components/ui/chat-panel";
import { DestructiveButton } from "../components/ui/destructive-button";
import { InlineMessage } from "../components/ui/inline-message";
import { EmptyState } from "../components/ui/empty-state";
import { IconButton } from "../components/ui/icon-button";
import { ResearchArt } from "../components/ui/research-art";
import { MARGIN_NOTES } from "../components/ui/research-art-margin-notes";
import { Textarea } from "../components/ui/textarea";
import { formatCommentTimestamp } from "../editor/comments/editor-comments";
import { formatCount } from "../i18n";
import { personColor, type PeopleHues } from "./overleaf-collab-people";
import { groupThreadsByFile } from "./overleaf-comment-anchors";
import { PersonAvatar } from "./overleaf-person-avatar";
import type { OverleafCommentAnchor } from "./use-overleaf-comments";

/** A reply or message edit: Enter saves, Shift+Enter breaks the line, Escape cancels. */
function ThreadComposer(props: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  submitLabel: string;
  working: boolean;
  onCancel: () => void;
  onSubmit: (content: string) => void;
}) {
  const { t } = useLingui();
  const submit = () => {
    const content = props.value.trim();
    if (content) props.onSubmit(content);
  };
  return (
    <div className="overleaf-thread-reply">
      <Textarea
        rows={2}
        autoFocus
        value={props.value}
        aria-label={props.label}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (isComposingEnter(event)) return;
          if (event.key === "Escape") props.onCancel();
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="overleaf-thread-actions">
        <Button size="compact" variant="ghost" onClick={props.onCancel}>{t`Cancel`}</Button>
        <Button size="compact" variant="primary" disabled={!props.value.trim() || props.working} onClick={submit}>
          {props.working ? <InfinityLoader size={12} /> : props.submitLabel}
        </Button>
      </div>
    </div>
  );
}

/** What a thread card can do; each resolves when Overleaf has answered. */
export type OverleafThreadActions = {
  onReply: (threadId: string, content: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDelete: (threadId: string) => Promise<void>;
  onEditMessage: (threadId: string, messageId: string, content: string) => Promise<void>;
  onDeleteMessage: (threadId: string, messageId: string) => Promise<void>;
};

/**
 * One thread, as the panel lists it and as margin review shows it beside its
 * line (overleaf-margin-review.tsx). In the margin the line is the quote, so
 * the card leaves the quote out and folds the replies after the first message
 * behind one quiet line; everything else, from resolving to editing a
 * message, is the same card.
 */
export function OverleafThreadCard({ ref, ...props }: OverleafThreadActions & {
  thread: OverleafThread;
  /** Where the thread sits; an orphan has none, and so cannot be resolved or deleted. */
  anchor: OverleafCommentAnchor | undefined;
  /** The anchor's file, once the realtime channel has said which one it is. */
  path: string | null;
  hues: PeopleHues;
  /** Whether its reply composer is open; the panel keeps one open at a time. */
  replying: boolean;
  onReplyingChange: (replying: boolean) => void;
  /** A resolved thread folds to one line; whether this one is open. */
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Put the caret on the commented span, opening its file first if that is not the one on screen. */
  onReveal: (path: string, position: number) => void;
  variant?: "panel" | "margin";
  ref?: Ref<HTMLElement>;
}) {
  const { i18n, t } = useLingui();
  const { thread, anchor, path } = props;
  const margin = props.variant === "margin";
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [working, setWorking] = useState(false);
  const [showReplies, setShowReplies] = useState(false);

  /** Mark the thread busy while `action` runs, after `confirmation` if one is asked. */
  const run = async (action: () => Promise<void>, confirmation?: string) => {
    if (confirmation && !await confirmAction(confirmation)) return;
    setWorking(true);
    try {
      await action();
    } catch {
      // The hook surfaces the reason above the list.
    }
    setWorking(false);
  };

  const colorOf = (message: OverleafComment) =>
    personColor(props.hues, { name: message.authorName, email: message.authorEmail, mine: message.mine }).color;

  const renderMessage = (message: OverleafComment) => (
    <li className="overleaf-thread-message" key={message.id}>
      <PersonAvatar name={message.authorName} color={colorOf(message)} />
      <div className="overleaf-thread-message-body">
        <div className="overleaf-thread-meta">
          <span>{message.mine ? t`You` : message.authorName}</span>
          {/* How long ago reads at a glance; the exact time is on hover. */}
          <time dateTime={new Date(message.timestamp).toISOString()} title={formatStamp(message.timestamp, i18n.locale)}>
            {formatCommentTimestamp(new Date(message.timestamp).toISOString(), undefined, i18n.locale, "narrow")}
          </time>
          {message.mine && editing !== message.id && (
            <span className="overleaf-thread-message-actions">
              <IconButton
                size="compact"
                label={t`Edit message`}
                disabled={working}
                onClick={() => {
                  setEditing(message.id);
                  setMessageDraft(message.content);
                }}
              >
                <Pencil size={13} aria-hidden="true" />
              </IconButton>
              <DestructiveButton
                className="ui-icon-button overleaf-thread-danger"
                data-size="compact"
                aria-label={t`Delete message`}
                title={t`Delete message`}
                disabled={working}
                iconSize={13}
                onClick={() => void run(
                  () => props.onDeleteMessage(thread.id, message.id),
                  thread.messages.length === 1
                    ? t`Delete this message? It's the only one in the thread, so this deletes the whole thread. This cannot be undone.`
                    : t`Delete this message? This cannot be undone.`,
                )}
              />
            </span>
          )}
        </div>
        {editing === message.id ? (
          <ThreadComposer
            value={messageDraft}
            onChange={setMessageDraft}
            label={t`Edit message text`}
            submitLabel={t`Save`}
            working={working}
            onCancel={() => setEditing(null)}
            onSubmit={(content) => void run(async () => {
              await props.onEditMessage(thread.id, message.id, content);
              setEditing(null);
            })}
          />
        ) : <p>{message.content}</p>}
      </div>
    </li>
  );

  // Resolve and delete are keyed on the anchor's document; an orphan has none.
  const threadActionTitle = anchor ? undefined : t`Its span was deleted from the document, so Overleaf can't say which file to act on`;
  const quote = anchor?.quote.trim() || t`(this comment's text was removed)`;
  const opener = thread.messages[0];
  const open = !thread.resolved || props.expanded;
  const remove = (
    <DestructiveButton
      className="ui-icon-button overleaf-thread-danger"
      data-size="compact"
      aria-label={t`Delete discussion`}
      title={threadActionTitle ?? t`Delete discussion`}
      disabled={working || !anchor}
      iconSize={13}
      onClick={() => void run(
        () => props.onDelete(thread.id),
        t`Delete this discussion? Every message in the thread will be removed from Overleaf. This cannot be undone.`,
      )}
    />
  );
  // In the margin, the replies after the first message wait behind one line until asked for.
  const folded = margin && !showReplies && !props.replying ? thread.messages.length - 1 : 0;
  const shown = folded > 0 ? thread.messages.slice(0, 1) : thread.messages;
  const more = formatCount(folded, i18n.locale);
  return (
    <article
      className={`overleaf-thread${thread.resolved ? " resolved" : ""}`}
      data-variant={margin ? "margin" : undefined}
      ref={ref}
    >
      {thread.resolved ? (
        <div className="overleaf-thread-resolved">
          <button type="button" className="overleaf-thread-disclosure" aria-expanded={open} onClick={() => props.onExpandedChange(!props.expanded)}>
            <ChevronRight size={13} aria-hidden="true" />
            <Check size={13} aria-hidden="true" className="overleaf-thread-resolved-mark" />
            <span className="overleaf-thread-resolved-who">
              {thread.resolvedBy ? t({ message: `Resolved by ${thread.resolvedBy}` }) : t`Resolved`}
            </span>
            <span className="overleaf-thread-resolved-quote">{quote}</span>
          </button>
          <span className="overleaf-thread-tools">
            {remove}
            <button
              type="button"
              className="overleaf-collab-text-button"
              disabled={working || !anchor}
              title={threadActionTitle}
              onClick={() => void run(() => props.onResolve(thread.id, false))}
            >
              {working ? <InfinityLoader size={12} /> : <RotateCcw size={12} aria-hidden="true" />}
              {t`Reopen`}
            </button>
          </span>
        </div>
      ) : (
        <div className="overleaf-thread-head">
          {margin ? null : anchor ? (
            <button
              type="button"
              className="overleaf-thread-quote"
              style={{ borderLeftColor: opener ? colorOf(opener) : undefined }}
              title={path ? t`Show this in the editor` : undefined}
              disabled={!path}
              onClick={() => path && props.onReveal(path, anchor.position)}
            >
              {quote}
            </button>
          ) : (
            // The group heading ("No longer in the document") says why; the card keeps its quote line.
            <p className="overleaf-thread-orphaned">{quote}</p>
          )}
          <span className="overleaf-thread-tools">
            {remove}
            <IconButton
              size="compact"
              className="overleaf-thread-resolve"
              label={t({ message: "Resolve", context: "comment thread" })}
              tooltip={threadActionTitle ?? t({ message: "Resolve", context: "comment thread" })}
              disabled={working || !anchor}
              onClick={() => void run(() => props.onResolve(thread.id, true))}
            >
              {working ? <InfinityLoader size={12} /> : <Check size={15} aria-hidden="true" />}
            </IconButton>
          </span>
        </div>
      )}

      {open && (
        <>
          <ol className="overleaf-thread-messages">
            {shown.map(renderMessage)}
            {!thread.messages.length && <li className="overleaf-thread-empty">{t`This comment has no text yet`}</li>}
          </ol>
          {folded > 0 && (
            <button type="button" className="overleaf-thread-more" onClick={() => setShowReplies(true)}>
              {folded === 1 ? t`1 more reply` : t`${more} more replies`}
            </button>
          )}

          {props.replying ? (
            <div className="overleaf-thread-reply-slot">
              <ThreadComposer
                value={draft}
                onChange={setDraft}
                label={t`Reply`}
                placeholder={t`Reply…`}
                submitLabel={t`Reply`}
                working={working}
                onCancel={() => props.onReplyingChange(false)}
                onSubmit={(content) => void run(async () => {
                  await props.onReply(thread.id, content);
                  setDraft("");
                  props.onReplyingChange(false);
                })}
              />
            </div>
          ) : (
            // Looks like the field it becomes, so replying is never hunting
            // for a button; one composer is open at a time, so one draft.
            <button
              type="button"
              className="overleaf-thread-reply-field"
              onClick={() => {
                setDraft("");
                props.onReplyingChange(true);
              }}
            >
              {t`Reply…`}
            </button>
          )}
        </>
      )}
    </article>
  );
}

export function OverleafCommentsPanel(props: OverleafThreadActions & {
  focusThreadId?: string | null;
  threads: OverleafThread[];
  /** Every thread's anchor across the whole project, keyed by thread id. */
  anchors: Map<string, OverleafCommentAnchor>;
  /** Overleaf's id for the document currently on screen, if any. */
  activeDocId: string | null;
  /** Overleaf document id to project-relative path, for whichever documents the realtime channel has announced. */
  pathForDoc: (docId: string) => string | null;
  /** Each collaborator's Overleaf colour (overleaf-collab-people.ts). */
  hues: PeopleHues;
  loading: boolean;
  error: string | null;
  /** Put the caret on the commented span, opening its file first if that is not the one on screen. */
  onReveal: (path: string, position: number) => void;
  /** Whether resolved threads are listed too; the drawer owns the filter. */
  showResolved: boolean;
}) {
  const { t } = useLingui();
  const { showResolved } = props;
  const [replyingTo, setReplyingTo] = useState<string | null>(props.focusThreadId ?? null);
  // Resolved threads fold to one line; the one a reply was asked for starts open.
  const [openResolved, setOpenResolved] = useState<ReadonlySet<string>>(() => new Set(props.focusThreadId ? [props.focusThreadId] : []));
  const focusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (props.focusThreadId) focusRef.current?.scrollIntoView({ block: "center" });
  }, [props.focusThreadId, props.threads]);

  const visible = props.threads.filter((thread) => showResolved || !thread.resolved);
  const threadsById = new Map(visible.map((thread) => [thread.id, thread]));
  const groups = groupThreadsByFile(visible.map((thread) => thread.id), props.anchors, props.activeDocId, props.pathForDoc, {
    currentFile: t`In this file`,
    unknownFile: t`Another file in this project`,
    orphaned: t`No longer in the document`,
  });

  const renderThread = (thread: OverleafThread) => {
    const anchor = props.anchors.get(thread.id);
    return (
      <OverleafThreadCard
        key={thread.id}
        ref={thread.id === props.focusThreadId ? focusRef : undefined}
        thread={thread}
        anchor={anchor}
        path={anchor ? props.pathForDoc(anchor.docId) : null}
        hues={props.hues}
        replying={replyingTo === thread.id}
        onReplyingChange={(replying) => setReplyingTo(replying ? thread.id : null)}
        expanded={openResolved.has(thread.id)}
        onExpandedChange={(expanded) => setOpenResolved((current) => {
          const next = new Set(current);
          if (expanded) next.add(thread.id);
          else next.delete(thread.id);
          return next;
        })}
        onReveal={props.onReveal}
        onReply={props.onReply}
        onResolve={props.onResolve}
        onDelete={props.onDelete}
        onEditMessage={props.onEditMessage}
        onDeleteMessage={props.onDeleteMessage}
      />
    );
  };

  return (
    <>
      {props.error && <InlineMessage level="error" className="overleaf-chat-inline">{props.error}</InlineMessage>}

      <div className="overleaf-thread-list">
        {props.loading && !props.threads.length && (
          <p className="git-empty"><InfinityLoader size={13} /> {t`Loading comments…`}</p>
        )}
        {!props.loading && !visible.length && !props.error && (
          <EmptyState
            className="overleaf-collab-empty"
            icon={<ResearchArt drawing={MARGIN_NOTES} />}
            title={showResolved || !props.threads.length ? t`No comments yet` : t`No open comments`}
          />
        )}

        {groups.map((group) => (
          <section key={group.key} className="overleaf-thread-section">
            <h3 className="overleaf-collab-group">
              <FileText size={12} aria-hidden="true" />
              <span>{group.label}</span>
              <span className="overleaf-collab-group-count">{group.threadIds.length}</span>
            </h3>
            {group.threadIds.flatMap((id) => {
              const thread = threadsById.get(id);
              return thread ? [renderThread(thread)] : [];
            })}
          </section>
        ))}
      </div>
    </>
  );
}
