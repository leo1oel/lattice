import type { AnnotationRounds } from "../app/annotation-rounds";
import { createEditorComment, type AnnotationIntent, type EditorComment } from "../editor/comments/editor-comment-data";

/** What saving a note reads from the canvas's review model. */
type NoteReview = {
  commentAuthorId: string;
  commentAuthorName: string;
  onCreateEditorComment: (comment: EditorComment) => EditorComment | "overleaf" | null;
  annotationRounds: Pick<AnnotationRounds, "revise">;
};

/**
 * Annotate `[from, to)` of `path` with a note the writer composed on a
 * selection (the source composer, or Markdown's Preview). With `revise`
 * (Save and revise now) the agent is asked about that note alone: the writer
 * picked Shorten or Rewrite for the passage they selected, so the other open
 * annotations wait for the panel's Revise. False when the range holds
 * nothing to anchor a note or the note was refused, so the composer stays.
 */
export function annotateSelection(review: NoteReview, note: {
  path: string;
  source: string;
  from: number;
  to: number;
  body: string;
  intent?: AnnotationIntent;
  revise?: boolean;
}): boolean {
  const comment = createEditorComment({
    path: note.path, source: note.source, from: note.from, to: note.to, body: note.body,
    authorId: review.commentAuthorId, authorName: review.commentAuthorName, intent: note.intent,
  });
  if (!comment) return false;
  const created = review.onCreateEditorComment(comment);
  if (created === null) return false;
  if (created !== "overleaf" && note.revise) review.annotationRounds.revise([created.id]);
  return true;
}
