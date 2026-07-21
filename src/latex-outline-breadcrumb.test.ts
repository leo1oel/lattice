import { describe, expect, it } from "vitest";
import {
  activeOutlineNode,
  parseLatexOutline,
  parseProjectOutline,
  sectionBreadcrumb,
  sectionBreadcrumbNodes,
} from "./latex-outline";

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
