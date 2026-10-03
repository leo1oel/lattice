import { describe, expect, it } from "vitest";
import { isCiteOrRefCompletionContext, texlabCanAnswer } from "./texlab-language";

describe("isCiteOrRefCompletionContext", () => {
  it("detects citation and reference argument contexts", () => {
    expect(isCiteOrRefCompletionContext("see \\cite{vas")).toBe(true);
    expect(isCiteOrRefCompletionContext("see \\ref{fig:")).toBe(true);
    expect(isCiteOrRefCompletionContext("\\usepackage{ams")).toBe(false);
    expect(isCiteOrRefCompletionContext("\\begin{eq")).toBe(false);
  });
});

describe("texlabCanAnswer", () => {
  it("asks TexLab in command names and open arguments", () => {
    expect(texlabCanAnswer("text \\sec")).toBe(true);
    expect(texlabCanAnswer("text \\")).toBe(true);
    expect(texlabCanAnswer("\\cs_new_prote")).toBe(true);
    expect(texlabCanAnswer("x_{38} = \\sum_i")).toBe(true);
    expect(texlabCanAnswer("\\begin{equ")).toBe(true);
    expect(texlabCanAnswer("\\includegraphics[wid")).toBe(true);
    expect(texlabCanAnswer("\\usetikzlibrary{\n  calc,\n  %\n  inter")).toBe(true);
    expect(texlabCanAnswer("\\footnote{see \\textbf{this} and th")).toBe(true);
  });

  it("leaves prose alone", () => {
    expect(texlabCanAnswer("The quick brown fo")).toBe(false);
    expect(texlabCanAnswer("\\section{Intro} The quick")).toBe(false);
    expect(texlabCanAnswer("a \\{ literal brace and wor")).toBe(false);
    expect(texlabCanAnswer("\\emph{unclosed\n\nNew paragraph wor")).toBe(false);
    expect(texlabCanAnswer("")).toBe(false);
  });
});
