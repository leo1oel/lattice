import { describe, expect, it } from "vitest";
import {
  citationCompletionRange,
  citationHoverTarget,
  definitionTargetAt,
  includeCompletionRange,
  referenceCompletionRange,
  referenceHoverTarget,
  shouldInsertCommandBraces,
  symbolAt,
} from "./latex-symbols";

describe("LaTeX symbols", () => {
  it("adds braces after citation and reference commands", () => {
    expect(shouldInsertCommandBraces("Text \\cite")).toBe(true);
    expect(shouldInsertCommandBraces("See \\citet")).toBe(true);
    expect(shouldInsertCommandBraces("Equation \\eqref")).toBe(true);
    expect(shouldInsertCommandBraces("not a command cite")).toBe(false);
  });

  it.each([
    [citationCompletionRange, "Text \\cite{", 11, { from: 11, query: "" }],
    [citationCompletionRange, "Text \\cite{vas", 14, { from: 11, query: "vas" }],
    [citationCompletionRange, "Text \\cite{first,", 17, { from: 17, query: "" }],
    [citationCompletionRange, "Text \\cite{first, trans", 23, { from: 18, query: "trans" }],
    [citationCompletionRange, "Text \\section{intro", 19, null],
    [referenceCompletionRange, "See \\ref{", 9, { from: 9, query: "" }],
    [referenceCompletionRange, "See \\cref{fig:", 14, { from: 10, query: "fig:" }],
    [includeCompletionRange, "\\input{", 7, { from: 7, query: "" }],
    [includeCompletionRange, "\\include{sec", 12, { from: 9, query: "sec" }],
    [includeCompletionRange, "\\includegraphics[width=\\linewidth]{fig", 37, { from: 34, query: "fig" }],
    [includeCompletionRange, "\\section{intro", 14, null],
  ])("finds the completion slot in %#", (range, before, cursor, expected) => {
    expect(range(before, cursor)).toEqual(expected);
  });

  it("identifies the exact bibliography key hovered inside a citation", () => {
    const source = "Evidence \\citep{vaswani2017attention, dosovitskiy2021image}.";
    expect(citationHoverTarget(source, source.indexOf("vaswani") + 3)?.key).toBe("vaswani2017attention");
    expect(citationHoverTarget(source, source.indexOf("dosovitskiy") + 4)?.key).toBe("dosovitskiy2021image");
    expect(citationHoverTarget(source, source.indexOf("citep") + 2)).toBeNull();
    expect(citationHoverTarget("Plain text", 3)).toBeNull();
  });

  it("identifies figure, table, and equation labels inside reference commands", () => {
    const source = "See \\ref{fig:model}, \\cref{tab:results, eq:loss}, and \\autoref{sec:intro}.";
    for (const label of ["fig:model", "tab:results", "eq:loss", "sec:intro"]) {
      expect(referenceHoverTarget(source, source.indexOf(label) + 3)?.key).toBe(label);
    }
    expect(referenceHoverTarget("Plain text", 3)).toBeNull();
  });

  it("resolves include and includegraphics paths for go-to-definition", () => {
    const source = "\\input{sections/method}\n\\include{appendix}";
    expect(definitionTargetAt(source, source.indexOf("method") + 2, [])).toEqual({ kind: "include", path: "sections/method.tex" });
    expect(definitionTargetAt(source, source.indexOf("appendix") + 2, [])).toEqual({ kind: "include", path: "appendix.tex" });
    const figure = "\\includegraphics[width=\\linewidth]{figures/plot}";
    expect(definitionTargetAt(figure, figure.indexOf("plot") + 1, [], ["figures/plot.png"]))
      .toEqual({ kind: "asset", path: "figures/plot.png" });
  });

  it("resolves symbols under the cursor for find-references and rename", () => {
    const source = "See \\ref{fig:model} and \\label{fig:model} plus \\citep{vaswani2017}.";
    expect(symbolAt(source, source.indexOf("fig:model") + 2)).toEqual({ kind: "label", label: "fig:model" });
    expect(symbolAt(source, source.indexOf("\\label{fig:model}") + 10)).toEqual({ kind: "label", label: "fig:model" });
    expect(symbolAt(source, source.indexOf("vaswani") + 2)).toEqual({ kind: "citation", key: "vaswani2017" });
  });
});
