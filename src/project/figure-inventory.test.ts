import { describe, expect, it } from "vitest";
import { figureReplacement, figureWidthInches, scanFigureInventory } from "./figure-inventory";

const figure = (path: string, label = "fig:result") => String.raw`\begin{figure}
\includegraphics[width=2in]{${path}}
\caption[Short]{A {nested} caption}
\label{${label}}
\end{figure}`;

describe("figure inventory", () => {
  it("resolves graphicspath and extensionless usages, preserving every source and reference", () => {
    const sources = { "main.tex": String.raw`\graphicspath{{figures/}}
${figure("plot")}
See \ref{fig:result}.`, "supplement.tex": figure("figures/plot.png", "fig:supp") };
    const result = scanFigureInventory(sources, ["figures/plot.png"]);
    expect(result.uses).toHaveLength(2);
    expect(result.uses.map((use) => use.asset)).toEqual(["figures/plot.png", "figures/plot.png"]);
    expect(result.uses[0]).toMatchObject({ line: 3, caption: "A {nested} caption", labels: ["fig:result"], widthInches: 2 });
    expect(result.uses[0].references).toEqual([{ source: "main.tex", line: 7 }]);
  });
  it("ignores comments and verbatim, and distinguishes missing, dynamic and ambiguous paths", () => {
    const result = scanFigureInventory({ "main.tex": String.raw`% \includegraphics{comment}
\begin{verbatim}\includegraphics{example}\end{verbatim}
\includegraphics{missing}
\includegraphics{\plotname}
\includegraphics{plot}
\includegraphics*{vector.svg}` }, ["plot.pdf", "plot.png", "vector.svg"]);
    expect(result.uses.map((use) => [use.raw, use.asset, use.dynamic])).toEqual([
      ["missing", null, false], ["\\plotname", null, true], ["plot", null, true], ["vector.svg", "vector.svg", false],
    ]);
    expect(result.limited).toEqual(["main.tex"]);
  });
  it("does not guess a suffix match in a different folder", () => {
    expect(scanFigureInventory({ "main.tex": figure("plot.png") }, ["unrelated/plot.png"]).uses[0].asset).toBeNull();
  });
  it("detects duplicate labels across files without counting a reused figure twice", () => {
    const result = scanFigureInventory({ "main.tex": figure("a.pdf"), "supp.tex": figure("b.svg") }, ["a.pdf", "b.svg"]);
    expect(result.uses.map((use) => use.duplicateLabels)).toEqual([["fig:result"], ["fig:result"]]);
  });
  it("handles detokenized filenames and nested captions without modifying their text", () => {
    const text = figure(String.raw`\detokenize{plots/long name.png}`);
    const sources = { "main.tex": `${text}\n${text}` };
    const result = scanFigureInventory(sources, ["plots/long name.png"]);
    expect(result.uses.map((use) => use.asset)).toEqual(["plots/long name.png", "plots/long name.png"]);
    const edits = figureReplacement(sources, result.uses, "new.svg");
    expect(edits).toEqual([{ path: "main.tex", before: sources["main.tex"], after: sources["main.tex"].replaceAll("plots/long name.png", "new.svg") }]);
    expect(() => figureReplacement({ "main.tex": "changed" }, result.uses, "new.svg")).toThrow();
  });
  it.each(["width=0.5\\textwidth", "width=4cm,scale=2", "width=2in,height=3cm", "width=0in", "width=2in,trim=1 2 3 4"])("keeps effective DPI unknown for %s", (options) => {
    expect(figureWidthInches(options)).toBeNull();
  });
  it("converts a physical width and leaves a caption outside a figure unresolved", () => {
    expect(figureWidthInches("width=25.4mm")).toBe(1);
    expect(scanFigureInventory({ "main.tex": String.raw`\includegraphics{a.pdf}\caption{Outside}` }, ["a.pdf"]).uses[0].caption).toBe("");
  });
});
