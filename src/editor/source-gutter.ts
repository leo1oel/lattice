/**
 * The source editors' gutter: line numbers and fold markers as one column
 * whose width never changes under the text.
 *
 * Both the live editor (codemirror-host) and Trellis's read-only snapshot of
 * a document beside it mount this same extension. The snapshot used to draw
 * line numbers alone, so every tab switch painted it first and then swapped
 * in the live editor with an extra fold column: the text jumped right and
 * the arrows appeared late. The column's width is pinned in CSS
 * (editor-workspace.css: four digits plus the fold column), which also keeps
 * a document crossing 999 -> 1,000 lines, or switching to a longer file, from
 * shifting the text; past 9,999 lines CodeMirror's own spacer, measured from
 * the line count when the view is created, takes over.
 *
 * Fold markers are quiet: the stylesheet shows them while the pointer is over
 * the gutter, and always for a folded range, which otherwise has only its
 * placeholder to say so. Folding by key (foldKeymap) is unchanged.
 */
import { msg } from "@lingui/core/macro";
import type { Extension } from "@codemirror/state";
import { lineNumbers } from "@codemirror/view";
import { foldGutter } from "@codemirror/language";
import { i18n } from "../i18n";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * One chevron for both states, rotated by CSS when folded: CodeMirror's
 * default ⌄ and › glyphs differ in width and baseline from font to font, so
 * the marker sat low and the column had to be sized for the wider of them.
 * `open` is CodeMirror's sense: the range is unfolded and can be folded.
 */
function foldMarkerDOM(open: boolean): HTMLElement {
  const marker = document.createElement("span");
  marker.className = "cm-lattice-fold-marker";
  if (!open) marker.dataset.folded = "";
  // markerDOM gets no view, so these resolve here rather than through state.phrase.
  marker.title = i18n._(open ? msg`Fold line` : msg`Unfold line`);
  const icon = document.createElementNS(SVG_NS, "svg");
  icon.setAttribute("viewBox", "0 0 12 12");
  icon.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M3.25 4.75 6 7.5l2.75-2.75");
  icon.append(path);
  marker.append(icon);
  return marker;
}

/** Line numbers and fold markers, shared by every source editor and its snapshot. */
export function sourceGutter(): Extension {
  return [lineNumbers(), foldGutter({ markerDOM: foldMarkerDOM })];
}
