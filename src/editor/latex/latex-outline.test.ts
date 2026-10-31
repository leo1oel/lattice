import { describe, expect, it, vi } from "vitest";
import {
  activeOutlineNode,
  findBodyEnd,
  flattenOutline,
  includedPathsIn,
  outlineNumbers,
  parseLatexOutline,
  parseProjectOutline,
  sameOutline,
  sectionBreadcrumbNodes,
} from "./latex-outline";

describe("latex outline", () => {
  it("ends the body at the first appendix switch ignoring comments", () => {
    const appendix = { "main.tex": "\\section{Intro}\n% \\appendix\n\\appendix\n\\section{Proofs}\n" };
    expect(findBodyEnd("main.tex", appendix, ["main.tex"])).toEqual([{ path: "main.tex", before: 3 }]);
    expect(findBodyEnd("main.tex", { "main.tex": "\\begin{document}\nHi\n\\end{document}\n" }, ["main.tex"])).toBeNull();
  });

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

  it("names each heading by what it says, so typing above it keeps the outline the same", () => {
    const source = "Draft.\n\\section{Intro}\n\\section{Notes}\n\\section{Notes}\n";
    const outline = parseLatexOutline(source, "main.tex");
    expect(new Set(outline.map((node) => node.id)).size).toBe(3);
    expect(sameOutline(outline, parseLatexOutline(source.replace("Draft.", "Drafts and more."), "main.tex"))).toBe(true);
    expect(sameOutline(outline, parseLatexOutline(source.replace("Intro", "Introduction"), "main.tex"))).toBe(false);
    // A heading on another line is one the outline jumps to differently.
    expect(sameOutline(outline, parseLatexOutline(`\n${source}`, "main.tex"))).toBe(false);
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

describe("outline headings as TeX reads them", () => {
  const titles = (source: string) => flattenOutline(parseLatexOutline(source, "main.tex")).map(({ title }) => title);

  it.each([
    ["\\section{Experiments on \\textsc{ImageNet}}", "Experiments on ImageNet"],
    ["\\subsection{Complexity $\\mathcal{O}(n \\log n)$}", "Complexity $\\mathcal{O}(n \\log n)$"],
    ["\\section[Short]{A Long Title}", "Short"],
    ["\\section{Fr\\'echet Distance on \\textbf{CIFAR}}", "Fréchet Distance on CIFAR"],
    ["\\section{\\texorpdfstring{$\\alpha$-Nets}{alpha-Nets}}", "alpha-Nets"],
    ["\\section{Intro\\label{sec:intro}}", "Intro"],
    ["\\section*\n  [Short]\n  {Long}", "Short"],
  ])("lists %j, nested braces and all", (heading, title) => {
    expect(titles(`${heading}\nBody.\n\\section{Next}\n`)).toEqual([title, "Next"]);
  });

  it("leaves out headings that are commented out, quoted, or defined for later", () => {
    const source = [
      "\\newcommand{\\mysec}[1]{\\section{#1}}",
      "\\def\\oldsec#1{\\section{#1}}",
      "\\section{Results \\& Analysis}",
      "% \\section{Commented out}",
      "50\\% done \\section{After an escaped percent}",
      "\\begin{verbatim}",
      "\\section{In verbatim}",
      "\\end{verbatim}",
      "\\begin{lstlisting}\\section{In a listing}\\end{lstlisting}",
      "\\verb|\\section{Inline}| \\mysec{Through a macro}",
    ].join("\n");
    expect(titles(source)).toEqual(["Results & Analysis", "After an escaped percent"]);
  });

  it("keeps each heading's line and the numbering after a heading the old parser dropped", () => {
    const source = "\\section{One}\n\\section{Two on \\textsc{X}}\n%\\section{Gone}\n\\section{Three}\n";
    const outline = parseLatexOutline(source, "main.tex");
    expect(outline.map(({ title, line }) => [title, line])).toEqual([["One", 1], ["Two on X", 2], ["Three", 4]]);
    expect([...outlineNumbers(outline).values()]).toEqual(["1", "2", "3"]);
  });

  it("does not follow a commented-out include", () => {
    const sources = {
      "main.tex": "\\section{Intro}\n% \\input{sections/old}\n\\section{Method}\n",
      "sections/old.tex": "\\section{Old Draft}\n",
    };
    const paths = Object.keys(sources);
    expect(flattenOutline(parseProjectOutline("main.tex", sources, paths)).map(({ title }) => title))
      .toEqual(["Intro", "Method"]);
    expect(includedPathsIn(sources["main.tex"], paths)).toEqual([]);
  });

  it("does not end the body at an appendix inside a verbatim block", () => {
    const source = "\\section{Intro}\n\\begin{verbatim}\n\\appendix\n\\end{verbatim}\n\\appendix\n";
    expect(findBodyEnd("main.tex", { "main.tex": source }, ["main.tex"])).toEqual([{ path: "main.tex", before: 5 }]);
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
