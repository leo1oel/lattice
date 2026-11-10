import { Annotation } from "@codemirror/state";
import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { watchPointerHold, type PointerHold } from "../lib/pointer-hold";

/** Marks the empty transaction a source editor dispatches when a held press ends. */
const pointerReleased = Annotation.define<true>();

const pointerHold = ViewPlugin.fromClass(class {
  // A disposed hold never releases, so a destroyed view is never dispatched to.
  readonly hold: PointerHold;
  constructor(view: EditorView) {
    this.hold = watchPointerHold(view.dom, () => view.dispatch({ annotations: pointerReleased.of(true) }));
  }
  destroy() {
    this.hold.dispose();
  }
});

/**
 * Lets the source editor's selection listeners skip a drag in progress
 * (`lib/pointer-hold.ts`): while `pointerSelecting(view)`, a selection is still
 * being drawn out, and the update that ends the press is
 * `pointerSelectionSettled`, even when the selection did not change on it.
 */
export const pointerSelection = pointerHold;

export function pointerSelecting(view: EditorView): boolean {
  return view.plugin(pointerHold)?.hold.held() ?? false;
}

export function pointerSelectionSettled(update: ViewUpdate): boolean {
  return update.transactions.some((transaction) => transaction.annotation(pointerReleased) === true);
}
