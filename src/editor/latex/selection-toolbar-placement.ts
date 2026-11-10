import type { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { clamp } from "../../lib/clamp";
import { highlightAround } from "./latex-highlights";
import type { LatexSelectionToolbarPosition } from "./latex-selection-toolbar";
import { markdownSelectionFormat, type MarkdownSelectionFormat } from "../markdown/markdown-source-format";

export type SelectionToolbarPlacement = {
  position: LatexSelectionToolbarPosition;
  /** The colour of the highlight around the selection, "" for an uncoloured one, null outside one. */
  highlight: string | null;
  /** What a Markdown selection already is, for the Markdown toolbar's pressed buttons; null for LaTeX. */
  format: MarkdownSelectionFormat | null;
  from: number;
  to: number;
  /** The document and file the selection was read in. */
  doc: Text;
  path: string;
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
 * or null when it should not show. Given the placement shown, it reads the
 * selection again only when the selection or the document changed: a scroll
 * with a selection held places the toolbar again every frame, and reading
 * the highlight around a long selection scans all of it.
 */
export function selectionToolbarPlacement(
  view: EditorView,
  path: string,
  previous?: SelectionToolbarPlacement | null,
): SelectionToolbarPlacement | null {
  const range = view.state.selection.main;
  // A tab behind another one stays laid out (inert, hidden), so its
  // coordinates look valid; the toolbar is portaled and would not hide.
  const markdown = path.toLocaleLowerCase().endsWith(".md");
  const wrappable = !range.empty && !composingOrCommitting(view) && (path.endsWith(".tex") || markdown)
    && !view.dom.closest("[inert]");
  const visibleRange = wrappable
    ? view.visibleRanges.find(({ from, to }) => range.from <= to && range.to >= from)
    : undefined;
  const editorBounds = visibleRange && view.dom.closest(".source-editor")?.getBoundingClientRect();
  const visibleFrom = Math.max(range.from, visibleRange?.from ?? 0);
  const start = visibleRange && view.coordsAtPos(visibleFrom);
  const end = visibleRange && view.coordsAtPos(Math.min(range.to, visibleRange.to, view.state.doc.lineAt(visibleFrom).to));
  if (!editorBounds || !start || !end) return null;
  // About the toolbar's width: the Markdown one carries the block type menu too.
  const halfWidth = Math.min(markdown ? 420 : 350, Math.max(0, editorBounds.width - 16)) / 2;
  const selectionCenter = start.top === end.top
    ? (start.left + end.right) / 2
    : start.left + Math.min(72, Math.max(20, editorBounds.width / 5));
  const left = clamp(selectionCenter, editorBounds.left + halfWidth + 8, editorBounds.right - halfWidth - 8);
  const selectionTop = Math.min(start.top, end.top);
  const below = selectionTop - editorBounds.top < 52;
  const position = {
    left, top: below ? start.bottom + 8 : selectionTop - 8, below, maxWidth: Math.max(0, editorBounds.width - 16),
    bounds: { left: editorBounds.left + 8, right: editorBounds.right - 8 },
  };
  if (previous && previous.from === range.from && previous.to === range.to && previous.doc === view.state.doc && previous.path === path) {
    // Only its place moved (a scroll, a resize): what the selection is was
    // read already, and an unmoved toolbar keeps its identity.
    return samePosition(previous.position, position) ? previous : { ...previous, position };
  }
  // A highlight around the selection: the palette ticks its colour and offers Remove.
  const highlight = path.endsWith(".tex") ? highlightAround(view.state.doc, range.from, range.to) : null;
  return {
    position,
    highlight: highlight ? highlight.color ?? "" : null,
    format: markdown ? markdownSelectionFormat(view.state) : null,
    from: range.from,
    to: range.to,
    doc: view.state.doc,
    path,
  };
}

function samePosition(a: LatexSelectionToolbarPosition, b: LatexSelectionToolbarPosition) {
  return a.left === b.left && a.top === b.top && a.below === b.below && a.maxWidth === b.maxWidth
    && a.bounds?.left === b.bounds?.left && a.bounds?.right === b.bounds?.right;
}

/*
 * The palette's Rewrite selection… opens the toolbar's Rewrite menu. The
 * palette took focus, which put the toolbar away, so the canvas shows it again
 * and the ask waits a moment for it. Here rather than in the toolbar, whose
 * module exports only components.
 */
const openers = new Set<() => void>();
/** When an ask that no toolbar was there to take was made. */
let askedAt = Number.NEGATIVE_INFINITY;

/**
 * Open the shown toolbar's Rewrite menu; with none shown, `show` one, whose
 * menu opens if it comes within a second.
 */
export function openRewriteMenu(show: () => void) {
  if (openers.size === 0) askedAt = Date.now();
  for (const open of openers) open();
  show();
}

/** A shown toolbar listens until the returned stop runs, taking an ask that waited for it. */
export function listenForRewriteMenu(open: () => void): () => void {
  openers.add(open);
  if (Date.now() - askedAt < 1000) {
    askedAt = Number.NEGATIVE_INFINITY;
    open();
  }
  return () => { openers.delete(open); };
}
