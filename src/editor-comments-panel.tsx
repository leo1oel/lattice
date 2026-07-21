import { useEffect, useMemo, useRef, useState } from "react";
import { Check, MessageSquareText, Reply, RotateCcw, Trash2, X } from "lucide-react";
import { formatCommentTimestamp, type EditorComment } from "./editor-comments";

export function EditorCommentsPanel(props: {
  comments: EditorComment[];
  activePath: string | null;
  currentAuthorId: string;
  focusCommentId?: string | null;
  onClose: () => void;
  onOpen: (comment: EditorComment) => void;
  onDelete: (id: string) => void;
  onToggleResolved: (comment: EditorComment) => void;
  onUpdateBody: (comment: EditorComment, body: string) => void;
  onReply: (comment: EditorComment, body: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyingId, setReplyingId] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const focusRef = useRef<HTMLElement | null>(null);

  // When opened from the editor's hover "Reply…", jump to that comment and
  // open its reply box straight away.
  useEffect(() => {
    if (!props.focusCommentId) return;
    setReplyingId(props.focusCommentId);
    setShowResolved(true);
    const node = focusRef.current;
    if (node) node.scrollIntoView({ block: "center" });
  }, [props.focusCommentId]);

  const visible = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    return props.comments
      .filter((comment) => (showResolved ? true : !comment.resolved))
      .filter((comment) => {
        if (!query) return true;
        return (
          comment.body.toLocaleLowerCase().includes(query)
          || comment.quote.toLocaleLowerCase().includes(query)
          || comment.path.toLocaleLowerCase().includes(query)
          || comment.authorName.toLocaleLowerCase().includes(query)
        );
      })
      .sort((a, b) => {
        if (a.path === props.activePath && b.path !== props.activePath) return -1;
        if (b.path === props.activePath && a.path !== props.activePath) return 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }, [filter, props.activePath, props.comments, showResolved]);

  return (
    <div className="drawer-backdrop" onMouseDown={props.onClose}>
      <aside className="history-drawer editor-comments-drawer" onMouseDown={(event) => event.stopPropagation()}>
        <div className="drawer-header">
          <div><MessageSquareText size={16} /><span>Editor comments</span></div>
          <button type="button" onClick={props.onClose}><X size={16} /></button>
        </div>
        <p className="drawer-copy">
          Select text in the source editor, then add a comment. Comments sync with collaborators and stay in the project after you leave.
        </p>
        <div className="pdf-marks-toolbar">
          <input
            type="search"
            placeholder="Filter comments…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <div className="pdf-marks-kind-filter">
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
              Include resolved
            </button>
          </div>
        </div>
        <div className="pdf-marks-list">
          {!visible.length && <p className="git-empty">No comments yet. Select text in the editor and click Comment.</p>}
          {visible.map((comment) => {
            const isAuthor = comment.authorId === props.currentAuthorId;
            const focused = comment.id === props.focusCommentId;
            return (
              <article
                className={`pdf-mark-item${comment.resolved ? " resolved" : ""}${focused ? " focused" : ""}`}
                key={comment.id}
                ref={focused ? focusRef : undefined}
              >
                <button type="button" className="pdf-mark-body" onClick={() => props.onOpen(comment)}>
                  <div className="pdf-mark-meta">
                    <MessageSquareText size={12} />
                    <span>{comment.authorName}</span>
                    <span>{comment.path}</span>
                    {comment.resolved && <span>Resolved</span>}
                  </div>
                  <strong>{comment.quote.trim() || "(empty span)"}</strong>
                  <p>{comment.body}</p>
                </button>

                {comment.replies.length > 0 && (
                  <div className="editor-comment-replies">
                    {comment.replies.map((reply) => (
                      <div className="editor-comment-reply" key={reply.id}>
                        <div className="editor-comment-reply-meta">
                          <span>{reply.authorName}</span>
                          <span>{formatCommentTimestamp(reply.createdAt)}</span>
                        </div>
                        <p>{reply.body}</p>
                      </div>
                    ))}
                  </div>
                )}

                {editingId === comment.id ? (
                  <div className="pdf-mark-edit">
                    <textarea
                      value={draft}
                      rows={3}
                      onChange={(event) => setDraft(event.target.value)}
                      placeholder="Update comment…"
                    />
                    <div className="pdf-mark-actions">
                      <button
                        type="button"
                        onClick={() => {
                          props.onUpdateBody(comment, draft);
                          setEditingId(null);
                        }}
                      >
                        Save
                      </button>
                      <button type="button" onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : replyingId === comment.id ? (
                  <div className="pdf-mark-edit">
                    <textarea
                      value={replyDraft}
                      rows={3}
                      autoFocus
                      onChange={(event) => setReplyDraft(event.target.value)}
                      placeholder={`Reply to ${comment.authorName}…`}
                    />
                    <div className="pdf-mark-actions">
                      <button
                        type="button"
                        onClick={() => {
                          props.onReply(comment, replyDraft);
                          setReplyingId(null);
                          setReplyDraft("");
                        }}
                      >
                        Reply
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setReplyingId(null);
                          setReplyDraft("");
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="pdf-mark-actions editor-comment-actions">
                    <button
                      type="button"
                      title={comment.resolved ? "Reopen" : "Resolve"}
                      onClick={() => props.onToggleResolved(comment)}
                    >
                      {comment.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
                      <span>{comment.resolved ? "Reopen" : "Resolve"}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setReplyingId(comment.id);
                        setReplyDraft("");
                      }}
                    >
                      <Reply size={13} />
                      <span>Reply</span>
                    </button>
                    {isAuthor && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(comment.id);
                          setDraft(comment.body);
                        }}
                      >
                        <span>Edit</span>
                      </button>
                    )}
                    {isAuthor && (
                      <button type="button" className="danger" onClick={() => props.onDelete(comment.id)}>
                        <Trash2 size={13} />
                        <span>Delete</span>
                      </button>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
