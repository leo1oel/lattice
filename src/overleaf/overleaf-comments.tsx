/**
 * Overleaf's comment threads, as a panel you can actually work in.
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
import { Check, Pencil, RotateCcw } from "lucide-react";
import type { OverleafComment, OverleafThread } from "../app-types";
import { confirmAction } from "../app-utils";
import { InfinityLoader } from "../components/ui/activity-icons";
import { formatStamp, isComposingEnter } from "../components/ui/chat-panel";
import { DestructiveButton } from "../components/ui/destructive-button";
import { InlineMessage } from "../components/ui/inline-message";
import { Textarea } from "../components/ui/textarea";
import { CommentVisibilityFilter } from "../editor/comments/comment-visibility-filter";
import { groupThreadsByFile } from "./overleaf-comment-anchors";
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
        <button type="button" onClick={props.onCancel}>{t`Cancel`}</button>
        <button type="button" disabled={!props.value.trim() || props.working} onClick={submit}>
          {props.working ? <InfinityLoader size={12} /> : props.submitLabel}
        </button>
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
  loading: boolean;
  error: string | null;
  onReply: (threadId: string, content: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDelete: (threadId: string) => Promise<void>;
  onEditMessage: (threadId: string, messageId: string, content: string) => Promise<void>;
  onDeleteMessage: (threadId: string, messageId: string) => Promise<void>;
  /** Put the caret on the commented span, opening its file first if that is not the one on screen. */
  onReveal: (path: string, position: number) => void;
}) {
  const { i18n, t } = useLingui();
  const [showResolved, setShowResolved] = useState(!!props.focusThreadId);
  const [replyingTo, setReplyingTo] = useState<string | null>(props.focusThreadId ?? null);
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
  const resolvedCount = props.threads.filter((thread) => thread.resolved).length;

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

  const renderMessage = (thread: OverleafThread, message: OverleafComment, working: boolean) => (
    <div className="overleaf-thread-message" key={message.id}>
      <div className="overleaf-thread-meta">
        <span>{message.mine ? t`You` : message.authorName}</span>
        <time>{formatStamp(message.timestamp, i18n.locale)}</time>
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
      ) : (
        <>
          <p>{message.content}</p>
          {message.mine && (
            <div className="overleaf-thread-message-actions">
              <button
                type="button"
                aria-label={t`Edit message`}
                title={t`Edit this message`}
                disabled={working}
                onClick={() => {
                  setEditing({ threadId: thread.id, messageId: message.id });
                  setMessageDraft(message.content);
                }}
              >
                <Pencil size={11} />
              </button>
              <DestructiveButton
                className="danger"
                aria-label={t`Delete message`}
                title={t`Delete this message`}
                disabled={working}
                iconSize={11}
                onClick={() => void run(
                  thread.id,
                  () => props.onDeleteMessage(thread.id, message.id),
                  thread.messages.length === 1
                    ? t`Delete this message? It's the only one in the thread, so this deletes the whole thread.`
                    : t`Delete this message?`,
                )}
              />
            </div>
          )}
        </>
      )}
    </div>
  );

  const renderThread = (thread: OverleafThread) => {
    const anchor = props.anchors.get(thread.id);
    const path = anchor ? props.pathForDoc(anchor.docId) : null;
    const working = busy === thread.id;
    // Resolve and delete are keyed on the anchor's document; an orphan has none.
    const threadActionTitle = anchor ? undefined : t`Its span was deleted from the document, so Overleaf can't say which file to act on`;
    return (
      <article
        className={`overleaf-thread${thread.resolved ? " resolved" : ""}`}
        key={thread.id}
        ref={thread.id === props.focusThreadId ? focusRef : undefined}
      >
        {anchor ? (
          <button
            type="button"
            className="overleaf-thread-quote"
            title={path ? t`Show this in the editor` : t`Waiting to find out which file this is in`}
            disabled={!path}
            onClick={() => path && props.onReveal(path, anchor.position)}
          >
            {anchor.quote.trim() || t`(this comment's text was removed)`}
          </button>
        ) : (
          <p className="overleaf-thread-orphaned">
            {t`Its text was deleted from the document — Overleaf can no longer say where it was`}
          </p>
        )}

        <div className="overleaf-thread-messages">
          {thread.messages.map((message) => renderMessage(thread, message, working))}
          {!thread.messages.length && <p className="overleaf-thread-empty">{t`This comment has no text yet`}</p>}
        </div>

        {thread.resolved && (
          <p className="overleaf-thread-resolved">
            {thread.resolvedBy ? t({ message: `Resolved by ${thread.resolvedBy}` }) : t`Resolved`}
          </p>
        )}

        {replyingTo === thread.id ? (
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
        ) : (
          <div className="overleaf-thread-actions">
            <button
              type="button"
              onClick={() => {
                setReplyingTo(thread.id);
                setDraft("");
              }}
            >
              {t`Reply`}
            </button>
            <button
              type="button"
              disabled={working || !anchor}
              title={threadActionTitle}
              onClick={() => void run(thread.id, () => props.onResolve(thread.id, !thread.resolved))}
            >
              {thread.resolved ? <RotateCcw size={12} /> : <Check size={12} />}
              {thread.resolved ? t`Reopen` : t({ message: "Resolve", context: "comment thread" })}
            </button>
            <DestructiveButton
              className="danger"
              disabled={working || !anchor}
              title={threadActionTitle}
              iconSize={12}
              onClick={() => void run(
                thread.id,
                () => props.onDelete(thread.id),
                t`Delete this discussion? Every message in the thread will be removed from Overleaf. This cannot be undone.`,
              )}
            >
              {t`Delete`}
            </DestructiveButton>
          </div>
        )}
      </article>
    );
  };

  return (
    <>
      {props.error && <InlineMessage level="error" className="overleaf-chat-inline">{props.error}</InlineMessage>}

      {resolvedCount > 0 && (
        <CommentVisibilityFilter
          className="overleaf-thread-filter"
          showResolved={showResolved}
          onChange={setShowResolved}
          openLabel={t`Unresolved`}
          resolvedLabel={t({ message: `Include resolved (${resolvedCount})` })}
        />
      )}

      <div className="overleaf-thread-list">
        {props.loading && !props.threads.length && (
          <p className="git-empty"><InfinityLoader size={13} /> {t`Loading comments…`}</p>
        )}
        {!props.loading && !visible.length && !props.error && (
          <p className="git-empty">
            {showResolved
              ? t`No comments yet`
              : t`No open comments`}
          </p>
        )}

        {groups.map((group) => (
          <section key={group.key} className="overleaf-thread-section">
            <h3 className="overleaf-thread-group">{group.label}</h3>
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
