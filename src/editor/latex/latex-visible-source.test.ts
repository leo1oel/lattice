import { describe, expect, it } from "vitest";
import { visibleLatexSource } from "./latex-visible-source";

describe("visible LaTeX source", () => {
  const blankedAway = (source: string) => {
    const visible = visibleLatexSource(source);
    // Blanking keeps every offset and line break of the source.
    expect(visible).toHaveLength(source.length);
    expect(visible.split("\n")).toHaveLength(source.split("\n").length);
    return visible.replace(/\s+/g, " ").trim();
  };

  it("blanks comments but not escaped percent signs", () => {
    expect(blankedAway("a % gone\n50\\% kept \\\\% gone\nb")).toBe("a 50\\% kept \\\\ b");
  });

  it("blanks verbatim-like environments and inline verb", () => {
    expect(blankedAway("a\\begin{verbatim}\n\\x\n\\end{verbatim}b \\begin{minted}{py}x\\end{minted}c \\verb|\\y| d"))
      .toBe("a b c d");
    expect(blankedAway("a\\begin{comment}\nnever closed")).toBe("a");
  });

  it("blanks macro definitions with their bodies", () => {
    expect(blankedAway([
      "\\newcommand*{\\a}[2][x]{A{#1}#2}1",
      "\\renewcommand\\b{B}2",
      "\\def\\c#1.#2{C}3",
      "\\newenvironment{d}[1]{\\begin{x}}{\\end{x}}4",
      "\\NewDocumentCommand{\\e}{m o}{E}5",
      "\\NewDocumentEnvironment{f}{m}{F}{G}6",
    ].join("\n"))).toBe("1 2 3 4 5 6");
  });

  it("keeps a definition whose body is not closed yet, rather than the rest of the document", () => {
    expect(blankedAway("\\newcommand{\\a}{\\section{X}\n\\section{Y}")).toBe("{\\section{X} \\section{Y}");
  });
});
