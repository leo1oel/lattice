import { EditorView } from "@codemirror/view";
import { clamp } from "../../settings/app-settings";
import { highlightAround } from "./latex-highlights";
import type { LatexSelectionToolbarPosition } from "./latex-selection-toolbar";

export type SelectionToolbarPlacement = {
  position: LatexSelectionToolbarPosition;
  /** The colour of the highlight around the selection, "" for an uncoloured one, null outside one. */
  highlight: string | null;
  from: number;
  to: number;
};

/** When each view's last input-method composition ended. */
const compositionEndedAt = new WeakMap<EditorView, number>();

/** Records composition ends for `selectionToolbarPlacement`; one of the source editor's extensions. */
export const compositionEndTracker = EditorView.domEventObservers({
  compositionend: (_event, view) => {
    compositionEndedAt.set(view, Date.now());
  },
});

/**
 * An input method's marked text (pinyin before a candidate is picked) can
 * arrive as a selection over the composing range. WebKit also selects the
 * composition to replace it when a candidate or a punctuation mark is
 * committed, after compositionend, so CodeMirror reads that selection once
 * the view no longer reports composing. Either opened the toolbar for a
 * moment until the text landed.
 */
function composingOrCommitting(view: EditorView) {
  return view.compositionStarted || Date.now() - (compositionEndedAt.get(view) ?? Number.NEGATIVE_INFINITY) < 100;
}

/**
 * Where the source editor's selection toolbar sits for the view's selection,
 * or null when it should not show.
 */
export function selectionToolbarPlacement(view: EditorView, path: string): SelectionToolbarPlacement | null {
  const range = view.state.selection.main;
  // A tab behind another one stays laid out (inert, hidden), so its
  // coordinates look valid; the toolbar is portaled and would not hide.
  const wrappable = !range.empty && !composingOrCommitting(view)
    && (path.endsWith(".tex") || path.toLocaleLowerCase().endsWith(".md"))
    && !view.dom.closest("[inert]");
  const visibleRange = wrappable
    ? view.visibleRanges.find(({ from, to }) => range.from <= to && range.to >= from)
    : undefined;
  const editorBounds = visibleRange && view.dom.closest(".source-editor")?.getBoundingClientRect();
  const visibleFrom = Math.max(range.from, visibleRange?.from ?? 0);
  const start = visibleRange && view.coordsAtPos(visibleFrom);
  const end = visibleRange && view.coordsAtPos(Math.min(range.to, visibleRange.to, view.state.doc.lineAt(visibleFrom).to));
  if (!editorBounds || !start || !end) return null;
  const halfWidth = Math.min(350, Math.max(0, editorBounds.width - 16)) / 2;
  const selectionCenter = start.top === end.top
    ? (start.left + end.right) / 2
    : start.left + Math.min(72, Math.max(20, editorBounds.width / 5));
  const left = clamp(selectionCenter, editorBounds.left + halfWidth + 8, editorBounds.right - halfWidth - 8);
  const selectionTop = Math.min(start.top, end.top);
  const below = selectionTop - editorBounds.top < 52;
  // A highlight around the selection: the palette ticks its colour and offers Remove.
  const highlight = path.endsWith(".tex") ? highlightAround(view.state.doc, range.from, range.to) : null;
  return {
    position: { left, top: below ? start.bottom + 8 : selectionTop - 8, below, maxWidth: Math.max(0, editorBounds.width - 16) },
    highlight: highlight ? highlight.color ?? "" : null,
    from: range.from,
    to: range.to,
  };
}
