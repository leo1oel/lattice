import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { selectionToolbarPlacement } from "./selection-toolbar-placement";

let view: EditorView | null = null;

afterEach(() => {
  const host = view?.dom.parentElement;
  view?.destroy();
  host?.remove();
  view = null;
});

/** A source editor holding `doc`. jsdom has no text layout, so it reports fixed bounds and coordinates. */
function sourceView(doc: string) {
  const host = document.body.appendChild(document.createElement("div"));
  host.className = "source-editor";
  view = new EditorView({ doc, parent: host });
  vi.spyOn(host, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 600, 500));
  vi.spyOn(view, "coordsAtPos").mockImplementation(() => ({ left: 100, right: 150, top: 100, bottom: 120 }));
  return view;
}

const compose = (target: EditorView, type: "compositionstart" | "compositionupdate" | "compositionend", data: string) =>
  target.contentDOM.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));

describe("selectionToolbarPlacement", () => {
  it("places the toolbar over a real selection", () => {
    const editor = sourceView("Hello bold world");
    editor.dispatch({ selection: { anchor: 6, head: 10 } });
    expect(selectionToolbarPlacement(editor, "main.tex")).toMatchObject({ from: 6, to: 10, position: { below: false } });
    editor.dispatch({ selection: { anchor: 8 } });
    expect(selectionToolbarPlacement(editor, "main.tex")).toBeNull();
  });

  it("stays hidden while an input method composes over a selected range", () => {
    const editor = sourceView("Hello world");
    editor.dispatch({ selection: { anchor: 5 } });
    // Pinyin marked text that the input method reports as selected: the
    // editor's selection covers the composing range at every step.
    compose(editor, "compositionstart", "");
    for (const marked of ["n", "ni", "ni h", "ni hao"]) {
      compose(editor, "compositionupdate", marked);
      editor.dispatch({ changes: { from: 5, to: editor.state.selection.main.to, insert: marked }, selection: { anchor: 5, head: 5 + marked.length } });
      expect(selectionToolbarPlacement(editor, "main.tex")).toBeNull();
      expect(selectionToolbarPlacement(editor, "notes.md")).toBeNull();
    }
    compose(editor, "compositionend", "你好");
    editor.dispatch({ changes: { from: 5, to: 11, insert: "你好" }, selection: { anchor: 7 } });
    expect(selectionToolbarPlacement(editor, "main.tex")).toBeNull();
    // Composition over, a selection made with the mouse or keyboard shows it again.
    editor.dispatch({ selection: { anchor: 5, head: 7 } });
    expect(selectionToolbarPlacement(editor, "main.tex")).toMatchObject({ from: 5, to: 7 });
  });
});
