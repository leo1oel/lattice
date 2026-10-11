import { EditorSelection, Facet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, layer, RectangleMarker } from "@codemirror/view";

/**
 * Where a drag over the editor would land, given the position under the
 * pointer: a document position, null when that drop inserts nothing, or
 * undefined to leave the drag to the next resolver and, last, to the pointer.
 */
export type DropPointResolver = (view: EditorView, event: DragEvent, pointer: number) => number | null | undefined;

/** Lets a drop handler that moves its insertion (a citation snapping to a word end) put the caret there too. */
export const dropPoint = Facet.define<DropPointResolver>();

const setDropCaret = StateEffect.define<number | null>({
  map: (position, mapping) => position === null ? null : mapping.mapPos(position),
});

const dropCaret = StateField.define<number | null>({
  create: () => null,
  update(position, transaction) {
    let next = position === null ? null : transaction.changes.mapPos(position);
    for (const effect of transaction.effects) if (effect.is(setDropCaret)) next = effect.value;
    return next;
  },
});

function placeDropCaret(view: EditorView, position: number | null) {
  if (view.state.field(dropCaret) !== position) view.dispatch({ effects: setDropCaret.of(position) });
}

/**
 * CodeMirror's `dropCursor()`, except that the caret goes where the drop
 * will insert rather than where the pointer is. Drawn as a layer marker with
 * the stock `cm-dropCursor` class, so the editor's caret styling applies.
 */
export function dropCursor() {
  return [
    dropCaret,
    EditorView.domEventObservers({
      dragover(event, view) {
        const pointer = view.posAtCoords({ x: event.clientX, y: event.clientY });
        let position: number | null | undefined = pointer;
        if (pointer !== null) {
          for (const resolve of view.state.facet(dropPoint)) {
            position = resolve(view, event, pointer);
            if (position !== undefined) break;
          }
        }
        placeDropCaret(view, position ?? null);
      },
      dragleave(event, view) {
        if (event.target === view.contentDOM || !view.contentDOM.contains(event.relatedTarget as Node | null)) placeDropCaret(view, null);
      },
      dragend: (_event, view) => placeDropCaret(view, null),
      drop: (_event, view) => placeDropCaret(view, null),
    }),
    layer({
      above: true,
      class: "cm-dropCursorLayer",
      markers(view) {
        const position = view.state.field(dropCaret);
        // eslint-disable-next-line lingui/no-unlocalized-strings -- CodeMirror's drop caret class
        return position === null ? [] : RectangleMarker.forRange(view, "cm-dropCursor", EditorSelection.cursor(position));
      },
      update: (update) => update.state.field(dropCaret) !== update.startState.field(dropCaret)
        || update.docChanged || update.geometryChanged || update.viewportChanged,
    }),
  ];
}
