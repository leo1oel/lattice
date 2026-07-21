import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  diagnosticLocationLabel,
  diagnosticMatchesFile,
  editorDiagnosticsForFile,
  flattenProjectPaths,
  normalizeDiagnosticPath,
  resolveDiagnosticPath,
  sortDiagnostics,
  summarizeDiagnostics,
} from "./compile-diagnostics";

describe("compile diagnostics helpers", () => {
  it("normalizes absolute and dotted LaTeX log paths", () => {
    expect(normalizeDiagnosticPath("./chapters/intro.tex")).toBe("chapters/intro.tex");
    expect(normalizeDiagnosticPath("/Users/me/paper/src/main.tex")).toBe("src/main.tex");
    expect(normalizeDiagnosticPath("C:\\\\paper\\\\main.tex")).toBe("main.tex");
  });

  it("matches diagnostics to the open project file", () => {
    expect(diagnosticMatchesFile("/tmp/paper/main.tex", "main.tex")).toBe(true);
    expect(diagnosticMatchesFile("chapters/intro.tex", "chapters/intro.tex")).toBe(true);
    expect(diagnosticMatchesFile("other.tex", "main.tex")).toBe(false);
  });

  it("resolves diagnostics against the project tree", () => {
    const files = flattenProjectPaths([
      { path: "main.tex", children: [] },
      {
        path: "chapters",
        children: [{ path: "chapters/intro.tex", children: [] }],
      },
    ]);
    expect(resolveDiagnosticPath("/tmp/paper/./chapters/intro.tex", files, "main.tex")).toBe("chapters/intro.tex");
    expect(resolveDiagnosticPath(undefined, files, "main.tex")).toBe("main.tex");
  });

  it("sorts errors before warnings and builds editor lint ranges", () => {
    const diagnostics = sortDiagnostics([
      { file: "main.tex", line: 20, level: "warning", message: "Undefined reference." },
      { file: "main.tex", line: 4, level: "error", message: "Missing $." },
      { file: "other.tex", line: 1, level: "error", message: "Bad command." },
    ]);
    expect(diagnostics.map((item) => item.message)).toEqual([
      "Missing $.",
      "Bad command.",
      "Undefined reference.",
    ]);
    expect(summarizeDiagnostics(diagnostics)).toEqual({ error: 2, warning: 1, info: 0 });
    expect(diagnosticLocationLabel(diagnostics[0])).toBe("main.tex:4");

    const doc = EditorState.create({ doc: "one\ntwo\nthree\nfour\nfive" }).doc;
    const marks = editorDiagnosticsForFile(diagnostics, "main.tex", doc);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({
      from: doc.line(4).from,
      to: doc.line(4).to,
      severity: "error",
      message: "Missing $.",
    });
    expect(marks[1]).toMatchObject({
      from: doc.line(5).from,
      to: doc.line(5).to,
      severity: "warning",
      message: "Undefined reference.",
    });
  });
});
