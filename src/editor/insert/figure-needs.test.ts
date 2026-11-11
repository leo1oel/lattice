import { describe, expect, it } from "vitest";
import { completePreamble, figureNeedsOf } from "./figure-needs";

const plain = "% editable-figure source: scheme.reactio\n\\includegraphics{scheme.pdf}\n";
const marked = [
  "% editable-figure source: scheme.reactio",
  "% editable-figure packages: graphicx tikz chemnum",
  String.raw`% editable-figure preamble: \providecommand\rcmpd[1]{\cmpd{#1}}`,
  "% Made by a drawing program",
  String.raw`\begin{tikzpicture}\node {\rcmpd{1}};\end{tikzpicture}`,
  "% editable-figure preamble: not read, past the header",
].join("\n");
const root = [
  String.raw`\documentclass{article}`,
  String.raw`\usepackage{graphicx}`,
  String.raw`\graphicspath{{figures/}}`,
  String.raw`\begin{document}`,
  String.raw`\input{figures/scheme}`,
  String.raw`\end{document}`,
  "",
].join("\n");

/** The definitions Reactio Draw writes for its marks (its docs/latex-marks.md). */
const RCMPD: string[] = [
  "% Compound marks from drawings: \\rcmpd{what is inside [[ ]]}, added for editable figures",
  "\\makeatletter",
  "\\providecommand\\rcmpd@series[2]{%",
  "  \\@ifundefined{cmpdser@#1@#2}{%",
  "    \\@ifundefined{c@cmpdser#1}{\\newcounter{cmpdser#1}}{}%",
  "    \\stepcounter{cmpdser#1}%",
  "    \\expandafter\\xdef\\csname cmpdser@#1@#2\\endcsname{\\csname rcmpd@style@#1\\endcsname{\\value{cmpdser#1}}}%",
  "    \\immediate\\write\\@auxout{\\string\\cmpdser@aux{#1}{#2}{\\csname cmpdser@#1@#2\\endcsname}}%",
  "  }{}%",
  "  \\textbf{\\csname cmpdser@#1@#2\\endcsname}%",
  "}",
  "\\providecommand\\cmpdser@aux[3]{}",
  "\\providecommand\\rcmpd@style@A[1]{\\@Alph{#1}}",
  "\\providecommand\\rcmpd@style@a[1]{\\@alph{#1}}",
  "\\providecommand\\rcmpd@style@I[1]{\\@Roman{#1}}",
  "\\providecommand\\rcmpd@style@i[1]{\\@roman{#1}}",
  "\\makeatother",
  "\\ExplSyntaxOn",
  "\\ProvideDocumentCommand \\rcmpd { m }",
  "  {",
  "    \\regex_match:nnTF { \\A [A-Za-z0-9_\\-] } {#1}",
  "      {",
  "        \\regex_extract_once:nnNTF { \\A ([AaIi]) \\: (.*) \\Z } {#1} \\l_tmpa_seq",
  "          { \\use:c { rcmpd@series } { \\seq_item:Nn \\l_tmpa_seq { 2 } } { \\seq_item:Nn \\l_tmpa_seq { 3 } } }",
  "          {",
  "            \\regex_extract_once:nnNTF { \\A ([^.]+ \\. [^.]+) \\. (num|dash) \\Z } {#1} \\l_tmpa_seq",
  "              {",
  "                \\use:e",
  "                  {",
  "                    \\exp_not:N \\cmpd",
  "                    [ post-main-label-code = \\str_if_eq:eeTF { \\seq_item:Nn \\l_tmpa_seq { 3 } } { num } { . } { - } , sub-counter-format = arabic ]",
  "                    { \\seq_item:Nn \\l_tmpa_seq { 2 } }",
  "                  }",
  "              }",
  "              {",
  "                \\regex_extract_once:nnNTF { \\A ([^.]+ \\. [^.]+) \\. letter \\Z } {#1} \\l_tmpa_seq",
  "                  { \\use:e { \\exp_not:N \\cmpd { \\seq_item:Nn \\l_tmpa_seq { 2 } } } }",
  "                  { \\cmpd {#1} }",
  "              }",
  "          }",
  "      }",
  "      { \\textbf { ?? } }",
  "  }",
  "\\ExplSyntaxOff"
];

describe("what a figure needs", () => {
  it("reads what the entry states in its header, and what its code uses", () => {
    expect(figureNeedsOf(plain)).toEqual({ packages: ["graphicx"], preamble: [] });
    expect(figureNeedsOf(marked)).toEqual({ packages: ["graphicx", "tikz", "chemnum"], preamble: [String.raw`\providecommand\rcmpd[1]{\cmpd{#1}}`] });
    expect(figureNeedsOf(String.raw`% editable-figure source: s.reactio` + "\n" + String.raw`\begin{tikzpicture}\node {\cmpd{a}};\end{tikzpicture}`)?.packages).toEqual(["tikz", "chemnum"]);
  });
  it("is nothing for a file that is not a figure, and takes only plain package names", () => {
    expect(figureNeedsOf(String.raw`\section{Intro} \cmpd{a}`)).toBeNull();
    expect(figureNeedsOf("% editable-figure source: s.reactio\n% editable-figure packages: ok,also-ok bad} x[y]")?.packages).toEqual(["ok", "also-ok"]);
  });
  it("ignores a header line too long to be one, and what follows it", () => {
    const long = `% editable-figure source: s.reactio\n% editable-figure preamble: ${"x".repeat(2000)}\n% editable-figure packages: tikz`;
    expect(figureNeedsOf(long)).toEqual({ packages: [], preamble: [] });
  });
});

