import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { editorTexlabDiagnosticsForFile } from "./texlab-diagnostics";

describe("editorTexlabDiagnosticsForFile", () => {
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
