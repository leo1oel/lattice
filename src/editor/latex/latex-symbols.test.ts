import { describe, expect, it } from "vitest";
import {
  citationCompletionRange,
  citationHoverTarget,
  citationNotePage,
  compoundCompletionRange,
  markCompletionRange,
  definitionTargetAt,
  graphicsHoverTarget,
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
    [compoundCompletionRange, "See \\cmpd{", 10, { from: 10, query: "" }],
    [compoundCompletionRange, "See \\cmpd*{a, ke", 16, { from: 14, query: "ke" }],
    [compoundCompletionRange, "See \\refcmpd{k", 14, { from: 13, query: "k" }],
    [includeCompletionRange, "\\input{", 7, { from: 7, query: "" }],
    [includeCompletionRange, "\\include{sec", 12, { from: 9, query: "sec" }],
    [includeCompletionRange, "\\includegraphics[width=\\linewidth]{fig", 37, { from: 34, query: "fig" }],
    [includeCompletionRange, "\\section{intro", 14, null],
  ])("finds the completion slot in %#", (range, before, cursor, expected) => {
    expect(range(before, cursor)).toEqual(expected);
  });

  it("finds the slot of a mark's text", () => {
    expect(markCompletionRange("See \\rcmpd{A:ca", 15)).toEqual({ from: 11, query: "A:ca" });
    expect(markCompletionRange("See \\cmpd{", 10)).toBeNull();
  });

  it("identifies the exact bibliography key hovered inside a citation", () => {
    const source = "Evidence \\citep{vaswani2017attention, dosovitskiy2021image}.";
    expect(citationHoverTarget(source, source.indexOf("vaswani") + 3)?.key).toBe("vaswani2017attention");
    expect(citationHoverTarget(source, source.indexOf("dosovitskiy") + 4)?.key).toBe("dosovitskiy2021image");
    expect(citationHoverTarget(source, source.indexOf("citep") + 2)).toBeNull();
    expect(citationHoverTarget("Plain text", 3)).toBeNull();
  });

  it.each([
    ["p.~5", 5], ["p. 5", 5], ["p5", 5], ["pp.~5--7", 5], ["pp. 12–14", 12], ["page 9", 9], ["Page~9", 9], ["pages 3-4", 3],
    ["5", 5], [" p.\\,5 ", 5], ["Theorem 2", undefined], ["ch.~3", undefined], ["p.~0", undefined], ["", undefined], ["see p.~5", undefined],
  ])("reads the page a citation note %j names", (note, page) => {
    expect(citationNotePage(note)).toBe(page);
  });

  it("carries the page of a citation's postnote with the hovered key", () => {
    const at = (source: string) => citationHoverTarget(source, source.indexOf("vaswani") + 2);
    expect(at("\\cite[p.~5]{vaswani}")).toMatchObject({ key: "vaswani", page: 5 });
    expect(at("\\citep[page 12]{vaswani, other}")).toMatchObject({ key: "vaswani", page: 12 });
    // natbib's two notes are the prenote and the postnote; only the postnote names the page.
    expect(at("\\citep[see][p.~7]{vaswani}")).toMatchObject({ page: 7 });
    expect(at("\\citep[p.~3][]{vaswani}")?.page).toBeUndefined();
    expect(at("\\cite{vaswani} and \\cite[p.~9]{other}")?.page).toBeUndefined();
  });

  it("identifies the figure path hovered inside \\includegraphics, options and \\detokenize included", () => {
    const source = "\\includegraphics[width=0.8\\linewidth]{figures/plot} and \\includegraphics{\\detokenize{figs/a b.png}}";
    expect(graphicsHoverTarget(source, source.indexOf("plot"))).toEqual({
      from: source.indexOf("figures/plot"),
      to: source.indexOf("figures/plot") + "figures/plot".length,
      path: "figures/plot",
    });
    expect(graphicsHoverTarget(source, source.indexOf("a b"))?.path).toBe("figs/a b.png");
    expect(graphicsHoverTarget(source, source.indexOf("width"))).toBeNull();
    expect(graphicsHoverTarget("Plain text", 3)).toBeNull();
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