describe("completing a root document's preamble", () => {
  it("adds the packages after the last package line and the definitions before the document", () => {
    const needs = figureNeedsOf(marked)!;
    const { text, added, withheld } = completePreamble(root, "", "figures/scheme.tex", needs);
    expect(text).toBe([
      String.raw`\documentclass{article}`,
      String.raw`\usepackage{graphicx}`,
      String.raw`\usepackage{tikz}`,
      String.raw`\usepackage{chemnum}`,
      String.raw`\graphicspath{{figures/}}`,
      String.raw`\providecommand\rcmpd[1]{\cmpd{#1}}`,
      String.raw`\begin{document}`,
      String.raw`\input{figures/scheme}`,
      String.raw`\end{document}`,
      "",
    ].join("\n"));
    expect(added).toEqual([String.raw`\usepackage{tikz}`, String.raw`\usepackage{chemnum}`, String.raw`\providecommand\rcmpd[1]{\cmpd{#1}}`]);
    expect(withheld).toEqual([]);
    // Complete once: nothing more the second time.
    expect(completePreamble(text!, "", "figures/scheme.tex", needs).text).toBeNull();
  });
  it("adds a drawing program's whole block of definitions, once", () => {
    const block = RCMPD;
    const entry = ["% editable-figure source: s.reactio", ...block.map((line) => `% editable-figure preamble: ${line}`), String.raw`\begin{tikzpicture}\node {\rcmpd{1}};\end{tikzpicture}`].join("\n");
    const { text, withheld } = completePreamble(root, "", "figures/scheme.tex", figureNeedsOf(entry)!);
    expect(withheld).toEqual([]);
    expect(text).toContain(`${block.join("\n")}\n\\begin{document}`);
    expect(completePreamble(text!, "", "figures/scheme.tex", figureNeedsOf(entry)!).text).toBeNull();
  });
  it("takes an older version of the block as the block", () => {
    const entry = ["% editable-figure source: s.reactio", ...RCMPD.map((line) => `% editable-figure preamble: ${line}`)].join("\n");
    const older = root.replace("\\begin{document}", `${RCMPD.join("\n").replace("_\\-]", "_-]")}\n\\begin{document}`);
    expect(older).toContain("_-]");
    expect(completePreamble(older, "", "figures/scheme.tex", figureNeedsOf(entry)!).text).toBeNull();
  });
  it("counts what the preamble's own files define", () => {
    const needs = { packages: [], preamble: [String.raw`\providecommand\rcmpd[1]{#1}`] };
    expect(completePreamble(root, String.raw`\newcommand\rcmpd[1]{#1}`, "figures/scheme.tex", needs).text).toBeNull();
  });
  it("holds back lines that do more than define", () => {
    const needs = { packages: [], preamble: [String.raw`\input{/etc/passwd}`] };
    expect(completePreamble(root, "", "figures/scheme.tex", needs)).toEqual({ text: null, added: [], withheld: [String.raw`\input{/etc/passwd}`], unlisted: null });
  });
  it("counts the packages and graphics path a preamble file sets", () => {
    const bare = [String.raw`\documentclass{article}`, String.raw`\input{preamble}`, String.raw`\begin{document}`, String.raw`\input{figures/scheme}`, String.raw`\end{document}`, ""].join("\n");
    const known = [String.raw`\usepackage{graphicx,tikz}`, String.raw`\RequirePackage[nobreak]{chemnum}`, String.raw`\graphicspath{{./img/}{./figures/}}`].join("\n");
    const { text, unlisted } = completePreamble(bare, known, "figures/scheme.tex", figureNeedsOf(marked)!);
    expect(text?.match(/\\usepackage/g) ?? []).toEqual([]);
    expect(text ?? "").not.toContain("graphicspath");
    expect(unlisted).toBeNull();
  });
  it("names a folder missing from a preamble file's graphics path instead of adding a second one", () => {
    const bare = [String.raw`\documentclass{article}`, String.raw`\input{preamble}`, String.raw`\begin{document}`, String.raw`\end{document}`, ""].join("\n");
    const known = [String.raw`\usepackage{graphicx,tikz,chemnum}`, String.raw`\graphicspath{{img/}}`].join("\n");
    const { text, unlisted } = completePreamble(bare, known, "figures/scheme.tex", figureNeedsOf(marked)!);
    expect(text ?? "").not.toContain("graphicspath");
    expect(unlisted).toBe("figures/");
    // One in the root's own preamble is extended as before, and nothing is named.
    const own = bare.replace("\\begin{document}", "\\graphicspath{{img/}}\n\\begin{document}");
    const completed = completePreamble(own, known, "figures/scheme.tex", figureNeedsOf(marked)!);
    expect(completed.text).toContain(String.raw`\graphicspath{{img/}{figures/}}`);
    expect(completed.unlisted).toBeNull();
  });
  it("changes nothing in a file without a preamble", () => {
    expect(completePreamble(String.raw`\input{figures/scheme}`, "", "figures/scheme.tex", figureNeedsOf(marked)!).text).toBeNull();
  });
});
