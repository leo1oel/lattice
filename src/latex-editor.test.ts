import { describe, expect, it } from "vitest";
import { citationCompletionRange, latexEditorExtensions, shouldInsertCommandBraces } from "./latex-editor";

describe("LaTeX citation editing", () => {
  it("adds braces after citation and reference commands", () => {
    expect(shouldInsertCommandBraces("Text \\cite")).toBe(true);
    expect(shouldInsertCommandBraces("See \\citet")).toBe(true);
    expect(shouldInsertCommandBraces("Equation \\eqref")).toBe(true);
    expect(shouldInsertCommandBraces("not a command cite")).toBe(false);
  });

  it("completes the current key inside citation braces", () => {
    expect(citationCompletionRange("Text \\cite{vas", 14)).toEqual({ from: 11, query: "vas" });
    expect(citationCompletionRange("Text \\cite{first, trans", 23)).toEqual({ from: 18, query: "trans" });
    expect(citationCompletionRange("Text \\section{intro", 19)).toBeNull();
  });

  it("inserts braces in the editor and keeps an existing pair", () => {
    const parent = document.createElement("div");
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "\\cit",
        selection: { anchor: 4 },
        extensions: latexEditorExtensions(["vaswani2017attention"]),
      }),
    });
    view.dispatch({
      changes: { from: 4, insert: "e" },
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    expect(view.state.doc.toString()).toBe("\\cite{}");
    view.destroy();

    const existing = new EditorView({
      parent,
      state: EditorState.create({
        doc: "\\cit{}",
        selection: { anchor: 4 },
        extensions: latexEditorExtensions([]),
      }),
    });
    existing.dispatch({
      changes: { from: 4, insert: "e" },
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    expect(existing.state.doc.toString()).toBe("\\cite{}");
    existing.destroy();
  });
});
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
