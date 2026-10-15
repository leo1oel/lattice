import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { ArrowUp, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { isComposingEnter } from "../../components/ui/chat-panel";
import { peerColorForKey } from "../../components/ui/collab-colors";
import { IconButton } from "../../components/ui/icon-button";
import { springExit } from "../../components/ui/motion-values";
import { popupMotionClassName } from "../../components/ui/popup-motion";
import { resizeTextareaToContent } from "../../components/ui/auto-resize-textarea";
import { Textarea } from "../../components/ui/textarea";
import { AnnotationPin } from "./annotation-pin";
import {
  annotationStatus,
  editorCommentAuthorDisplayName,
  type EditorComment,
  type EditorCommentReply,
} from "./editor-comment-data";
import { formatCommentTimestamp } from "./editor-comments";
import "./comment-card.css";

/** A card's thread or the card itself leaves on the moderate exit; the resolve lands as it ends. */
const RESOLVE_EXIT_MS = springExit.moderate.duration * 1000;

type Authored = Pick<EditorCommentReply, "authorId" | "authorName" | "authorColor">;

/** Who wrote it and when, with an annotation's pin in place of the colour dot. */
function CommentMeta({ entry, when, comment, now, children }: {
  entry: Authored;
  when: string;
  /** The thread's opener, whose pin (for an annotation) leads its first line. */
  comment?: EditorComment;
  now: number;
  children?: ReactNode;
}) {
  const { i18n, t } = useLingui();
  const name = editorCommentAuthorDisplayName(entry.authorName, t`Anonymous`);
  const color = (entry.authorColor ?? peerColorForKey(entry.authorId || entry.authorName)).color;
  return (
    <div className="comment-card-meta">
      {comment?.number
        ? <AnnotationPin number={comment.number} status={annotationStatus(comment)} />
        : <span className="comment-card-marker" aria-hidden><span className="comment-card-dot" style={{ backgroundColor: color }} /></span>}
      <span className="comment-card-author" title={name}>{name}</span>
      <time className="comment-card-time" dateTime={when}>{formatCommentTimestamp(when, now, i18n.locale, "short")}</time>
      {children}
    </div>
  );
}

function CommentBody({ body }: { body: string }) {
  const { t } = useLingui();
  return <p className="comment-card-body">{body || t`(no comment text)`}</p>;
}

/** How many replies a preview shows before it counts the rest. */
const PREVIEW_REPLIES = 2;

/**
 * What a comment on the document says, while the pointer rests on its passage
 * (the PDF, the visual Markdown editor): who, when, the note and its first
 * replies, each clamped; clicking the passage opens what acts on it.
 */
export function CommentPreview({ comments, className, now }: {
  comments: readonly EditorComment[];
  className?: string;
  now?: number;
}) {
  const { t } = useLingui();
  const [openedAt] = useState(() => Date.now());
  const at = now ?? openedAt;
  return (
    <div className={cn("comment-card comment-preview", className)}>
      {comments.map((comment) => {
        const replies = comment.replies ?? [];
        const more = replies.length - PREVIEW_REPLIES;
        return (
          <div key={comment.id} className="comment-card-thread">
            <CommentMeta entry={comment} when={comment.updatedAt || comment.createdAt} comment={comment} now={at} />
            <CommentBody body={comment.body} />
            {replies.length > 0 && (
              <ol className="comment-card-replies">
                {replies.slice(0, PREVIEW_REPLIES).map((reply) => (
                  <li key={reply.id} className="comment-card-reply">
                    <CommentMeta entry={reply} when={reply.createdAt} now={at} />
                    <CommentBody body={reply.body} />
                  </li>
                ))}
              </ol>
            )}
            {more > 0 && (
              <span className="comment-preview-more">{more === 1 ? t`1 more reply` : t`${more} more replies`}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export type CommentCardProps = {
  comments: readonly EditorComment[];
  /** Who a reply posted here is from, shown at once while it saves. */
  author: { id: string; name: string };
  onResolve: (id: string) => void;
  onReply: (id: string, body: string) => void;
  /** The card is done: Esc, or the last thread on it was resolved. */
  onClose: () => void;
  /** A thread is leaving as resolved: its passage fades with it. */
  onResolving?: (id: string) => void;
  /**
   * The writer started a reply to `id`. A hover card pins itself here so the
   * pointer can leave while they type; it may remount the card, which then
   * opens with `replyingTo` already set.
   */
  onReplyStart?: (id: string) => void;
  /** The thread whose reply field is open when the card mounts. */
  replyingTo?: string | null;
  /** The card mounts without its entrance, as the same card pinned in place. */
  still?: boolean;
  /** One quiet row under the threads, such as the PDF's way to the source. */
  footer?: ReactNode;
  className?: string;
  now?: number;
};

/**
 * A comment's card on the document: the thread (a pin or colour dot, the
 * author, the time, the note and its replies), Resolve as a check beside the
 * time, and Reply as the field it becomes. Shared by the source editor's
 * hover card and the PDF's, and drawn like the collaboration panel's thread
 * card (overleaf-comments.tsx) so a comment reads the same in each.
 *
 * Resolve answers in place: the check presses and turns green, the thread
 * (or the whole card, for its last thread) leaves on the moderate exit while
 * its passage fades, and the owner's toast offers it back. A reply appears
 * in the thread as soon as it is sent.
 */
export function CommentCard(props: CommentCardProps) {
  const { t } = useLingui();
  const { comments } = props;
  const [openedAt] = useState(() => Date.now());
  const now = props.now ?? openedAt;
  /** How many replies each thread had when the card opened. */
  const [baseline] = useState(() => new Map(comments.map((comment) => [comment.id, comment.replies?.length ?? 0])));
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(props.replyingTo ?? null);
  const [draft, setDraft] = useState("");
  /** Replies sent from this card, shown until the comment's own list carries them. */
  const [posted, setPosted] = useState<ReadonlyArray<EditorCommentReply & { commentId: string }>>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer);
  }, []);
  const allLeaving = comments.length > 0 && comments.every((comment) => leaving.has(comment.id));

  const resolve = (id: string) => {
    if (leaving.has(id)) return;
    const next = new Set(leaving).add(id);
    setLeaving(next);
    props.onResolving?.(id);
    timers.current.push(window.setTimeout(() => {
      props.onResolve(id);
      if (comments.every((comment) => next.has(comment.id))) props.onClose();
    }, RESOLVE_EXIT_MS));
  };

  const startReply = (id: string) => {
    setDraft("");
    setReplyingTo(id);
    props.onReplyStart?.(id);
  };

  const send = (id: string) => {
    const body = draft.trim();
    if (!body) return;
    props.onReply(id, body);
    setPosted((current) => [...current, {
      id: crypto.randomUUID(), commentId: id, authorId: props.author.id, authorName: props.author.name, body, createdAt: new Date().toISOString(),
    }]);
    setDraft("");
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    // A reply being written goes first; Esc again (or on an empty field) closes the card.
    if (event.target instanceof HTMLTextAreaElement && draft.trim()) {
      setDraft("");
      setReplyingTo(null);
      return;
    }
    props.onClose();
  };

  return (
    <div
      // A card drawn again pinned arrives without its entrance, but leaves as every popup does.
      className={cn("comment-card", (!props.still || allLeaving) && popupMotionClassName, props.className)}
      role="dialog"
      aria-label={t`Comment`}
      data-leaving={allLeaving ? "" : undefined}
      onKeyDown={onKeyDown}
    >
      {comments.map((comment) => {
        const known = comment.replies ?? [];
        // A live comment (the PDF's) grows by each reply as it saves; a snapshot (the hover card's) never does.
        const mine = posted.filter((reply) => reply.commentId === comment.id);
        const sent = mine.slice(Math.max(0, known.length - (baseline.get(comment.id) ?? known.length)));
        const resolving = leaving.has(comment.id);
        return (
          <article
            key={comment.id}
            className="comment-card-thread"
            data-leaving={resolving && !allLeaving ? "" : undefined}
            aria-busy={resolving || undefined}
          >
            <CommentMeta entry={comment} when={comment.updatedAt || comment.createdAt} comment={comment} now={now}>
              <IconButton
                size="compact"
                className="comment-card-resolve"
                label={comment.resolved ? t`Reopen` : t({ message: "Resolve", context: "comment thread" })}
                data-done={resolving ? "" : undefined}
                disabled={resolving}
                onClick={() => resolve(comment.id)}
              >
                <Check size={15} aria-hidden="true" />
              </IconButton>
            </CommentMeta>
            <CommentBody body={comment.body} />
            {known.length + sent.length > 0 && (
              <ol className="comment-card-replies">
                {[...known.map((reply) => [reply, false] as const), ...sent.map((reply) => [reply, true] as const)].map(([reply, fresh]) => (
                  <li key={reply.id} className="comment-card-reply" data-new={fresh ? "" : undefined}>
                    <CommentMeta entry={reply} when={reply.createdAt} now={now} />
                    <CommentBody body={reply.body} />
                  </li>
                ))}
              </ol>
            )}
            {replyingTo === comment.id ? (
              <ReplyField
                value={draft}
                onChange={setDraft}
                onSend={() => send(comment.id)}
              />
            ) : (
              // Looks like the field it becomes, as on the collaboration panel's thread.
              <button type="button" className="comment-card-reply-field" disabled={resolving} onClick={() => startReply(comment.id)}>
                {t`Reply…`}
              </button>
            )}
          </article>
        );
      })}
      {props.footer && <div className="comment-card-footer">{props.footer}</div>}
    </div>
  );
}

function ReplyField({ value, onChange, onSend }: { value: string; onChange: (value: string) => void; onSend: () => void }) {
  const { t } = useLingui();
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (ref.current) resizeTextareaToContent(ref.current);
  }, [value]);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="comment-card-reply-box">
      <Textarea
        ref={ref}
        rows={1}
        className="comment-card-reply-input"
        aria-label={t`Reply`}
        placeholder={t`Reply…`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !isComposingEnter(event)) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      <IconButton
        size="compact"
        tone="primary"
        className="comment-card-send"
        label={t`Send reply`}
        disabled={!value.trim()}
        onClick={onSend}
      >
        <ArrowUp size={14} aria-hidden="true" />
      </IconButton>
    </div>
  );
}
