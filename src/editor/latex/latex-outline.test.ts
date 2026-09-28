import { describe, expect, it, vi } from "vitest";
import {
  activeOutlineNode,
  flattenOutline,
  parseLatexOutline,
  parseProjectOutline,
  sectionBreadcrumbNodes,
} from "./latex-outline";

describe("latex outline", () => {
  it("keeps independent line counters across nested includes and multiline titles", () => {
    const sources = {
      "main.tex": "😀\r\n\\section{First}\n\\input{body}\n\n\\section{Last\n title}\\subsection{Same line}",
      "body.tex": "\n\n\\subsection{Child}\n\\input{leaf}\n\\subsection{Sibling}",
      "leaf.tex": "\\subsubsection{Leaf}\n",
    };
    expect(flattenOutline(parseProjectOutline("main.tex", sources, Object.keys(sources)))
      .map(({ title, path, line }) => ({ title, path, line }))).toEqual([
      { title: "First", path: "main.tex", line: 2 },
      { title: "Child", path: "body.tex", line: 3 },
      { title: "Leaf", path: "leaf.tex", line: 1 },
      { title: "Sibling", path: "body.tex", line: 5 },
      { title: "Last title", path: "main.tex", line: 5 },
      { title: "Same line", path: "main.tex", line: 6 },
    ]);
    expect(flattenOutline(parseLatexOutline(sources["main.tex"]))
      .map(({ line }) => line)).toEqual([2, 5, 6]);
  });

  it.each(["file", "project"])("does not repeatedly split source prefixes for the %s outline", (kind) => {
    const source = Array.from({ length: 100 }, (_, i) => `text\n\\section{S${i}}\n`).join("");
    const split = vi.spyOn(String.prototype, "split");
    let scannedChars: number;
    try {
      const outline = kind === "file"
        ? parseLatexOutline(source)
        : parseProjectOutline("main.tex", { "main.tex": source }, ["main.tex"]);
      scannedChars = split.mock.contexts.reduce<number>((total, value) => total + String(value).length, 0);
      expect(outline).toHaveLength(100);
      expect(outline[99].line).toBe(200);
    } finally {
      split.mockRestore();
    }
    expect(scannedChars).toBeLessThanOrEqual(source.length);
  });

  it("builds a nested section tree with 1-based lines", () => {
    const source = "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\ntext\n"
      + "\\subsection{Setup}\n\\subsubsection{Details}\n\\section{Results}\n\\end{document}";
    const section = (level: number, title: string, line: number, children: object[] = []): object =>
      ({ id: expect.any(String), level, title, line, path: "main.tex", kind: "section", children });
    expect(parseLatexOutline(source, "main.tex")).toEqual([
      section(3, "Intro", 3, [section(4, "Setup", 5, [section(5, "Details", 6)])]),
      section(3, "Results", 7),
    ]);
  });

  it("follows input and include files for a project outline", () => {
    const sources = {
      "main.tex": "\\section{Main}\n\\input{sections/method}\n\\section{Close}\n",
      "sections/method.tex": "\\subsection{Approach}\n\\subsubsection{Details}\n",
    };
    const outline = parseProjectOutline("main.tex", sources, Object.keys(sources));
    const method = "sections/method.tex";
    expect(outline).toMatchObject([
      { title: "Main", path: "main.tex", children: [{ title: "Approach", path: method, children: [{ title: "Details", path: method }] }] },
      { title: "Close", path: "main.tex" },
    ]);
  });
});

describe("section breadcrumb", () => {
  it("returns the enclosing section trail for a line", () => {
    const source = "\\section{Intro}\ntext\n\\subsection{Setup}\nmore\n\\section{Results}\ndone";
    const breadcrumb = (line: number) => sectionBreadcrumbNodes(source, line, "main.tex").map(({ title, line }) => [title, line]);
    expect(breadcrumb(4)).toEqual([["Intro", 1], ["Setup", 3]]);
    expect(breadcrumb(6)).toEqual([["Results", 5]]);
  });

  it("highlights the active section in a project outline", () => {
    const sources = { "main.tex": "\\section{Intro}\n\\input{body}\n\\section{End}\n", "body.tex": "\\subsection{Details}\nline\n" };
    const nodes = parseProjectOutline("main.tex", sources, Object.keys(sources));
    expect(activeOutlineNode(nodes, "body.tex", 2)?.title).toBe("Details");
    expect(activeOutlineNode(parseLatexOutline("\\section{A}\n\\subsection{B}\n", "x.tex"), "x.tex", 2)?.title)
      .toBe("B");
  });
});
