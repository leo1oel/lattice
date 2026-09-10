import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setDiagnostics } from "@codemirror/lint";
import { describe, expect, it } from "vitest";
import { editorTexlabDiagnosticsForFile } from "./texlab-diagnostics";

describe("editorTexlabDiagnosticsForFile", () => {
  const boxWarning = {
    file: "main.tex", line: 1, column: 1, endLine: 1, endColumn: 1,
    level: "warning",
    message: "Underfull \\hbox (badness 1953) in paragraph at lines 157--160",
  };

  it.each([
    boxWarning.message,
    "Overfull \\hbox (1.5pt too wide) in paragraph at lines 157--160",
    "Underfull \\vbox (badness 10000) has occurred while \\output is active",
    "Overfull \\vbox (2.0pt too high) has occurred while \\output is active",
  ])("does not underline documentclass for an unlocated box warning: %s", (message) => {
    const input = Object.freeze([Object.freeze({ ...boxWarning, message })]);
    const view = new EditorView({ doc: "\\documentclass{article}\nBody text" });
    try {
      // Start with the old, misleading mark so this also checks its removal
      // from an already mounted editor when fresh diagnostics arrive.
      view.dispatch(setDiagnostics(view.state, [{
        from: 0, to: 12, severity: "warning", message,
      }]));
      expect(view.dom.querySelector(".cm-lintRange-warning")?.textContent).toBe("\\documentcla");
      view.dispatch(setDiagnostics(view.state, editorTexlabDiagnosticsForFile(
        [...input], "main.tex", view.state.doc,
      )));
      expect(view.dom.querySelector(".cm-lintRange")).toBeNull();
      expect(input[0].message).toBe(message);
    } finally {
      view.destroy();
    }
  });

  it("preserves real errors at the origin and box warnings with source ranges", () => {
    const doc = EditorState.create({ doc: "\\documentclass{article}\nBody text" }).doc;
    const diagnostics = editorTexlabDiagnosticsForFile([
      { ...boxWarning, level: "error", message: "Undefined control sequence." },
      { ...boxWarning, endColumn: 5 },
      { ...boxWarning, line: 2, endLine: 2 },
    ], "main.tex", doc);
    expect(diagnostics.map(({ from, to, severity }) => ({ from, to, severity }))).toEqual([
      { from: 0, to: 12, severity: "error" },
      { from: 0, to: 4, severity: "warning" },
      { from: 24, to: 33, severity: "warning" },
    ]);
  });

  it("maps TexLab diagnostics onto the active file with texlab source", () => {
    const doc = EditorState.create({ doc: "one\ntwo\nthree\nfour\n" }).doc;
    const diagnostics = editorTexlabDiagnosticsForFile(
      [
        { file: "main.tex", line: 2, level: "error", message: "Undefined control sequence." },
        { file: "other.tex", line: 1, level: "warning", message: "Ignored." },
      ],
      "main.tex",
      doc,
    );
    expect(diagnostics).toEqual([{
      from: doc.line(2).from,
      to: doc.line(2).to,
      severity: "error",
      message: "Undefined control sequence.",
      source: "texlab",
    }]);
  });

  it("uses column ranges when TexLab provides them", () => {
    const doc = EditorState.create({ doc: "abcdef\n" }).doc;
    const diagnostics = editorTexlabDiagnosticsForFile(
      [{
        file: "main.tex",
        line: 1,
        column: 2,
        endLine: 1,
        endColumn: 5,
        level: "warning",
        message: "Span",
      }],
      "main.tex",
      doc,
    );
    expect(diagnostics[0]?.from).toBe(doc.line(1).from + 1);
    expect(diagnostics[0]?.to).toBe(doc.line(1).from + 4);
  });
});
