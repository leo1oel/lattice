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
 * anchor now, never on whichever file happens to be open — that used to send
 * the currently open document's id and silently act on the wrong file's
 * comment. A thread whose span was deleted from the document (Overleaf calls
 * these orphaned) has no anchor, so there is no document to act on; those
 * can still be replied to here, just not resolved or deleted.
 */
import { useState } from "react";
import { Check, LoaderCircle, Pencil, RotateCcw, Trash2 } from "lucide-react";
import type { OverleafComment, OverleafThread } from "./app-types";
import { formatStamp } from "./overleaf-chat";
import { groupThreadsByFile, type OverleafCommentAnchor } from "./overleaf-comment-anchors";
import "./overleaf-comments.css";

/** While an input method is composing, Enter is picking a candidate, not sending. */
function isComposingEnter(event: React.KeyboardEvent) {
  return event.nativeEvent.isComposing || event.keyCode === 229 || event.key === "Process";
}

export function OverleafCommentsPanel(props: {
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
  const [showResolved, setShowResolved] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ threadId: string; messageId: string } | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const visible = props.threads.filter((thread) => showResolved || !thread.resolved);
  const threadsById = new Map(visible.map((thread) => [thread.id, thread]));
  const groups = groupThreadsByFile(
    visible.map((thread) => thread.id),
    props.anchors,
    props.activeDocId,
    props.pathForDoc,
  );
  const resolvedCount = props.threads.filter((thread) => thread.resolved).length;

  const run = async (threadId: string, action: () => Promise<void>) => {
    setBusy(threadId);
    try {
      await action();
    } catch {
      // The hook surfaces the reason above the list.
    }
    setBusy(null);
  };

  const deleteMessage = (thread: OverleafThread, message: OverleafComment) => {
    const onlyMessage = thread.messages.length === 1;
    const warning = onlyMessage
      ? "Delete this message? It's the only one in the thread, so this deletes the whole thread."
      : "Delete this message?";
    if (!window.confirm(warning)) return;
    void run(thread.id, () => props.onDeleteMessage(thread.id, message.id));
  };

  const renderMessage = (thread: OverleafThread, message: OverleafComment, working: boolean) => {
    const isEditing = editing?.threadId === thread.id && editing.messageId === message.id;
    return (
      <div className="overleaf-thread-message" key={message.id}>
        <div className="overleaf-thread-meta">
          <span>{message.mine ? "You" : message.authorName}</span>
          <time>{formatStamp(message.timestamp)}</time>
        </div>
        {isEditing ? (
          <div className="overleaf-thread-reply">
            <textarea
              rows={2}
              autoFocus
              value={messageDraft}
              aria-label="Edit message text"
              onChange={(event) => setMessageDraft(event.target.value)}
              onKeyDown={(event) => {
                if (isComposingEnter(event)) return;
                if (event.key === "Escape") setEditing(null);
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const content = messageDraft.trim();
                  if (!content) return;
                  void run(thread.id, async () => {
                    await props.onEditMessage(thread.id, message.id, content);
                    setEditing(null);
                  });
                }
              }}
            />
            <div className="overleaf-thread-actions">
              <button type="button" onClick={() => setEditing(null)}>Cancel</button>
              <button
                type="button"
                className="primary-button"
                disabled={!messageDraft.trim() || working}
                onClick={() => void run(thread.id, async () => {
                  await props.onEditMessage(thread.id, message.id, messageDraft.trim());
                  setEditing(null);
                })}
              >
                {working ? <LoaderCircle className="spin" size={12} /> : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <p>{message.content}</p>
            {message.mine && (
              <div className="overleaf-thread-message-actions">
                <button
                  type="button"
                  aria-label="Edit message"
                  title="Edit this message"
                  disabled={working}
                  onClick={() => {
                    setEditing({ threadId: thread.id, messageId: message.id });
                    setMessageDraft(message.content);
                  }}
                >
                  <Pencil size={11} />
                </button>
                <button
                  type="button"
                  className="danger"
                  aria-label="Delete message"
                  title="Delete this message"
                  disabled={working}
                  onClick={() => deleteMessage(thread, message)}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const renderThread = (thread: OverleafThread) => {
    const anchor = props.anchors.get(thread.id);
    const path = anchor ? props.pathForDoc(anchor.docId) : null;
    const working = busy === thread.id;
    const orphanTitle = "Its span was deleted from the document, so Overleaf can't say which file to act on.";
    return (
      <article
        className={`overleaf-thread${thread.resolved ? " resolved" : ""}`}
        key={thread.id}
      >
        {anchor ? (
          <button
            type="button"
            className="overleaf-thread-quote"
            title={path ? "Show this in the editor" : "Waiting to find out which file this is in"}
            disabled={!path}
            onClick={() => {
              if (path) props.onReveal(path, anchor.position);
            }}
          >
            {anchor.quote.trim() || "(this comment's text was removed)"}
          </button>
        ) : (
          <p className="overleaf-thread-orphaned">
            Its text was deleted from the document — Overleaf can no longer say where it was.
          </p>
        )}

        <div className="overleaf-thread-messages">
          {thread.messages.map((message) => renderMessage(thread, message, working))}
          {!thread.messages.length && (
            <p className="overleaf-thread-empty">This comment has no text yet.</p>
          )}
        </div>

        {thread.resolved && (
          <p className="overleaf-thread-resolved">
            Resolved{thread.resolvedBy ? ` by ${thread.resolvedBy}` : ""}.
          </p>
        )}

        {replyingTo === thread.id ? (
          <div className="overleaf-thread-reply">
            <textarea
              rows={2}
              autoFocus
              value={draft}
              aria-label="Reply"
              placeholder="Reply…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (isComposingEnter(event)) return;
                if (event.key === "Escape") setReplyingTo(null);
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  const content = draft.trim();
                  if (!content) return;
                  void run(thread.id, async () => {
                    await props.onReply(thread.id, content);
                    setDraft("");
                    setReplyingTo(null);
                  });
                }
              }}
            />
            <div className="overleaf-thread-actions">
              <button type="button" onClick={() => setReplyingTo(null)}>Cancel</button>
              <button
                type="button"
                className="primary-button"
                disabled={!draft.trim() || working}
                onClick={() => void run(thread.id, async () => {
                  await props.onReply(thread.id, draft.trim());
                  setDraft("");
                  setReplyingTo(null);
                })}
              >
                {working ? <LoaderCircle className="spin" size={12} /> : "Reply"}
              </button>
            </div>
          </div>
        ) : (
          <div className="overleaf-thread-actions">
            <button
              type="button"
              onClick={() => {
                setReplyingTo(thread.id);
                setDraft("");
              }}
            >
              Reply
            </button>
            <button
              type="button"
              disabled={working || !anchor}
              title={anchor ? undefined : orphanTitle}
              onClick={() => {
                if (!anchor) return;
                void run(thread.id, () => props.onResolve(thread.id, !thread.resolved));
              }}
            >
              {thread.resolved ? <RotateCcw size={12} /> : <Check size={12} />}
              {thread.resolved ? "Reopen" : "Resolve"}
            </button>
            <button
              type="button"
              className="danger"
              disabled={working || !anchor}
              title={anchor ? undefined : orphanTitle}
              onClick={() => {
                if (!anchor) return;
                void run(thread.id, () => props.onDelete(thread.id));
              }}
            >
              <Trash2 size={12} />
              Delete
            </button>
          </div>
        )}
      </article>
    );
  };

  return (
    <>
      <p className="drawer-copy">
        The same comments as the review panel on Overleaf. Replies, resolutions and deletions
        show up on both sides straight away.
      </p>

      {props.error && <p className="overleaf-chat-error">{props.error}</p>}

      {resolvedCount > 0 && (
        <div className="pdf-marks-kind-filter overleaf-thread-filter">
          <button
            type="button"
            className={!showResolved ? "active" : ""}
            onClick={() => setShowResolved(false)}
          >
            Open
          </button>
          <button
            type="button"
            className={showResolved ? "active" : ""}
            onClick={() => setShowResolved(true)}
          >
            Include resolved ({resolvedCount})
          </button>
        </div>
      )}

      <div className="overleaf-thread-list">
        {props.loading && !props.threads.length && (
          <p className="git-empty"><LoaderCircle className="spin" size={13} /> Loading comments…</p>
        )}
        {!props.loading && !visible.length && !props.error && (
          <p className="git-empty">
            No comments{showResolved ? "" : " open"} in this project. Comments made on Overleaf
            appear here as they are written.
          </p>
        )}

        {groups.map((group) => (
          <div key={group.key}>
            <h3 className="overleaf-thread-group">{group.label}</h3>
            {group.threadIds.flatMap((id) => {
              const thread = threadsById.get(id);
              return thread ? [renderThread(thread)] : [];
            })}
          </div>
        ))}
      </div>
    </>
  );
}
