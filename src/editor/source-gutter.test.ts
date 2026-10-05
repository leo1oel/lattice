import { afterEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { foldEffect, foldService } from "@codemirror/language";
import { sourceGutter } from "./source-gutter";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

// Line 1 folds over line 2: enough to put a marker on the first line.
const foldFirstLine = foldService.of((state, from) => (from === 0 ? { from: state.doc.line(1).to, to: state.doc.line(2).to } : null));

function editor() {
  const view = new EditorView({
    state: EditorState.create({ doc: "one\ntwo\nthree", extensions: [sourceGutter(), foldFirstLine] }),
    parent: document.body,
  });
  views.push(view);
  return view;
}
const markers = (view: EditorView) =>
  [...view.dom.querySelectorAll<HTMLElement>(".cm-foldGutter .cm-gutterElement:not([style*='hidden']) .cm-lattice-fold-marker")];

describe("sourceGutter", () => {
  it("draws line numbers and the fold column together from the first paint", () => {
    const view = editor();
    const columns = [...view.dom.querySelectorAll(".cm-gutters > .cm-gutter")].map((column) => column.className);
    expect(columns).toEqual([expect.stringContaining("cm-lineNumbers"), expect.stringContaining("cm-foldGutter")]);
    const [marker] = markers(view);
    expect(marker.querySelector("svg")).not.toBeNull();
    expect(marker.dataset.folded).toBeUndefined();
    expect(marker.title).toBe("Fold line");
  });

  it("marks a folded range so the stylesheet can keep its marker visible", () => {
    const view = editor();
    view.dispatch({ effects: foldEffect.of({ from: 3, to: 7 }) });
    const [marker] = markers(view);
    expect(marker.dataset.folded).toBe("");
    expect(marker.title).toBe("Unfold line");
  });
});
