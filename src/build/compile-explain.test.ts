import { describe, expect, it } from "vitest";
import { explainDiagnostic } from "./compile-explain";
import { replaceTokenOnLine } from "./compile-diagnostics";

const source = [
  "\\documentclass{article}",
  "\\begin{document}",
  "Attention \\citep{bahdanau2015} and \\citep{vaswani2017} and \\citep{luong2015}.",
  "Neural machine translation systems \\cietp{luong2015effective}.",
  "\\end{document}",
].join("\n");
const log = "./main.tex:4: Undefined control sequence.\nl.4 Neural machine translation systems \\cietp\n                {luong2015effective}.";
const undefinedCommand = { level: "error", message: "Undefined control sequence.", file: "main.tex", line: 4 };

describe("explainDiagnostic", () => {
  it("names the unknown command, quotes its line and suggests the paper's own command", () => {
    const explained = explainDiagnostic(undefinedCommand, { log, source, afterError: true });
    expect(explained?.headline).toBe("Unknown command \\cietp");
    expect(explained?.explanation).toBe("LaTeX doesn’t know \\cietp. It looks like a typo for \\citep, which this paper uses 3 times.");
    expect(explained?.suggestion).toBe("\\citep");
    expect(explained?.excerpt.map((line) => [line.number, line.failing])).toEqual([[3, false], [4, true], [5, false]]);
    const failing = explained!.excerpt[1]!;
    expect(failing.text.slice(failing.token!.start, failing.token!.end)).toBe("\\cietp");
  });

  it("leaves the suggestion out when nothing is close, or two candidates are equally close", () => {
    const far = explainDiagnostic(undefinedCommand, {
      log: log.replace("\\cietp", "\\zzqxv"), source: source.replace("\\cietp", "\\zzqxv"), afterError: true,
    });
    expect(far?.headline).toBe("Unknown command \\zzqxv");
    expect(far?.suggestion).toBeUndefined();
    expect(far?.explanation).toContain("Check its spelling");
    // \citex is one edit from \citet and \citep, each used once here.
    const tied = explainDiagnostic(undefinedCommand, {
      log: log.replace("\\cietp", "\\citex"), source: "\\citet{a} \\citep{b} \\citex{c}", afterError: true,
    });
    expect(tied?.suggestion).toBeUndefined();
    // LaTeX's own vocabulary answers when the paper has nothing close.
    const known = explainDiagnostic(undefinedCommand, {
      log: log.replace("\\cietp", "\\sectoin"), source: "a\nb\nc\n\\sectoin{Intro}", afterError: true,
    });
    expect(known?.suggestion).toBe("\\section");
    expect(known?.explanation).toBe("LaTeX doesn’t know \\sectoin. It looks like a typo for \\section.");
  });

  it("does not guess for a short command, where two edits reach almost anything", () => {
    const short = explainDiagnostic(undefinedCommand, { log: log.replace("\\cietp", "\\fo"), source, afterError: true });
    expect(short?.suggestion).toBeUndefined();
  });

  it("falls back to TeX's words when the log has no context line to read the token from", () => {
    expect(explainDiagnostic(undefinedCommand, { log: "Build output", source, afterError: true })).toBeNull();
  });

  it("reads each error's own context, not the first one on the same line number", () => {
    const twice = [
      "./main.tex:4: Undefined control sequence.", "l.4 Neural \\cietp", "               {a} and \\reff{b}.",
      "./main.tex:4: Undefined control sequence.", "l.4 Neural \\cietp{a} and \\reff", "                         {b}.",
    ].join("\n");
    const line = source.replace("\\cietp{luong2015effective}", "\\cietp{a} and \\reff{b}");
    expect(explainDiagnostic(undefinedCommand, { log: twice, source: line, afterError: true, sameAfter: 1 })?.headline).toBe("Unknown command \\cietp");
    const second = explainDiagnostic(undefinedCommand, { log: twice, source: line, afterError: true });
    expect(second?.headline).toBe("Unknown command \\reff");
    const failing = second!.excerpt[1]!;
    expect(failing.text.slice(failing.token!.start, failing.token!.end)).toBe("\\reff");
  });

  it("names the command a macro reached, and neither quotes nor rewrites the line that used the macro", () => {
    const macro = "./main.tex:4: Undefined control sequence.\n\\vect ->\\vec{v}\\xspce \n                    \nl.4 Neural machine translation systems \\vect\n";
    const explained = explainDiagnostic(undefinedCommand, {
      log: macro, source: source.replace("\\cietp{luong2015effective}", "\\vect"), afterError: true,
    });
    expect(explained?.headline).toBe("Unknown command \\xspce");
    expect(explained?.suggestion).toBeUndefined();
    expect(explained?.excerpt).toEqual([]);
  });

  it("leaves a missing package or class to the install advice", () => {
    for (const file of ["neurips_2024.sty", "acmart.cls", "plainnat.bst", "authoryear.bbx", "authoryear.cbx"]) {
      expect(explainDiagnostic({ level: "error", message: `LaTeX Error: File \`${file}' not found.`, file: "main.tex", line: 3 }, { log: "", source, afterError: true })).toBeNull();
    }
  });

  it("leaves Lattice's own advice and unknown messages alone", () => {
    expect(explainDiagnostic({ level: "error", message: "Stale failed build.", code: "stale-build" }, { log, source, afterError: true })).toBeNull();
    expect(explainDiagnostic({ level: "warning", message: "Something else." }, { log, source, afterError: false })).toBeNull();
  });

  it("rewrites the common warnings, saying when one may only echo the error", () => {
    const citation = { level: "warning", message: "Citation `luong2015effective' on page 1 undefined on input line 4." };
    expect(explainDiagnostic(citation, { log, source, afterError: true })).toMatchObject({
      headline: "No entry for luong2015effective",
      explanation: expect.stringContaining("may clear once the error above is fixed"),
      excerpt: [],
    });
    expect(explainDiagnostic(citation, { log, source, afterError: false })?.explanation).toContain("add the entry to the .bib file");
    expect(explainDiagnostic({ level: "warning", message: "Overfull \\hbox (6.1pt too wide) in paragraph at lines 4--4" }, { log, source, afterError: false })?.headline)
      .toBe("A line runs 6.1 pt into the margin");
    expect(explainDiagnostic({ level: "warning", message: "Reference `fig:arch' on page 2 undefined on input line 9." }, { log, source, afterError: false })?.explanation)
      .toBe("Nothing in the paper has \\label{fig:arch}. Check the spelling, or add the label where the reference should point.");
  });

  it.each([
    ["Missing $ inserted.", "Math outside math mode"],
    ["Extra }, or forgotten $.", "A } with no { before it"],
    ["Missing } inserted.", "A { is never closed"],
    ["File ended while scanning use of \\textbf.", "A { is never closed"],
    ["Paragraph ended before \\emph was complete.", "\\emph runs past a blank line"],
    ["Extra alignment tab has been changed to \\cr.", "Too many & in a table row"],
    ["Misplaced alignment tab character &.", "An & outside a table"],
    ["Double subscript.", "Two subscripts in a row"],
    ["LaTeX Error: Environment algorithmic undefined.", "Unknown environment algorithmic"],
    ["LaTeX Error: \\begin{figure} on input line 12 ended by \\end{table}.", "\\begin{figure} is closed by \\end{table}"],
    ["LaTeX Error: File `figures/plot.pdf' not found.", "File not found: figures/plot.pdf"],
    ["LaTeX Error: Missing \\begin{document}.", "Text before \\begin{document}"],
    ["LaTeX Error: Can be used only in preamble.", "A preamble command inside the document"],
    ["LaTeX Error: Option clash for package xcolor.", "xcolor is loaded twice with different options"],
    ["Illegal unit of measure (pt inserted).", "A length without a unit"],
    ["Label `sec:intro' multiply defined.", "The label sec:intro is used twice"],
    ["Float too large for page by 12.3pt on input line 40.", "A figure or table is 12.3 pt taller than the page"],
  ])("explains %s", (message, headline) => {
    expect(explainDiagnostic({ level: "error", message, file: "main.tex", line: 4 }, { log: "", source, afterError: true })?.headline).toBe(headline);
  });

  it("explains pdfLaTeX's CJK Unicode error and leaves other characters to TeX", () => {
    const refused = (character: string, code: string) => ({
      level: "error", message: `LaTeX Error: Unicode character ${character} (U+${code})`, file: "main.tex", line: 1,
    });
    const chinese = explainDiagnostic(refused("论", "8BBA"), { log: "", source: "\\title{我的论文}", afterError: true });
    expect(chinese?.headline).toBe("pdfLaTeX can’t typeset 论");
    expect(chinese?.explanation).toBe("pdfLaTeX has no fonts for Chinese, Japanese or Korean text. Add \\usepackage{ctex} to the preamble and switch the project to XeLaTeX.");
    const failing = chinese!.excerpt[0]!;
    expect(failing.text.slice(failing.token!.start, failing.token!.end)).toBe("论");
    expect(explainDiagnostic(refused("한", "D55C"), { log: "", source: null, afterError: true })?.headline).toBe("pdfLaTeX can’t typeset 한");
    expect(explainDiagnostic(refused("☃", "2603"), { log: "", source: null, afterError: true })).toBeNull();
  });
});

describe("replaceTokenOnLine", () => {
  it("replaces the whole command on its line and nothing that only starts with it", () => {
    const text = "a \\cite{x}\n\\citep{y} \\cite{z}";
    const edit = replaceTokenOnLine(text, 2, "\\cite", "\\citet");
    expect(edit).toEqual({ from: 21, to: 26, insert: "\\citet" });
    expect(text.slice(edit!.from, edit!.to)).toBe("\\cite");
    expect(replaceTokenOnLine(text, 2, "\\cietp", "\\citep")).toBeNull();
    expect(replaceTokenOnLine(text, 3, "\\cite", "\\citet")).toBeNull();
  });
});
