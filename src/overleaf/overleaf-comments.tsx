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
import { useEffect, useRef, useState } from "react";
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

export function OverleafCommentsPanel(props: {
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
  onReply: (threadId: string, content: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDelete: (threadId: string) => Promise<void>;
  onEditMessage: (threadId: string, messageId: string, content: string) => Promise<void>;
  onDeleteMessage: (threadId: string, messageId: string) => Promise<void>;
  /** Put the caret on the commented span, opening its file first if that is not the one on screen. */
  onReveal: (path: string, position: number) => void;
  /** Whether resolved threads are listed too; the drawer owns the filter. */
  showResolved: boolean;
}) {
  const { i18n, t } = useLingui();
  const { showResolved } = props;
  const [replyingTo, setReplyingTo] = useState<string | null>(props.focusThreadId ?? null);
  // Resolved threads fold to one line; the one a reply was asked for starts open.
  const [openResolved, setOpenResolved] = useState<ReadonlySet<string>>(() => new Set(props.focusThreadId ? [props.focusThreadId] : []));
  const focusRef = useRef<HTMLElement | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ threadId: string; messageId: string } | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

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

  /** Mark the thread busy while `action` runs, after `confirmation` if one is asked. */
  const run = async (threadId: string, action: () => Promise<void>, confirmation?: string) => {
    if (confirmation && !await confirmAction(confirmation)) return;
    setBusy(threadId);
    try {
      await action();
    } catch {
      // The hook surfaces the reason above the list.
    }
    setBusy(null);
  };

  const colorOf = (message: OverleafComment) =>
    personColor(props.hues, { name: message.authorName, email: message.authorEmail, mine: message.mine }).color;

  const renderMessage = (thread: OverleafThread, message: OverleafComment, working: boolean) => (
    <li className="overleaf-thread-message" key={message.id}>
      <PersonAvatar name={message.authorName} color={colorOf(message)} />
      <div className="overleaf-thread-message-body">
        <div className="overleaf-thread-meta">
          <span>{message.mine ? t`You` : message.authorName}</span>
          {/* How long ago reads at a glance; the exact time is on hover. */}
          <time dateTime={new Date(message.timestamp).toISOString()} title={formatStamp(message.timestamp, i18n.locale)}>
            {formatCommentTimestamp(new Date(message.timestamp).toISOString(), undefined, i18n.locale, "narrow")}
          </time>
          {message.mine && !(editing?.threadId === thread.id && editing.messageId === message.id) && (
            <span className="overleaf-thread-message-actions">
              <IconButton
                size="compact"
                label={t`Edit message`}
                tooltip={t`Edit this message`}
                disabled={working}
                onClick={() => {
                  setEditing({ threadId: thread.id, messageId: message.id });
                  setMessageDraft(message.content);
                }}
              >
                <Pencil size={13} aria-hidden="true" />
              </IconButton>
              <DestructiveButton
                className="ui-icon-button overleaf-thread-danger"
                data-size="compact"
                aria-label={t`Delete message`}
                title={t`Delete this message`}
                disabled={working}
                iconSize={13}
                onClick={() => void run(
                  thread.id,
                  () => props.onDeleteMessage(thread.id, message.id),
                  thread.messages.length === 1
                    ? t`Delete this message? It's the only one in the thread, so this deletes the whole thread.`
                    : t`Delete this message?`,
                )}
              />
            </span>
          )}
        </div>
        {editing?.threadId === thread.id && editing.messageId === message.id ? (
          <ThreadComposer
            value={messageDraft}
            onChange={setMessageDraft}
            label={t`Edit message text`}
            submitLabel={t`Save`}
            working={working}
            onCancel={() => setEditing(null)}
            onSubmit={(content) => void run(thread.id, async () => {
              await props.onEditMessage(thread.id, message.id, content);
              setEditing(null);
            })}
          />
        ) : <p>{message.content}</p>}
      </div>
    </li>
  );

  const renderThread = (thread: OverleafThread) => {
    const anchor = props.anchors.get(thread.id);
    const path = anchor ? props.pathForDoc(anchor.docId) : null;
    const working = busy === thread.id;
    // Resolve and delete are keyed on the anchor's document; an orphan has none.
    const threadActionTitle = anchor ? undefined : t`Its span was deleted from the document, so Overleaf can't say which file to act on`;
    const quote = anchor?.quote.trim() || t`(this comment's text was removed)`;
    const opener = thread.messages[0];
    const open = !thread.resolved || openResolved.has(thread.id);
    const toggle = () => setOpenResolved((current) => {
      const next = new Set(current);
      if (next.has(thread.id)) next.delete(thread.id);
      else next.add(thread.id);
      return next;
    });
    const remove = (
      <DestructiveButton
        className="ui-icon-button overleaf-thread-danger"
        data-size="compact"
        aria-label={t`Delete`}
        title={threadActionTitle ?? t`Delete this discussion`}
        disabled={working || !anchor}
        iconSize={13}
        onClick={() => void run(
          thread.id,
          () => props.onDelete(thread.id),
          t`Delete this discussion? Every message in the thread will be removed from Overleaf. This cannot be undone.`,
        )}
      />
    );
    return (
      <article
        className={`overleaf-thread${thread.resolved ? " resolved" : ""}`}
        key={thread.id}
        ref={thread.id === props.focusThreadId ? focusRef : undefined}
      >
        {thread.resolved ? (
          <div className="overleaf-thread-resolved">
            <button type="button" className="overleaf-thread-disclosure" aria-expanded={open} onClick={toggle}>
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
                onClick={() => void run(thread.id, () => props.onResolve(thread.id, false))}
              >
                {working ? <InfinityLoader size={12} /> : <RotateCcw size={12} aria-hidden="true" />}
                {t`Reopen`}
              </button>
            </span>
          </div>
        ) : (
          <div className="overleaf-thread-head">
            {anchor ? (
              <button
                type="button"
                className="overleaf-thread-quote"
                style={{ borderLeftColor: opener ? colorOf(opener) : undefined }}
                title={path ? t`Show this in the editor` : t`Waiting to find out which file this is in`}
                disabled={!path}
                onClick={() => path && props.onReveal(path, anchor.position)}
              >
                {quote}
              </button>
            ) : (
              <p className="overleaf-thread-orphaned">
                {t`Its text was deleted from the document — Overleaf can no longer say where it was`}
              </p>
            )}
            <span className="overleaf-thread-tools">
              {remove}
              <IconButton
                size="compact"
                className="overleaf-thread-resolve"
                label={t({ message: "Resolve", context: "comment thread" })}
                tooltip={threadActionTitle ?? t({ message: "Resolve", context: "comment thread" })}
                disabled={working || !anchor}
                onClick={() => void run(thread.id, () => props.onResolve(thread.id, true))}
              >
                {working ? <InfinityLoader size={12} /> : <Check size={15} aria-hidden="true" />}
              </IconButton>
            </span>
          </div>
        )}

        {open && (
          <>
            <ol className="overleaf-thread-messages">
              {thread.messages.map((message) => renderMessage(thread, message, working))}
              {!thread.messages.length && <li className="overleaf-thread-empty">{t`This comment has no text yet`}</li>}
            </ol>

            {replyingTo === thread.id ? (
              <div className="overleaf-thread-reply-slot">
                <ThreadComposer
                  value={draft}
                  onChange={setDraft}
                  label={t`Reply`}
                  placeholder={t`Reply…`}
                  submitLabel={t`Reply`}
                  working={working}
                  onCancel={() => setReplyingTo(null)}
                  onSubmit={(content) => void run(thread.id, async () => {
                    await props.onReply(thread.id, content);
                    setDraft("");
                    setReplyingTo(null);
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
                  setReplyingTo(thread.id);
                  setDraft("");
                }}
              >
                {t`Reply…`}
              </button>
            )}
          </>
        )}
      </article>
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
            description={showResolved || !props.threads.length
              ? t`Comments from Overleaf sit here beside the words they are about`
              : t`Every comment is resolved. All shows the resolved ones`}
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
