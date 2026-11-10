import type { EditorView } from "@codemirror/view";
import { resolveCommentAnchor } from "../editor/comments/editor-comment-data";
import type { AnnotationDraft } from "./annotation-composer";

/**
 * Undo on "Note discarded": open the note again on its passage, selected
 * first. The source session closes a note on any update that leaves an empty
 * caret, and the click that dismissed the note usually left one, so opening
 * it alone reopened and closed it at once, its words lost.
 */
export function reopenDiscardedNote(
  view: EditorView | null, activeFile: string, draft: AnnotationDraft,
  open: (view: EditorView, draft: Omit<AnnotationDraft, "id">) => void,
) {
  // Only into the file it was written on.
  if (!view || activeFile !== draft.path) return;
  const range = resolveCommentAnchor(view.state.doc.toString(), draft);
  if (range) view.dispatch({ selection: { anchor: range.from, head: range.to } });
  open(view, { ...draft, ...range, error: null });
}
