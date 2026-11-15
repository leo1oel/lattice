/**
 * What the Visual page's Overleaf review is made from (`margin-review.tsx`):
 * the owner's payload, the file's threads as comments to mark, and a
 * thread's actions sent back to the owner.
 */
import type { OverleafThread } from "../../../src/app-types";
import type { EditorComment } from "../../../src/editor/comments/editor-comment-data";
import type { MarginReviewMode } from "../../../src/overleaf/margin-review-mode";
import { OVERLEAF_COMMENT_PREFIX, projectOverleafEditorComments } from "../../../src/overleaf/overleaf-editor-comments";
import type { OverleafCommentAnchor } from "../../../src/overleaf/use-overleaf-comments";
import { host } from "../shared/host";

/** What the owner sends (`shell/overleaf_review.rs`). */
export type OverleafReview = {
  threads: OverleafThread[];
  anchors: OverleafCommentAnchor[];
  hues: [string, number][];
  mode: MarginReviewMode;
  canAct: boolean;
};

export const NO_OVERLEAF_REVIEW: OverleafReview = { threads: [], anchors: [], hues: [], mode: "auto", canAct: false };

/** The file's threads as the editor's comment marks take them (`editorCommentsExtension`). */
export function overleafEditorComments(review: OverleafReview, path: string): EditorComment[] {
  const anchors = new Map(review.anchors.map((anchor) => [anchor.threadId, anchor]));
  return projectOverleafEditorComments(review.threads, anchors, new Map([[path, path]]), null, new Map(), new Map(review.hues));
}

/** The Overleaf thread a comment id names, when it is one of theirs. */
export function overleafThreadOf(commentId: string): string | null {
  return commentId.startsWith(OVERLEAF_COMMENT_PREFIX) ? commentId.slice(OVERLEAF_COMMENT_PREFIX.length) : null;
}

/** A thread's actions, as the owner takes them; each settles once sent. */
export const overleafThreadActions = {
  onReply: async (thread: string, content: string) => host().post("tex:overleaf-reply", { thread, content }),
  onResolve: async (thread: string, resolved: boolean) => host().post("tex:overleaf-resolve", { thread, resolved }),
  onDelete: async (thread: string) => host().post("tex:overleaf-delete", { thread }),
  onEditMessage: async (thread: string, message: string, content: string) =>
    host().post("tex:overleaf-edit-message", { thread, message, content }),
  onDeleteMessage: async (thread: string, message: string) => host().post("tex:overleaf-delete-message", { thread, message }),
};
