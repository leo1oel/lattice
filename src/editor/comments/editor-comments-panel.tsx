import { useEffect, useMemo, useRef, useState } from "react";
import { useLingui } from "@lingui/react/macro";
import { Check, CornerDownLeft, FileSearch, MessageSquareText, Reply, RotateCcw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { EmptyIllustration } from "../../components/ui/empty-illustration";
import { DestructiveButton } from "../../components/ui/destructive-button";
import { PanelHeader } from "../../components/ui/panel-header";
import { SearchField } from "../../components/ui/search-field";
import { Textarea } from "../../components/ui/textarea";
import { CommentVisibilityFilter } from "./comment-visibility-filter";
import { editorCommentAuthorDisplayName, type EditorComment } from "./editor-comment-data";
import { formatCommentTimestamp } from "./editor-comments";
import { ResizableDrawer } from "../../components/ui/resizable-drawer";

export function EditorCommentsPanel(props: {
  embedded?: boolean;
  comments: EditorComment[];
  activePath: string | null;
  /** The file the writer comments in, or null with none open. */
  writingFile?: string | null;
  /** Back to `writingFile`'s editor, caret where it was; with no file, a file picker. */
  onReturnToEditor?: () => void;
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
  const [showResolved, setShowResolved] = useState(!!props.focusCommentId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [replyingId, setReplyingId] = useState<string | null>(props.focusCommentId ?? null);
  const [replyDraft, setReplyDraft] = useState("");
  const focusRef = useRef<HTMLElement | null>(null);
  const { i18n, t } = useLingui();
  const anonymousAuthor = t`Anonymous`;

  // When opened from the editor's hover "Reply…", jump to that comment and
  // open its reply box straight away.
  useEffect(() => {
    if (!props.focusCommentId) return;
    setReplyingId(props.focusCommentId);
    setShowResolved(true);
    focusRef.current?.scrollIntoView({ block: "center" });
  }, [props.focusCommentId]);

  const visible = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    const matches = (comment: EditorComment) => !query || [
      comment.body,
      comment.quote,
      comment.path,
      editorCommentAuthorDisplayName(comment.authorName, anonymousAuthor),
    ].some((text) => text.toLocaleLowerCase().includes(query));
    const isActive = (comment: EditorComment) => Number(comment.path === props.activePath);
    return props.comments
      .filter((comment) => (showResolved || !comment.resolved) && matches(comment))
      // Comments on the open file first, then most recently updated.
      .sort((a, b) => isActive(b) - isActive(a) || b.updatedAt.localeCompare(a.updatedAt));
  }, [anonymousAuthor, filter, props.activePath, props.comments, showResolved]);
  const hasComments = props.comments.length > 0;
  const writingName = props.writingFile ? props.writingFile.split("/").at(-1) || props.writingFile : null;
  const closeReply = () => {
    setReplyingId(null);
    setReplyDraft("");
  };

  const content = (
    <>
      {!props.embedded && <PanelHeader
        className="drawer-header"
        icon={<MessageSquareText size={16} />}
        title={t`Editor comments`}
        onClose={props.onClose}
      />}
      {/* Nothing to filter until there is a comment. */}
      {hasComments && <div className="pdf-marks-toolbar">
        <SearchField
          aria-label={t`Filter editor comments`}
          placeholder={t`Filter comments…`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          onClear={() => setFilter("")}
        />
        <CommentVisibilityFilter
          showResolved={showResolved}
          onChange={setShowResolved}
          openLabel={t`Open comments`}
          resolvedLabel={t`Include resolved`}
        />
      </div>}
      <div className="pdf-marks-list">
        {!visible.length && (
          <EmptyState
            align={hasComments ? "start" : "center"}
            density={hasComments ? "compact" : "default"}
            icon={<EmptyIllustration kind={hasComments && filter.trim() ? "search" : "comments"} size={hasComments ? "compact" : "default"} />}
            description={!hasComments
              ? props.onReturnToEditor && !props.writingFile
                ? t`No comments yet. Open a file, select text and click Comment`
                : t`No comments yet. Select text in the editor and click Comment`
              : filter.trim() ? t`No matches` : t`No open comments`}
            actions={!hasComments && props.onReturnToEditor && (
              <Button size="compact" className="editor-comments-return" onClick={props.onReturnToEditor}>
                {writingName ? <CornerDownLeft size={13} /> : <FileSearch size={13} />}
                <span>{writingName ? t`Return to ${writingName}` : t`Open a file`}</span>
              </Button>
            )}
          />
        )}
        {visible.map((comment) => {
          const isAuthor = comment.authorId === props.currentAuthorId;
          const focused = comment.id === props.focusCommentId;
          const displayedCommentAuthor = editorCommentAuthorDisplayName(comment.authorName, anonymousAuthor);
          return (
            <article
              className={`pdf-mark-item${comment.resolved ? " resolved" : ""}${focused ? " focused" : ""}`}
              key={comment.id}
              ref={focused ? focusRef : undefined}
            >
              <button type="button" className="pdf-mark-body" onClick={() => props.onOpen(comment)}>
                <div className="pdf-mark-meta">
                  <MessageSquareText size={12} />
                  <span>{displayedCommentAuthor}</span>
                  <span>{comment.path}</span>
                  {comment.resolved && <span>{t`Resolved`}</span>}
                </div>
                <span className="pdf-mark-quote">{comment.quote.trim() || t`(empty span)`}</span>
                <p>{comment.body}</p>
              </button>

              {comment.replies.length > 0 && (
                <div className="editor-comment-replies">
                  {comment.replies.map((reply) => (
                    <div className="editor-comment-reply" key={reply.id}>
                      <div className="editor-comment-reply-meta">
                        <span>{editorCommentAuthorDisplayName(reply.authorName, anonymousAuthor)}</span>
                        <span>{formatCommentTimestamp(reply.createdAt, Date.now(), i18n.locale)}</span>
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
                    // Edit lands in the text, at its end, like Reply does.
                    autoFocus
                    onFocus={(event) => event.currentTarget.setSelectionRange(draft.length, draft.length)}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={t`Update comment…`}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") setEditingId(null);
                    }}
                  />
                  <div className="pdf-mark-actions">
                    <button
                      type="button"
                      onClick={() => {
                        props.onUpdateBody(comment, draft);
                        setEditingId(null);
                      }}
                    >
                      {t`Save`}
                    </button>
                    <button type="button" onClick={() => setEditingId(null)}>{t`Cancel`}</button>
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
                    placeholder={t({ message: `Reply to ${displayedCommentAuthor}` })}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") closeReply();
                    }}
                  />
                  <div className="editor-comment-reply-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={!replyDraft.trim()}
                      onClick={() => {
                        props.onReply(comment, replyDraft);
                        closeReply();
                      }}
                    >
                      {t`Reply`}
                    </button>
                    <button type="button" onClick={closeReply}>{t`Cancel`}</button>
                  </div>
                </div>
              ) : (
                <div className="pdf-mark-actions editor-comment-actions">
                  <button
                    type="button"
                    title={comment.resolved ? t`Reopen comment` : t`Resolve comment`}
                    onClick={() => props.onToggleResolved(comment)}
                  >
                    {comment.resolved ? <RotateCcw size={13} /> : <Check size={13} />}
                    <span>{comment.resolved ? t`Reopen` : t`Resolve comment`}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setReplyingId(comment.id);
                      setReplyDraft("");
                    }}
                  >
                    <Reply size={13} />
                    <span>{t`Reply`}</span>
                  </button>
                  {isAuthor && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(comment.id);
                          setDraft(comment.body);
                        }}
                      >
                        <span>{t`Edit`}</span>
                      </button>
                      <DestructiveButton className="danger" iconSize={13} onClick={() => props.onDelete(comment.id)}>
                        <span>{t`Delete`}</span>
                      </DestructiveButton>
                    </>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </>
  );
  return props.embedded ? content : (
    <ResizableDrawer className="editor-comments-drawer editor-comments-content" onClose={props.onClose}>
      {content}
    </ResizableDrawer>
  );
}
