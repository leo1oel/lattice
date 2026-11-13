import type { Text, TransactionSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { wrapRange } from "../editor/latex/latex-edits";
import {
  setLatexHeading, setLatexLink, toggleLatexInline, toggleLatexQuote, type FormatEdit,
} from "../editor/latex/latex-format-toggle";
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

/** The URL the toolbar's Link writes, its backslashes and braces percent-encoded so `\href` reads it. */
function linkTarget(value?: string): string | null {
  const url = value?.trim();
  if (!url) return null;
  // eslint-disable-next-line lingui/no-unlocalized-strings -- percent-encodings
  return url.replace(/\\/g, "%5C").replace(/\{/g, "%7B").replace(/\}/g, "%7D");
}

/**
 * The toolbar's formats, each a toggle (latex-format-toggle.ts): a selection
 * already bold loses Bold rather than gaining a second `\textbf`. Null
 * declines the edit.
 */
const SELECTION_FORMATS: Record<Exclude<LatexSelectionAction, "comment" | "proofread" | "polish" | "rewrite" | "highlight" | "unhighlight">, (doc: Text, from: number, to: number, value?: string) => FormatEdit | null> = {
  bold: (doc, from, to) => toggleLatexInline(doc, from, to, "bold"),
  italic: (doc, from, to) => toggleLatexInline(doc, from, to, "italic"),
  underline: (doc, from, to) => toggleLatexInline(doc, from, to, "underline"),
  strikethrough: (doc, from, to) => toggleLatexInline(doc, from, to, "strikethrough"),
  heading: (doc, from, to, value) => setLatexHeading(doc, from, to, value || "section"),
  quote: (doc, from, to) => toggleLatexQuote(doc, from, to),
  link: (doc, from, to, value) => {
    const url = linkTarget(value);
    return url ? setLatexLink(doc, from, to, url) : null;
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
  if (action === "highlight") {
    const edit = wrapRange(view.state.doc.toString(), range.from, range.to, highlightOpening(value ?? ""), "}");
    editAndFocus(view, { changes: edit, selection: { anchor: edit.cursorFrom, head: edit.cursorTo } });
    return;
  }
  const edit = SELECTION_FORMATS[action](view.state.doc, range.from, range.to, value);
  if (edit) editAndFocus(view, edit);
}
