import type { TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { wrapRange } from "../editor/latex/latex-edits";
import { highlightAround, highlightOpening, recolorHighlight, removeHighlight } from "../editor/latex/latex-highlights";
import type { LatexSelectionAction } from "../editor/latex/latex-selection-toolbar";
import {
  setMarkdownBlock, toggleMarkdownInline, type MarkdownBlockType, type MarkdownInlineFormat,
} from "../editor/markdown/markdown-source-format";

/** A Markdown source toolbar edit: an inline format to toggle or a block type to set. */
type MarkdownSourceEdit = { format: MarkdownInlineFormat } | { block: MarkdownBlockType };

/** What the source editor's selection toolbars ask of the selection. */
export type SourceSelectionAction = LatexSelectionAction | MarkdownSourceEdit;

/** Apply `spec` to `view`, scrolling the result into view, and hand the editor focus back. */
export function editAndFocus(view: EditorView, spec: TransactionSpec) {
  view.dispatch({ ...spec, scrollIntoView: true });
  view.focus();
}

/** LaTeX wrappers the floating selection toolbar applies; null declines the edit. */
const SELECTION_WRAPS: Record<Exclude<LatexSelectionAction, "comment" | "proofread" | "polish" | "rewrite" | "unhighlight">, (value?: string) => [string, string] | null> = {
  bold: () => ["\\textbf{", "}"],
  italic: () => ["\\textit{", "}"],
  underline: () => ["\\underline{", "}"],
  strikethrough: () => ["\\sout{", "}"],
  highlight: (value) => [highlightOpening(value ?? ""), "}"],
  heading: (value) => [`\\${value || "section"}{`, "}"],
  quote: () => ["\\begin{quote}\n", "\n\\end{quote}"],
  link: (value) => {
    const url = value?.trim();
    if (!url) return null;
    // eslint-disable-next-line lingui/no-unlocalized-strings -- percent-encodings
    const safeUrl = url.replace(/\\/g, "%5C").replace(/\{/g, "%7B").replace(/\}/g, "%7D");
    return [`\\href{${safeUrl}}{`, "}"];
  },
};

/** Apply a formatting `action` (not comment, proofread, polish or rewrite) to the main selection. */
export function applySourceSelectionEdit(view: EditorView, action: Exclude<SourceSelectionAction, "comment" | "proofread" | "polish" | "rewrite">, value?: string) {
  if (typeof action === "object") {
    const spec = "format" in action ? toggleMarkdownInline(view.state, action.format) : setMarkdownBlock(view.state, action.block);
    if (spec) editAndFocus(view, spec);
    return;
  }
  const range = view.state.selection.main;
  // Remove takes off the highlight around the selection; a colour chosen for
  // a whole highlight recolours it rather than nesting another inside.
  if (action === "highlight" || action === "unhighlight") {
    const around = highlightAround(view.state.doc, range.from, range.to);
    const whole = around && ((around.contentFrom === range.from && around.contentTo === range.to)
      || (around.from === range.from && around.to === range.to));
    const target = action === "unhighlight" || whole ? around : null;
    if (target) {
      const changes = view.state.changes(action === "unhighlight" ? removeHighlight(target) : [recolorHighlight(target, value ?? "")]);
      editAndFocus(view, {
        changes,
        selection: { anchor: changes.mapPos(target.contentFrom, 1), head: changes.mapPos(target.contentTo, -1) },
      });
      return;
    }
    if (action === "unhighlight") return;
  }
  const wrap = SELECTION_WRAPS[action](value);
  if (!wrap) return;
  const edit = wrapRange(view.state.doc.toString(), range.from, range.to, ...wrap);
  editAndFocus(view, { changes: edit, selection: { anchor: edit.cursorFrom, head: edit.cursorTo } });
}
