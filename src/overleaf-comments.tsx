/**
 * Overleaf's comment threads, as a panel you can actually work in.
 *
 * A comment is only useful where the text is, so threads anchored in the open
 * document come first, quoting the span they sit on and jumping to it when
 * clicked. Threads from elsewhere in the project still show — a question you
 * cannot see is a question nobody answers — but Overleaf only hands over the
 * anchor for a document while it is open, so those carry no quote.
 */
import { useState } from "react";
import { Check, LoaderCircle, RotateCcw, Trash2 } from "lucide-react";
import type { OverleafThread } from "./app-types";
import { formatStamp } from "./overleaf-chat";
import "./overleaf-comments.css";

export function OverleafCommentsPanel(props: {
  threads: OverleafThread[];
  /** Thread id → the text it is attached to, for the open document. */
  anchors: Map<string, { position: number; quote: string }>;
  /** False when the open file is not a document Overleaf tracks. */
  documentOpen: boolean;
  loading: boolean;
  error: string | null;
  onReply: (threadId: string, content: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDelete: (threadId: string) => Promise<void>;
  /** Put the caret on the commented span. */
  onReveal: (position: number) => void;
}) {
  const [showResolved, setShowResolved] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const visible = props.threads.filter((thread) => showResolved || !thread.resolved);
  // Here first, then everywhere else: a comment on the paragraph you are
  // looking at is the one you are going to act on.
  const here = visible.filter((thread) => props.anchors.has(thread.id));
  const elsewhere = visible.filter((thread) => !props.anchors.has(thread.id));
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

  const renderThread = (thread: OverleafThread) => {
    const anchor = props.anchors.get(thread.id);
    const working = busy === thread.id;
    return (
      <article
        className={`overleaf-thread${thread.resolved ? " resolved" : ""}`}
        key={thread.id}
      >
        {anchor && (
          <button
            type="button"
            className="overleaf-thread-quote"
            title="Show this in the editor"
            onClick={() => props.onReveal(anchor.position)}
          >
            {anchor.quote.trim() || "(the comment's text was removed)"}
          </button>
        )}

        <div className="overleaf-thread-messages">
          {thread.messages.map((message) => (
            <div className="overleaf-thread-message" key={message.id}>
              <div className="overleaf-thread-meta">
                <span>{message.mine ? "You" : message.authorName}</span>
                <time>{formatStamp(message.timestamp)}</time>
              </div>
              <p>{message.content}</p>
            </div>
          ))}
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
                // Enter while an input method is composing picks a candidate;
                // treating it as "send" would post a half-finished word.
                if (
                  event.nativeEvent.isComposing
                  || event.keyCode === 229
                  || event.key === "Process"
                ) {
                  return;
                }
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
              disabled={working || !props.documentOpen}
              title={props.documentOpen
                ? undefined
                : "Open the file this comment is on to resolve it"}
              onClick={() => void run(thread.id, () => props.onResolve(thread.id, !thread.resolved))}
            >
              {thread.resolved ? <RotateCcw size={12} /> : <Check size={12} />}
              {thread.resolved ? "Reopen" : "Resolve"}
            </button>
            <button
              type="button"
              className="danger"
              disabled={working || !props.documentOpen}
              title={props.documentOpen
                ? undefined
                : "Open the file this comment is on to delete it"}
              onClick={() => void run(thread.id, () => props.onDelete(thread.id))}
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

        {here.length > 0 && (
          <>
            <h3 className="overleaf-thread-group">In this file</h3>
            {here.map(renderThread)}
          </>
        )}
        {elsewhere.length > 0 && (
          <>
            <h3 className="overleaf-thread-group">Elsewhere in the project</h3>
            {elsewhere.map(renderThread)}
          </>
        )}
      </div>
    </>
  );
}
