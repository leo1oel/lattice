import { describe, expect, it } from "vitest";
import { bracedGroup, captionLine, compoundPlaces, enclosingFloat, placeLine } from "./compound-places";

const ENTRY = "% editable-figure source: s.reactio\n\\node {\\cmpd{ketone}}; \\node {\\cmpd{alcohol.OMe}};\n";
const entry = { path: "figures/s.tex", text: ENTRY };
const MAIN = String.raw`\begin{figure}\end{figure}
\begin{tocentry}\import{figures/}{s.tex}\end{tocentry}
% \begin{scheme}
\begin{scheme}
  \import{figures/}{s.tex}
  \caption{Reduction of \cmpd{ketone} with \textbf{NaBH$_4$} {nested {deep}}.}
  \label{sch:a}
\end{scheme}
\begin{scheme*}\input{figures/other}\caption[short]{Second}\end{scheme*}`;

describe("compound places", () => {
  it("balances braces and skips escaped ones", () => {
    expect(bracedGroup(String.raw`{a{b}\}c}d`, 0)).toBe(String.raw`a{b}\}c`);
    expect(bracedGroup("{open", 0)).toBeNull();
    expect(bracedGroup("x", 0)).toBeNull();
  });

  it("finds the enclosing float, not commented or closed ones", () => {
    const float = enclosingFloat(MAIN, MAIN.indexOf("\\import{figures/}{s.tex}\n  \\caption"));
    expect(float).toMatchObject({ environment: "scheme", label: "sch:a", ordinal: 1 });
    expect(float?.caption).toContain("nested {deep}");
    expect(enclosingFloat(MAIN, MAIN.indexOf("tocentry"))).toBeUndefined();
    expect(enclosingFloat(MAIN, MAIN.indexOf("\\input"))).toMatchObject({ environment: "scheme", ordinal: 2, caption: "Second" });
  });

  it("knows a float defined with \\newfloat, as the ACS template's graph", () => {
    const text = String.raw`\begin{graph}\input{a}\caption{G}\end{graph}`;
    expect(enclosingFloat(text, text.indexOf("\\input"))).toMatchObject({ environment: "graph", ordinal: 1, caption: "G" });
  });

  it("places an entry's keys in the float including it, over an include outside any float", () => {
    const places = compoundPlaces([{ path: "main.tex", text: MAIN }, entry]);
    expect(places.get("ketone")).toMatchObject({ file: "s", float: { environment: "scheme" } });
    expect(places.get("alcohol.OMe")?.float?.label).toBe("sch:a");
  });

  it("resolves includes against the including file too, with or without .tex", () => {
    const chapter = { path: "ch/one.tex", text: String.raw`\begin{figure}\input{f/a}\end{figure}` };
    const inner = { path: "ch/f/a.tex", text: "% editable-figure source: a.reactio\n\\cmpd{x}" };
    expect(compoundPlaces([chapter, inner]).get("x")?.float?.environment).toBe("figure");
  });

  it("knows no place for text mentions, and only the file for a figure included nowhere", () => {
    expect(compoundPlaces([{ path: "main.tex", text: String.raw`\cmpd{text}` }]).size).toBe(0);
    expect(compoundPlaces([entry]).get("ketone")).toMatchObject({ file: "s", float: undefined });
  });

  it("writes a caption as a short plain line", () => {
    expect(captionLine(String.raw`Reduction of \cmpd{ketone}, \cmpd{a,b}\label{x}~\textbf{{done}}.`, new Map([["ketone", "1"], ["a", "2"]])))
      .toBe("Reduction of 1, 2, b done .");
    expect(captionLine("x".repeat(60), new Map())).toBe(`${"x".repeat(48)}…`);
  });

  it("numbers a place by its label, else its count, and without a build by file", () => {
    const float = { environment: "scheme", label: "s", ordinal: 3, caption: "Cap" };
    const labels = new Map([["s", { number: "7", page: "1" }]]);
    expect(placeLine({ file: "f", float }, labels, new Map())).toBe("Scheme 7: Cap");
    expect(placeLine({ file: "f", float }, new Map(), new Map())).toBe("Scheme 3: Cap");
    expect(placeLine({ file: "f", float: { ...float, caption: undefined } }, labels, new Map())).toBe("Scheme 7");
    expect(placeLine({ file: "f", float }, null, new Map())).toBe("Scheme · f");
    expect(placeLine({ file: "f" }, labels, new Map())).toBe("f");
  });
});

describe("a hostile caption", () => {
  it("is read only as far as its short line needs", () => {
    const started = performance.now();
    expect(captionLine(`${"\\\\cmpd[".repeat(200_000)}`, new Map()).length).toBeLessThanOrEqual(49);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
