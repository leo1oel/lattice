import { describe, expect, it } from "vitest";
import {
  activeOutlineNode,
  parseLatexOutline,
  parseProjectOutline,
  resolveIncludePath,
  sectionBreadcrumb,
  sectionBreadcrumbNodes,
} from "./latex-outline";

describe("latex outline", () => {
  it("builds a nested section tree with 1-based lines", () => {
    const source = [
      "\\documentclass{article}",
      "\\begin{document}",
      "\\section{Intro}",
      "text",
      "\\subsection{Setup}",
      "\\subsubsection{Details}",
      "\\section{Results}",
      "\\end{document}",
    ].join("\n");
    expect(parseLatexOutline(source, "main.tex")).toEqual([
      {
        id: expect.any(String),
        level: 3,
        title: "Intro",
        line: 3,
        path: "main.tex",
        kind: "section",
        children: [{
          id: expect.any(String),
          level: 4,
          title: "Setup",
          line: 5,
          path: "main.tex",
          kind: "section",
          children: [{
            id: expect.any(String),
            level: 5,
            title: "Details",
            line: 6,
            path: "main.tex",
            kind: "section",
            children: [],
          }],
        }],
      },
      {
        id: expect.any(String),
        level: 3,
        title: "Results",
        line: 7,
        path: "main.tex",
        kind: "section",
        children: [],
      },
    ]);
  });

  it("follows input and include files for a project outline", () => {
    const sources = {
      "main.tex": "\\section{Main}\n\\input{sections/method}\n\\section{Close}\n",
      "sections/method.tex": "\\subsection{Approach}\n\\subsubsection{Details}\n",
    };
    const paths = Object.keys(sources);
    expect(resolveIncludePath("sections/method", paths)).toBe("sections/method.tex");
    const outline = parseProjectOutline("main.tex", sources, paths);
    expect(outline).toMatchObject([
      {
        title: "Main",
        path: "main.tex",
        children: [{
          title: "Approach",
          path: "sections/method.tex",
          children: [{ title: "Details", path: "sections/method.tex" }],
        }],
      },
      { title: "Close", path: "main.tex" },
    ]);
  });
});

describe("section breadcrumb", () => {
  it("returns the enclosing section trail for a line", () => {
    const source = [
      "\\section{Intro}",
      "text",
      "\\subsection{Setup}",
      "more",
      "\\section{Results}",
      "done",
    ].join("\n");
    expect(sectionBreadcrumb(source, 4)).toEqual(["Intro", "Setup"]);
    expect(sectionBreadcrumb(source, 6)).toEqual(["Results"]);
    expect(sectionBreadcrumbNodes(source, 4, "main.tex").map((node) => node.line)).toEqual([1, 3]);
  });

  it("highlights the active section in a project outline", () => {
    const nodes = parseProjectOutline(
      "main.tex",
      {
        "main.tex": "\\section{Intro}\n\\input{body}\n\\section{End}\n",
        "body.tex": "\\subsection{Details}\nline\n",
      },
      ["main.tex", "body.tex"],
    );
    expect(activeOutlineNode(nodes, "body.tex", 2)?.title).toBe("Details");
    expect(activeOutlineNode(parseLatexOutline("\\section{A}\n\\subsection{B}\n", "x.tex"), "x.tex", 2)?.title)
      .toBe("B");
  });
});
