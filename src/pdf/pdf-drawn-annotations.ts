import type { EditorComment } from "../editor/comments/editor-comment-data";
import { OVERLEAF_COMMENT_PREFIX } from "../overleaf/overleaf-editor-comments";

/** Notes in these files are typeset into the PDF, so SyncTeX can place them on it (pdf-source-marks.ts). */
const TYPESET = /\.tex$/i;

/**
 * Whether the PDF draws `annotation`: an open, numbered note made on the PDF
 * or in a .tex file, or an open Overleaf thread on a .tex file (unnumbered,
 * as Overleaf has no numbers), so the PDF's comment column holds both.
 */
export function drawnOnPdf(annotation: EditorComment): boolean {
  if (annotation.resolved) return false;
  if (annotation.id.startsWith(OVERLEAF_COMMENT_PREFIX)) return TYPESET.test(annotation.path);
  return Boolean(annotation.number && (annotation.pdf || TYPESET.test(annotation.path)));
}

/** Light a comment's passage on the PDF while the pointer rests on it or on its card in the comment column. */
export function lightMark(root: HTMLElement | undefined, id: string | null) {
  for (const layer of root?.querySelectorAll<HTMLElement>(".pdf-annotation-mark") ?? []) {
    layer.toggleAttribute("data-hovered", layer.dataset.annotationId === id);
  }
}
