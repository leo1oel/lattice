import { completionStatus, currentCompletions } from "@codemirror/autocomplete";
import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { citationCompletionRange, latexEditorExtensions, latexLanguageOptions, shouldInsertCommandBraces } from "./latex-editor";

describe("LaTeX citation editing", () => {
  it("soft-wraps long logical lines instead of scrolling horizontally", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "A single logical line that can wrap across several visual rows.",
        extensions: latexEditorExtensions([]),
      }),
    });
    expect(view.contentDOM).toHaveClass("cm-lineWrapping");
    view.destroy();
  });

  it("uses build output instead of parser diagnostics and hover documentation", () => {
    expect(latexLanguageOptions).toMatchObject({
      enableLinting: false,
      enableTooltips: false,
    });
  });

  it("adds braces after citation and reference commands", () => {
    expect(shouldInsertCommandBraces("Text \\cite")).toBe(true);
    expect(shouldInsertCommandBraces("See \\citet")).toBe(true);
    expect(shouldInsertCommandBraces("Equation \\eqref")).toBe(true);
    expect(shouldInsertCommandBraces("not a command cite")).toBe(false);
  });

  it("completes the current key inside citation braces", () => {
    expect(citationCompletionRange("Text \\cite{", 11)).toEqual({ from: 11, query: "" });
    expect(citationCompletionRange("Text \\cite{vas", 14)).toEqual({ from: 11, query: "vas" });
    expect(citationCompletionRange("Text \\cite{first,", 17)).toEqual({ from: 17, query: "" });
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

  it("adds braces when a citation command is accepted from completion", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "\\ci",
        selection: { anchor: 3 },
        extensions: latexEditorExtensions([]),
      }),
    });
    view.dispatch({
      changes: { from: 0, to: 3, insert: "\\cite" },
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of("input.complete"),
    });
    expect(view.state.doc.toString()).toBe("\\cite{}");
    view.destroy();
  });

  it("shows citation keys immediately for an empty slot and after a comma", async () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "\\cit",
        selection: { anchor: 4 },
        extensions: latexEditorExtensions(["vaswani2017attention", "dosovitskiy2021image"]),
      }),
    });
    view.dispatch({
      changes: { from: 4, insert: "e" },
      selection: { anchor: 5 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(currentCompletions(view.state).map((completion) => completion.label)).toEqual([
      "dosovitskiy2021image",
      "vaswani2017attention",
    ]);
    expect(currentCompletions(view.state).every((completion) => completion.detail === undefined)).toBe(true);

    view.dispatch({
      changes: { from: 6, insert: "first," },
      selection: { anchor: 12 },
      annotations: Transaction.userEvent.of("input.type"),
    });
    await vi.waitFor(() => expect(completionStatus(view.state)).toBe("active"));
    expect(currentCompletions(view.state).map((completion) => completion.label)).toContain("vaswani2017attention");
    view.destroy();
  });
});
