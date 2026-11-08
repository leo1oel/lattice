/**
 * Where the one popover that hosts every hover card hangs from.
 *
 * CodeMirror puts all the hover cards showing at once into one popover,
 * anchored at the earliest `pos` among them, yet drops each card once the
 * pointer leaves that card's own range outside the popover. Under a comment,
 * the earliest `pos` is where the comment starts, often rows above the
 * hovered `\ref`, figure path or suggestion; moving up toward the popover
 * then crossed commented text, which kept the comment and dropped the other
 * card before the pointer got there (#707, and S17 of the state audit).
 *
 * A card can place the popover itself with `getCoords`, but CodeMirror uses
 * it only when every card that gives one gives the very same function;
 * two different closures and it falls back to the earliest `pos` again. So
 * every Lattice card takes its `getCoords` from here: one function per view,
 * reading the position of the card created last, which is the one the
 * pointer just reached. The comment card gives none, and so follows it.
 */
import type { EditorView, Rect } from "@codemirror/view";

const NOWHERE: Rect = { left: 0, right: 0, top: 0, bottom: 0 };
const anchors = new WeakMap<EditorView, { pos: number; getCoords: () => Rect }>();

/** Hang the popover from `pos`; returns the view's one `getCoords` for the card's view. */
export function hoverAnchor(view: EditorView, pos: number): () => Rect {
  let anchor = anchors.get(view);
  if (!anchor) {
    const created = {
      pos,
      // Clamped: an edit can shorten the document under a card still open.
      getCoords: () => view.coordsAtPos(Math.min(created.pos, view.state.doc.length), 1) ?? NOWHERE,
    };
    anchors.set(view, created);
    anchor = created;
  }
  anchor.pos = pos;
  return anchor.getCoords;
}
