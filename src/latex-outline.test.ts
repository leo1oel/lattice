import { describe, expect, it } from "vitest";
import { parseLatexOutline, parseProjectOutline, resolveIncludePath } from "./latex-outline";

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
          title: "sections/method.tex",
          kind: "input",
          children: [{
            title: "Approach",
            path: "sections/method.tex",
            children: [{ title: "Details", path: "sections/method.tex" }],
          }],
        }],
      },
      { title: "Close", path: "main.tex" },
    ]);
  });
});
