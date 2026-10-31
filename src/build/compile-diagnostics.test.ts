import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  diagnosticLocationLabel,
  diagnosticMatchesFile,
  diagnosticsFingerprint,
  editorDiagnosticsForFile,
  flattenProjectPaths,
  groupDiagnosticsByFile,
  missingTexDependencyFile,
  normalizeDiagnosticPath,
  resolveDiagnosticPath,
  sortDiagnostics,
  summarizeDiagnostics,
} from "./compile-diagnostics";

describe("compile diagnostics helpers", () => {
  it("groups sorted diagnostics by normalized file, worst file first, unplaced ones together", () => {
    const groups = groupDiagnosticsByFile(sortDiagnostics([
      { level: "warning", message: "Overfull", file: "./main.tex", line: 9 },
      { level: "warning", message: "Font shape" },
      { level: "error", message: "Undefined", file: "chapters/ch01.tex", line: 3 },
      { level: "warning", message: "Citation", file: "/Users/me/paper/main.tex", line: 2 },
    ]));
    expect(groups.map((group) => [group.file, group.diagnostics.map((item) => item.message)])).toEqual([
      ["chapters/ch01.tex", ["Undefined"]],
      [undefined, ["Font shape"]],
      ["main.tex", ["Citation", "Overfull"]],
    ]);
  });

  it("normalizes absolute and dotted LaTeX log paths and matches them to the open project file", () => {
    expect(normalizeDiagnosticPath("./chapters/intro.tex")).toBe("chapters/intro.tex");
    expect(normalizeDiagnosticPath("/Users/me/paper/src/main.tex")).toBe("src/main.tex");
    expect(normalizeDiagnosticPath("C:\\\\paper\\\\main.tex")).toBe("main.tex");
    expect(diagnosticMatchesFile("/tmp/paper/main.tex", "main.tex")).toBe(true);
    expect(diagnosticMatchesFile("chapters/intro.tex", "chapters/intro.tex")).toBe(true);
    expect(diagnosticMatchesFile("other.tex", "main.tex")).toBe(false);
  });

  it("resolves diagnostics against the project tree", () => {
    const files = flattenProjectPaths([
      { path: "main.tex", children: [] },
      { path: "chapters", children: [{ path: "chapters/intro.tex", children: [] }] },
    ]);
    expect(resolveDiagnosticPath("/tmp/paper/./chapters/intro.tex", files, "main.tex")).toBe("chapters/intro.tex");
    expect(resolveDiagnosticPath(undefined, files, "main.tex")).toBe("main.tex");
    expect(resolveDiagnosticPath("intro.tex", ["preintro.tex", "paper/intro.tex"])).toBe("paper/intro.tex");
    expect(resolveDiagnosticPath("intro.tex", ["preintro.tex"])).toBe("intro.tex");
  });

  // The build names every project file by its exact path from the project
  // root (src-tauri/src/latex/diagnostic_paths.rs). A project that keeps an
  // `arxiv/` or `old/` copy, or a supplement with its own `sections/`, has
  // several files sharing a name: the error belongs to the one it names.
  it("resolves a diagnostic to the exact project file, not another that shares its name", () => {
    const files = ["arxiv/sections/intro.tex", "paper/main.tex", "paper/sections/intro.tex"];
    expect(resolveDiagnosticPath("paper/sections/intro.tex", files)).toBe("paper/sections/intro.tex");
    expect(resolveDiagnosticPath("./paper/sections/intro.tex", files)).toBe("paper/sections/intro.tex");
    expect(resolveDiagnosticPath("intro.tex", ["chapters/intro.tex", "intro.tex"])).toBe("intro.tex");
    // No exact match: a suffix decides only when one file has it.
    expect(resolveDiagnosticPath("sections/intro.tex", files)).toBe("sections/intro.tex");
    expect(resolveDiagnosticPath("/Users/me/paper/sections/intro.tex", files)).toBe("paper/sections/intro.tex");
    expect(resolveDiagnosticPath("/Users/me/x/sections/intro.tex", files)).toBe("sections/intro.tex");
  });

  it("draws a diagnostic only on the file it names", () => {
    expect(diagnosticMatchesFile("paper/sections/intro.tex", "arxiv/sections/intro.tex")).toBe(false);
    expect(diagnosticMatchesFile("intro.tex", "chapters/intro.tex")).toBe(false);
    expect(diagnosticMatchesFile("chapters/intro.tex", "intro.tex")).toBe(false);
    expect(diagnosticMatchesFile("sections/method.tex", "old/sections/method.tex")).toBe(false);
    expect(diagnosticMatchesFile("./paper/sections/intro.tex", "paper/sections/intro.tex")).toBe(true);
    // Outside the project (TeX named it from the root document's folder up).
    expect(diagnosticMatchesFile("../intro.tex", "intro.tex")).toBe(false);
  });

  it("labels and groups a diagnostic by its full project path", () => {
    expect(normalizeDiagnosticPath("paper/sections/intro.tex")).toBe("paper/sections/intro.tex");
    expect(diagnosticLocationLabel({ level: "error", message: "x", file: "arxiv/sections/intro.tex", line: 3 }))
      .toBe("arxiv/sections/intro.tex:3");
    const groups = groupDiagnosticsByFile([
      { level: "error", message: "a", file: "arxiv/sections/intro.tex", line: 1 },
      { level: "error", message: "b", file: "paper/sections/intro.tex", line: 1 },
    ]);
    expect(groups.map((group) => group.file)).toEqual(["arxiv/sections/intro.tex", "paper/sections/intro.tex"]);
  });

  it("recognizes installable missing TeX dependencies without treating project templates as packages", () => {
    expect(missingTexDependencyFile(
      "Missing LaTeX dependency `algorithm.sty`. BasicTeX does not include every package available on Overleaf.",
    )).toBe("algorithm.sty");
    expect(missingTexDependencyFile("Missing style file `neurips_2026.sty`. It belongs next to main.tex."))
      .toBeNull();
  });

  it("sorts errors before warnings and builds editor lint ranges", () => {
    const diagnostics = sortDiagnostics([
      { file: "main.tex", line: 20, level: "warning", message: "Undefined reference." },
      { file: "main.tex", line: 4, level: "error", message: "Missing $." },
      { file: "other.tex", line: 1, level: "error", message: "Bad command." },
    ]);
    expect(diagnostics.map((item) => item.message)).toEqual(["Missing $.", "Bad command.", "Undefined reference."]);
    expect(summarizeDiagnostics(diagnostics)).toEqual({ error: 2, warning: 1, info: 0 });
    expect(diagnosticLocationLabel(diagnostics[0])).toBe("main.tex:4");

    const doc = EditorState.create({ doc: "one\ntwo\nthree\nfour\nfive" }).doc;
    const marks = editorDiagnosticsForFile(diagnostics, "main.tex", doc);
    expect(marks).toHaveLength(2);
    expect(marks[0]).toMatchObject({ from: doc.line(4).from, to: doc.line(4).to, severity: "error", message: "Missing $." });
    expect(marks[1]).toMatchObject({ from: doc.line(5).from, to: doc.line(5).to, severity: "warning", message: "Undefined reference." });
  });
});

describe("diagnosticsFingerprint", () => {
  const warning = { level: "warning", message: "Fonts are not Times.", file: "main.tex", line: 4 };
  const error = { level: "error", message: "Missing $.", file: "main.tex", line: 9 };

  it("ignores emission order and repeated rebuilds, but changes when a diagnostic is added, removed or edited", () => {
    // latexmk may emit the same set in any order.
    expect(diagnosticsFingerprint([warning, error])).toBe(diagnosticsFingerprint([error, warning]));
    // The same unfixed warning, recompiled by autosave: one dismissal must stay valid.
    expect(diagnosticsFingerprint([warning])).toBe(diagnosticsFingerprint([{ ...warning }]));
    const base = diagnosticsFingerprint([warning]);
    expect(diagnosticsFingerprint([warning, error])).not.toBe(base);
    expect(diagnosticsFingerprint([])).not.toBe(base);
    expect(diagnosticsFingerprint([{ ...warning, line: 5 }])).not.toBe(base);
    expect(diagnosticsFingerprint([{ ...warning, message: "Something else." }])).not.toBe(base);
  });
});
