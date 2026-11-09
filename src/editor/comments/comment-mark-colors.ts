/**
 * The one colour a comment's passage is marked in, in the source
 * (editor-comments.ts) and on the PDF (pdf-annotations.tsx) alike, so the
 * same comment never reads blue on one side and amber on the other.
 *
 * A local annotation takes its colour from its status in comment-marks.css
 * (amber, the blue of a proposal, the violet of a question); an Overleaf
 * thread takes its author's colour, set inline as the same two properties.
 */
import { peerColorForKey } from "../../components/ui/collab-colors";
import type { EditorComment } from "./editor-comment-data";

const COMMENT_MARK_INK = "--comment-mark-ink";
const COMMENT_MARK_TINT = "--comment-mark-tint";

type Marked = Pick<EditorComment, "number" | "authorColor" | "authorId" | "authorName">;

/** The inline properties a comment's mark carries: none for an annotation, its author's colour for a thread. */
export function commentMarkProperties(comment: Marked): Record<string, string> {
  if (comment.number) return {};
  const { color, colorLight } = comment.authorColor ?? peerColorForKey(comment.authorId || comment.authorName);
  return { [COMMENT_MARK_INK]: color, [COMMENT_MARK_TINT]: colorLight };
}
