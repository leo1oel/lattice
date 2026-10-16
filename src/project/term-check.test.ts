import { describe, expect, it } from "vitest";
import type { TermRule } from "../app-types";
import { applyTermHits, checkTerms, termContext, termGuidance } from "./term-check";

const zeroShot: TermRule = { term: "zero-shot", variants: ["zero shot", "zeroshot"], note: "Hyphenated as an adjective." };

const MAIN = [
  "\\section{Zero Shot transfer}",
  "We study zero shot transfer. Zero shot results follow; zero-shot is the term.",
  "\\begin{figure}\\caption{Our zero shot setup.}\\label{fig:zero shot}\\end{figure}",
  "% zero shot in a comment",
  "Math $zero shot$ and \\cite{zero shot} and \\includegraphics{figs/zero shot.pdf}.",
  "Numbers 3.5 cm and \\zeroshot{} stay.",
  "",
].join("\n");

describe("checkTerms", () => {
  it("finds only prose places, keeping math, comments, keys and paths as written", () => {
    const [report] = checkTerms([{ path: "main.tex", text: MAIN }], [zeroShot]);
    expect(report.hits.map((hit) => [hit.line, hit.text, hit.replacement])).toEqual([
      [1, "Zero Shot", "Zero-Shot"],
      [2, "zero shot", "zero-shot"],
      [2, "Zero shot", "Zero-shot"],
      [3, "zero shot", "zero-shot"],
    ]);
    // The comment, the math, the label, the citation, the path and the macro name.
    expect(report.kept).toBe(6);
  });

  it("keeps a capitalised term's own spelling without listing other forms", () => {
    const rule: TermRule = { term: "ResNet", variants: [] };
    const [report] = checkTerms([{ path: "a.tex", text: "ResNet beats Resnet and RESNET, not ResNets.\n" }], [rule]);
    expect(report.hits.map((hit) => hit.text)).toEqual(["Resnet", "RESNET"]);
    expect(report.hits.every((hit) => hit.replacement === "ResNet")).toBe(true);
  });

  it("keeps a term that starts lower but has capitals exact", () => {
    const [report] = checkTerms([{ path: "a.tex", text: "fMRI scans, FMRI scans and Fmri scans.\n" }], [{ term: "fMRI", variants: [] }]);
    expect(report.hits.map((hit) => [hit.text, hit.replacement])).toEqual([["FMRI", "fMRI"], ["Fmri", "fMRI"]]);
  });

  it("matches a form across a line wrap but not a paragraph break", () => {
    const text = "the zero\nshot case.\n\nzero\n\nshot apart.\n";
    const [report] = checkTerms([{ path: "a.tex", text }], [zeroShot]);
    expect(report.hits.map((hit) => hit.text)).toEqual(["zero\nshot"]);
  });

  it("marks remembered places as skipped, by the words around them", () => {
    const text = "Prose with zero shot here and zero shot there.\n";
    const first = text.indexOf("zero shot");
    const context = termContext(text, first, first + "zero shot".length);
    const rule = { ...zeroShot, skipped: [{ path: "a.tex", context }, { path: "b.tex", context }] };
    const [report] = checkTerms([{ path: "a.tex", text }], [rule]);
    expect(report.hits.map((hit) => hit.skipped)).toEqual([true, false]);
  });

  it("handles Chinese text, surrogate pairs and an escaped percent around the form", () => {
    const text = "我们的 zero shot 方法 𝒜 zero shot 50\\% zero shot.\n";
    const [report] = checkTerms([{ path: "a.tex", text }], [zeroShot]);
    expect(report.hits).toHaveLength(3);
    for (const hit of report.hits) expect(text.slice(hit.from, hit.to)).toBe("zero shot");
  });
});

describe("applyTermHits", () => {
  it("changes only the chosen places and leaves the rest of the file byte for byte", () => {
    const sources = [{ path: "main.tex", text: MAIN }];
    const [report] = checkTerms(sources, [zeroShot]);
    const [file] = applyTermHits(sources, [report.hits[1], report.hits[3]]);
    expect(file.before).toBe(MAIN);
    expect(file.after).toBe(MAIN
      .replace("We study zero shot", "We study zero-shot")
      .replace("Our zero shot setup", "Our zero-shot setup"));
  });

  it("changes the first of two overlapping places and refuses one the text no longer holds", () => {
    const text = "a large language model here\n";
    const rules: TermRule[] = [
      { term: "LLM", variants: ["large language model"] },
      { term: "language-model", variants: ["language model"] },
    ];
    const reports = checkTerms([{ path: "a.tex", text }], rules);
    const hits = reports.flatMap((report) => report.hits);
    expect(hits).toHaveLength(2);
    expect(applyTermHits([{ path: "a.tex", text }], hits)[0].after).toBe("a LLM here\n");
    expect(applyTermHits([{ path: "a.tex", text: "changed\n" }], hits)).toEqual([]);
  });
});

describe("termGuidance", () => {
  it("names the variant and only the rules the excerpt uses", () => {
    const rules: TermRule[] = [zeroShot, { term: "ResNet", variants: [] }];
    const guidance = termGuidance("A zero shot test.", rules, "british");
    expect(guidance.spelling).toContain("British English");
    expect(guidance.rules.join("\n")).toContain("\"zero-shot\" (not \"zero shot\", \"zeroshot\"): Hyphenated as an adjective.");
    expect(guidance.rules.join("\n")).not.toContain("ResNet");
    expect(termGuidance("Nothing relevant.", rules, null)).toEqual({ spelling: null, rules: [] });
  });
});
