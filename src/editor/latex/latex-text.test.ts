import { describe, expect, it, vi } from "vitest";
import {
  bibliographyEntryLine,
  findAppendixMarker,
  katexMacrosFromSources,
  mergeReferences,
  parseLocalLabels,
  parseLocalMacros,
  resolveTexPath,
  type ReferenceInfo,
} from "./latex-text";

describe("LaTeX source parsing", () => {
  it("preserves lines and snippets across duplicate, empty, and multiline labels", () => {
    const source = "  \\label{first} \\label{second}  \r\n\n😀 \\label{first}\n\\label{ }\n  \\label{\n last\n} tail";
    expect(parseLocalLabels("body.tex", source)).toEqual([
      { label: "first", kind: "reference", title: "first", path: "body.tex", line: 1, snippet: "\\label{first} \\label{second}" },
      { label: "second", kind: "reference", title: "second", path: "body.tex", line: 1, snippet: "\\label{first} \\label{second}" },
      { label: "last", kind: "reference", title: "last", path: "body.tex", line: 5, snippet: "\\label{" },
    ]);
  });

  it("does not split the whole live buffer once per label", () => {
    const source = Array.from({ length: 100 }, (_, i) => `prose\n\\label{eq:${i}}\n`).join("");
    const split = vi.spyOn(String.prototype, "split");
    let fullBufferSplits: number;
    try {
      const labels = parseLocalLabels("main.tex", source);
      fullBufferSplits = split.mock.contexts.filter((value) => String(value) === source).length;
      expect(labels).toHaveLength(100);
      expect(labels[99]).toMatchObject({ label: "eq:99", line: 200, snippet: "\\label{eq:99}" });
    } finally {
      split.mockRestore();
    }
    expect(fullBufferSplits).toBeLessThanOrEqual(1);
  });

  it("merges live labels from the dirty buffer, keeping figure preview metadata", () => {
    const other: ReferenceInfo = { label: "fig:old", kind: "figure", title: "", snippet: "", path: "other.tex", line: 1 };
    expect(mergeReferences([other], "main.tex", parseLocalLabels("main.tex", "\\label{fig:new}"))
      .map((item) => item.label).sort()).toEqual(["fig:new", "fig:old"]);
    const figure: ReferenceInfo = {
      label: "fig:native-umm", kind: "figure", title: "Native UMM", path: "main.tex", line: 12,
      snippet: "\\includegraphics{figures/native-umm.pdf}", imagePath: "figures/native-umm.pdf",
    };
    const merged = mergeReferences([figure], "main.tex", parseLocalLabels("main.tex", "\\label{fig:native-umm}"));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ imagePath: "figures/native-umm.pdf", kind: "figure", title: "Native UMM" });
  });

  it("parses project macros for completion", () => {
    const macros = parseLocalMacros(["\\newcommand{\\loss}{L}\n\\newenvironment{proofbox}{}{}\n"]);
    expect(macros.map((item) => item.label)).toEqual(["\\loss", "\\begin{proofbox}"]);
  });

  it("finds bibliography entry lines by key", () => {
    const bib = "@article{first,\n  title={A},\n}\n@inproceedings{second,\n  title={B},\n}\n";
    expect(bibliographyEntryLine(bib, "second")).toBe(4);
    expect(bibliographyEntryLine(bib, "missing")).toBeNull();
  });

  it("resolves an include argument to a project .tex file", () => {
    const paths = ["main.tex", "sections/method.tex"];
    expect(resolveTexPath("sections/method", paths)).toBe("sections/method.tex");
    expect(resolveTexPath(" method ", paths)).toBe("sections/method.tex");
    expect(resolveTexPath("missing", paths)).toBeNull();
  });

  it("collects newcommand macros for KaTeX, keeping the first definition", () => {
    expect(katexMacrosFromSources([
      String.raw`\newcommand{\R}{\mathbb{R}}`,
      String.raw`\renewcommand{\eps}{\varepsilon}`,
      String.raw`\newcommand{\R}{second}`,
    ])).toEqual({ "\\R": String.raw`\mathbb{R}`, "\\eps": String.raw`\varepsilon` });
  });

  it("finds the first appendix switch ignoring comments", () => {
    expect(findAppendixMarker({ "main.tex": "\\section{Intro}\n% \\appendix\n\\appendix\n\\section{Proofs}\n" }))
      .toEqual({ path: "main.tex", line: 3 });
    expect(findAppendixMarker({ "main.tex": "\\begin{document}\nHi\n\\end{document}\n" })).toBeNull();
  });
});
