/**
 * Marks laid over a source editor's text for the writer to see: tracked
 * changes (Overleaf's and review mode's), comments and the note being
 * written, collaborators' carets, a proofread or annotation under review.
 *
 * A drawing that hides source text (LaTeX's Visual mode, which replaces
 * `\textbf{` or a formula with what it stands for) would hide these marks
 * with it. Each overlay names its ranges here, and such a drawing leaves the
 * source under any of them showing, so a change, a comment or someone's
 * caret is never drawn over.
 */
import { Facet, RangeSet, type EditorState, type RangeValue, type StateField } from "@codemirror/state";

/** Each overlay's ranges in a state (a decoration set, usually its own). */
export const sourceOverlays = Facet.define<(state: EditorState) => RangeSet<RangeValue>>();

/** Registers the decoration set `field` holds as an overlay. */
export function overlayFrom<T>(field: StateField<T>, ranges: (value: T) => RangeSet<RangeValue>) {
  return sourceOverlays.of((state) => {
    const value = state.field(field, false);
    return value === undefined ? RangeSet.empty : ranges(value);
  });
}

/** Whether any of `sets` (the overlays' ranges in one state) touches `[from, to]`. */
export function overlaysTouch(sets: readonly RangeSet<RangeValue>[], from: number, to: number): boolean {
  for (const set of sets) {
    let touched = false;
    set.between(from, to, () => {
      touched = true;
      return false;
    });
    if (touched) return true;
  }
  return false;
}
