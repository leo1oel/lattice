import { useEffect, useMemo, useRef, useState } from "react";
import { Check, MessageSquareText, Reply, RotateCcw } from "lucide-react";
import { EmptyState } from "./components/ui/empty-state";
import { DestructiveButton } from "./components/ui/destructive-button";
import { PanelHeader } from "./components/ui/panel-header";
import { SearchField } from "./components/ui/search-field";
import { Textarea } from "./components/ui/textarea";
import { formatCommentTimestamp, type EditorComment } from "./editor-comments";
import { ResizableDrawer } from "./resizable-drawer";

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
    <ResizableDrawer className="editor-comments-drawer" onClose={props.onClose}>
        <PanelHeader
          className="drawer-header"
          icon={<MessageSquareText size={16} />}
          title="Editor comments"
          onClose={props.onClose}
        />
        <div className="pdf-marks-toolbar">
          <SearchField
            aria-label="Filter editor comments"
            placeholder="Filter comments…"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onClear={() => setFilter("")}
          />
          <div className="pdf-marks-kind-filter" role="group" aria-label="Comment visibility">
            <button
              type="button"
              className={`ui-compact-selectable${!showResolved ? " active" : ""}`}
              aria-pressed={!showResolved}
              onClick={() => setShowResolved(false)}
            >
              Open
            </button>
            <button
              type="button"
              className={`ui-compact-selectable${showResolved ? " active" : ""}`}
              aria-pressed={showResolved}
              onClick={() => setShowResolved(true)}
            >
              Include resolved
            </button>
          </div>
        </div>
        <div className="pdf-marks-list">
          {!visible.length && (
            <EmptyState
              align="start"
              density="compact"
              description="No comments yet. Select text in the editor and click Comment."
            />
          )}
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
                    <Textarea
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
                  // Sits in the reply thread, so it is indented and sized like
                  // the replies it joins rather than borrowing the PDF-mark shell.
                  <div className="editor-comment-reply-compose">
                    <Textarea
                      value={replyDraft}
                      rows={3}
                      autoFocus
                      onChange={(event) => setReplyDraft(event.target.value)}
                      placeholder={`Reply to ${comment.authorName}`}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setReplyingId(null);
                          setReplyDraft("");
                        }
                      }}
                    />
                    <div className="editor-comment-reply-actions">
                      <button
                        type="button"
                        className="primary"
                        disabled={!replyDraft.trim()}
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
                      <DestructiveButton
                        className="danger"
                        iconSize={13}
                        onClick={() => props.onDelete(comment.id)}
                      >
                        <span>Delete</span>
                      </DestructiveButton>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
    </ResizableDrawer>
  );
}
