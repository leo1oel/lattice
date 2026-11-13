import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { applySourceSelectionEdit } from "./source-selection-edits";

let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function editor(doc: string, selected: string) {
  view = new EditorView({ doc, parent: document.body });
  const from = doc.indexOf(selected);
  view.dispatch({ selection: { anchor: from, head: from + selected.length } });
  return view;
}
const selection = (target: EditorView) => target.state.sliceDoc(target.state.selection.main.from, target.state.selection.main.to);

describe("the LaTeX selection toolbar's edits", () => {
  it.each([
    ["bold", "\\textbf{these words}"],
    ["italic", "\\textit{these words}"],
    ["underline", "\\underline{these words}"],
    ["strikethrough", "\\sout{these words}"],
  ] as const)("toggles %s on and off, keeping the words selected", (action, formatted) => {
    const target = editor("Toggle these words please.", "these words");
    applySourceSelectionEdit(target, action);
    expect(target.state.doc.toString()).toBe(`Toggle ${formatted} please.`);
    expect(selection(target)).toBe("these words");
    applySourceSelectionEdit(target, action);
    expect(target.state.doc.toString()).toBe("Toggle these words please.");
    expect(selection(target)).toBe("these words");
  });

  it("sets, changes and clears a heading level without nesting headings", () => {
    const target = editor("Intro", "Intro");
    applySourceSelectionEdit(target, "heading", "section");
    applySourceSelectionEdit(target, "heading", "subsection");
    expect(target.state.doc.toString()).toBe("\\subsection{Intro}");
    applySourceSelectionEdit(target, "heading", "subsection");
    expect(target.state.doc.toString()).toBe("Intro");
  });

  it("toggles a quote and relinks a link's text instead of nesting another", () => {
    const quoted = editor("A line.", "A line.");
    applySourceSelectionEdit(quoted, "quote");
    expect(quoted.state.doc.toString()).toBe("\\begin{quote}\nA line.\n\\end{quote}");
    applySourceSelectionEdit(quoted, "quote");
    expect(quoted.state.doc.toString()).toBe("A line.");
    quoted.destroy();
    const linked = editor("see docs", "docs");
    applySourceSelectionEdit(linked, "link", "https://a.example");
    applySourceSelectionEdit(linked, "link", "https://b.example/{x}");
    expect(linked.state.doc.toString()).toBe("see \\href{https://b.example/%7Bx%7D}{docs}");
    expect(selection(linked)).toBe("docs");
  });
});
