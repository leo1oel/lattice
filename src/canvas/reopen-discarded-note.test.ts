import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnotationDraft } from "./annotation-composer";
import { reopenDiscardedNote } from "./reopen-discarded-note";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((view) => view.destroy()));

const draft: AnnotationDraft = {
  path: "main.tex", from: 6, to: 10, quote: "bold", prefix: "Hello ", suffix: " world", line: 1,
  body: "Keep this draft", error: "Could not save",
};

/** An editor whose caret sits where the click that dismissed the note left it. */
function editor(doc: string) {
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc, selection: { anchor: 2 } }) });
  views.push(view);
  return view;
}

describe("reopenDiscardedNote", () => {
  // The source session closes a note on any update that leaves an empty
  // caret, so the passage has to be selected before the note opens.
  it("selects the note's passage, then opens it there", () => {
    const view = editor("Hello bold world");
    const open = vi.fn((opened: EditorView) => {
      expect(opened.state.selection.main).toMatchObject({ from: 6, to: 10 });
    });
    reopenDiscardedNote(view, "main.tex", draft, open);
    expect(open).toHaveBeenCalledWith(view, { ...draft, error: null });
  });

  it("follows the passage when the text before it changed meanwhile", () => {
    const view = editor("Oh. Hello bold world");
    const open = vi.fn();
    reopenDiscardedNote(view, "main.tex", draft, open);
    expect(view.state.selection.main).toMatchObject({ from: 10, to: 14 });
    expect(open).toHaveBeenCalledWith(view, expect.objectContaining({ from: 10, to: 14, body: "Keep this draft" }));
  });

  it("opens nothing in another file", () => {
    const open = vi.fn();
    reopenDiscardedNote(editor("Hello bold world"), "intro.tex", draft, open);
    expect(open).not.toHaveBeenCalled();
  });
});
