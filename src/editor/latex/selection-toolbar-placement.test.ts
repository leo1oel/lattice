import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compositionEndTracker, selectionToolbarPlacement } from "./selection-toolbar-placement";

let view: EditorView | null = null;

afterEach(() => {
  const host = view?.dom.parentElement;
  view?.destroy();
  host?.remove();
  view = null;
  vi.restoreAllMocks();
});

/** A source editor holding `doc`. jsdom has no text layout, so it reports fixed bounds and coordinates. */
function sourceView(doc: string) {
  const host = document.body.appendChild(document.createElement("div"));
  host.className = "source-editor";
  view = new EditorView({ doc, parent: host, extensions: compositionEndTracker });
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

  // A scroll with a selection held places it again every frame (#777).
  it("reads the selection again only once it or the document changed", async () => {
    const latexHighlights = await import("./latex-highlights");
    const highlightAround = vi.spyOn(latexHighlights, "highlightAround");
    const editor = sourceView("Hello \\hl{bold} world");
    editor.dispatch({ selection: { anchor: 10, head: 14 } });
    const shown = selectionToolbarPlacement(editor, "main.tex")!;
    expect(shown.highlight).toBe("");
    expect(highlightAround).toHaveBeenCalledOnce();
    // Nothing moved: the same placement, so the toolbar does not render again.
    expect(selectionToolbarPlacement(editor, "main.tex", shown)).toBe(shown);
    vi.spyOn(editor, "coordsAtPos").mockImplementation(() => ({ left: 100, right: 150, top: 60, bottom: 80 }));
    const scrolled = selectionToolbarPlacement(editor, "main.tex", shown)!;
    expect(scrolled.position.top).toBe(52);
    expect(scrolled.highlight).toBe("");
    expect(highlightAround).toHaveBeenCalledOnce();
    editor.dispatch({ selection: { anchor: 0, head: 5 } });
    expect(selectionToolbarPlacement(editor, "main.tex", scrolled)).toMatchObject({ from: 0, to: 5, highlight: null });
    expect(highlightAround).toHaveBeenCalledTimes(2);
  });

  it("reads the formats a LaTeX selection already has, for the toolbar's pressed buttons", () => {
    const editor = sourceView("Hello \\textbf{\\emph{bold}} world");
    editor.dispatch({ selection: { anchor: 20, head: 24 } });
    const formats = selectionToolbarPlacement(editor, "main.tex")!.latexFormats!;
    expect([...formats.inline].sort()).toEqual(["bold", "italic"]);
    editor.dispatch({ selection: { anchor: 0, head: 5 } });
    expect([...selectionToolbarPlacement(editor, "main.tex")!.latexFormats!.inline]).toEqual([]);
    expect(selectionToolbarPlacement(editor, "notes.md")!.latexFormats).toBeNull();
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
    // WebKit commits a candidate by selecting the composition after
    // compositionend; CodeMirror reads that selection before the text lands.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    compose(editor, "compositionend", "你好");
    expect(editor.compositionStarted).toBe(false);
    editor.dispatch({ selection: { anchor: 5, head: 11 } });
    expect(selectionToolbarPlacement(editor, "main.tex")).toBeNull();
    clock.mockReturnValue(now + 50);
    editor.dispatch({ changes: { from: 5, to: 11, insert: "你好" }, selection: { anchor: 7 } });
    expect(selectionToolbarPlacement(editor, "main.tex")).toBeNull();
    // Composition over, a selection made with the mouse or keyboard shows it again.
    clock.mockReturnValue(now + 500);
    editor.dispatch({ selection: { anchor: 5, head: 7 } });
    expect(selectionToolbarPlacement(editor, "main.tex")).toMatchObject({ from: 5, to: 7 });
  });
});
