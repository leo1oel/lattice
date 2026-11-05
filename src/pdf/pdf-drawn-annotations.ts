import type { EditorComment } from "../editor/comments/editor-comment-data";

/** Notes in these files are typeset into the PDF, so SyncTeX can place them on it (pdf-source-marks.ts). */
const TYPESET = /\.tex$/i;

/** Whether the PDF draws `annotation`: an open, numbered note made on the PDF or in a .tex file. */
export function drawnOnPdf(annotation: EditorComment): boolean {
  return Boolean(annotation.number && !annotation.resolved && (annotation.pdf || TYPESET.test(annotation.path)));
}
