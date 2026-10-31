import { describe, expect, it } from "vitest";
import { headingTitle } from "./latex-heading-title";

describe("heading title", () => {
  it.each([
    ["Results \\& Analysis", "Results & Analysis"],
    ["100\\% \\{Sure\\} \\#1 a\\_b \\$5", "100% {Sure} #1 a_b $5"],
    ["Fr\\'echet, G\\\"{o}del, Erd\\H{o}s, Kate\\v{r}ina, na\\\"\\i ve, \\c c", "Fréchet, Gödel, Erdős, Kateřina, naïve, ç"],
    ["\\emph{On} \\textbf{\\textit{Deep}} {\\bf Nets}", "On Deep Nets"],
    ["\\texorpdfstring{$\\mathcal{L}_2$}{L2} Loss", "L2 Loss"],
    ["Bounds $O(n^{2})$ and \\(x\\)", "Bounds $O(n^{2})$ and \\(x\\)"],
    ["Intro\\label{sec:intro}\\footnote[2]{A note.}", "Intro"],
    ["Line\\\\ break~here", "Line break here"],
    ["\\LaTeX{} and \\textcolor{red}{Red}", "LaTeX and \\textcolor{red}{Red}"],
    ["  Spread \n  over lines ", "Spread over lines"],
    ["\\label{x}", ""],
  ])("shows %j as %j", (argument, title) => {
    expect(headingTitle(argument)).toBe(title);
  });
});
