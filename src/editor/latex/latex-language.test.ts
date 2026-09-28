import { ensureSyntaxTree, foldable } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";
import { describe, expect, it } from "vitest";
import { latex } from "./latex-language";

const highlighter = tagHighlighter([
  { tag: tags.keyword, class: "keyword" },
  { tag: tags.definitionKeyword, class: "definition" },
  { tag: tags.heading, class: "heading" },
  { tag: tags.labelName, class: "label" },
  { tag: tags.quote, class: "quote" },
  { tag: tags.className, class: "class" },
  { tag: tags.processingInstruction, class: "math-delimiter" },
  { tag: tags.variableName, class: "variable" },
  { tag: tags.operator, class: "operator" },
  { tag: tags.number, class: "number" },
  { tag: tags.bracket, class: "bracket" },
  { tag: tags.comment, class: "comment" },
  { tag: tags.meta, class: "verbatim" },
  { tag: tags.string, class: "string" },
  { tag: tags.strong, class: "strong" },
  { tag: tags.emphasis, class: "emphasis" },
]);

const stateOf = (doc: string) => EditorState.create({ doc, extensions: latex() });

/** Every styled run as `class:text`, in document order. */
function styled(doc: string): string[] {
  const state = stateOf(doc);
  const runs: string[] = [];
  highlightTree(ensureSyntaxTree(state, doc.length, 5_000)!, highlighter, (from, to, style) => {
    runs.push(`${style}:${doc.slice(from, to)}`);
  });
  return runs;
}

/** The fold offered on `lineNumber`, as its first and last line numbers. */
function foldLines(doc: string, lineNumber: number): [number, number] | null {
  const state = stateOf(doc);
  const line = state.doc.line(lineNumber);
  const range = foldable(state, line.from, line.to);
  return range && [state.doc.lineAt(range.from).number, state.doc.lineAt(range.to).number];
}

describe("LaTeX highlighting", () => {
  it("distinguishes structural, reference and font commands from plain ones", () => {
    expect(styled(String.raw`\section{Intro}\label{sec:a} \cite{knuth} \textbf{b} \emph{e} \item \documentclass{x}`))
      .toEqual([
        "heading:\\section", "bracket:{", "bracket:}", "label:\\label", "bracket:{", "bracket:}",
        "quote:\\cite", "bracket:{", "bracket:}", "strong:\\textbf", "bracket:{", "bracket:}",
        "emphasis:\\emph", "bracket:{", "bracket:}", "definition:\\documentclass", "bracket:{", "bracket:}",
      ]);
  });

  it("marks environment names, operators and control symbols", () => {
    expect(styled(String.raw`\begin{itemize} a~b & c \\ 50\% % note`)).toEqual([
      "keyword:\\begin", "bracket:{", "class:itemize", "bracket:}", "operator:~", "operator:&", "operator:\\%",
      "comment:% note",
    ]);
  });

  it("reads inline math and display-math environments as math", () => {
    expect(styled(String.raw`$a^2+\alpha$`)).toEqual([
      "math-delimiter:$", "variable:a", "operator:^", "number:2", "operator:+", "keyword:\\alpha", "math-delimiter:$",
    ]);
    expect(styled("\\begin{equation*}\n  f(x) = 1 \\text{if} \\label{eq}\n\\end{equation*} x")).toEqual([
      "keyword:\\begin", "bracket:{", "class:equation*", "bracket:}",
      "variable:f", "operator:(", "variable:x", "operator:)", "operator:=", "number:1",
      "bracket:{", "bracket:}", "label:\\label", "bracket:{", "bracket:}",
      "keyword:\\end", "bracket:{", "class:equation*", "bracket:}",
    ]);
  });

  it("keeps verbatim bodies, inline verbatim, paths and URLs literal", () => {
    expect(styled("\\begin{verbatim}\n50% $x$ \\foo\n\\end{verbatim} \\bar")).toEqual([
      "keyword:\\begin", "bracket:{", "class:verbatim", "bracket:}", "verbatim:50% $x$ \\foo",
      "keyword:\\end", "bracket:{", "class:verbatim", "bracket:}", "keyword:\\bar",
    ]);
    expect(styled(String.raw`\verb|%x{| \url{a_b%c} \includegraphics[width=1]{fig_1.png}`)).toEqual([
      "verbatim:|%x{|", "bracket:{", "string:a_b%c", "bracket:}",
      "bracket:[", "bracket:]{", "string:fig_1.png", "bracket:}",
    ]);
  });

  it("uses % as the line comment token", () => {
    expect(stateOf("x").languageDataAt("commentTokens", 0)).toEqual([{ line: "%" }]);
  });
});

describe("LaTeX folding", () => {
  const doc = [
    "\\documentclass{article}", // 1
    "\\usepackage{amsmath}", // 2
    "\\begin{document}", // 3
    "% first", // 4
    "% second", // 5
    "\\section{A}", // 6
    "\\newcommand{\\x}{", // 7
    "  body \\{ not a group", // 8
    "}", // 9
    "\\begin{itemize} % \\begin{quote}", // 10
    "  \\begin{itemize}", // 11
    "    \\item nested", // 12
    "  \\end{itemize}", // 13
    "\\end{itemize}", // 14
    "\\subsection{B}", // 15
    "text", // 16
    "", // 17
    "\\section{C}", // 18
    "end", // 19
    "\\end{document}", // 20
  ].join("\n");

  it.each([
    ["the preamble up to \\begin{document}", 1, [1, 2]],
    ["an environment to its matching \\end", 3, [3, 20]],
    ["a comment block", 4, [4, 5]],
    ["a section to the next heading at its level", 6, [6, 16]],
    ["a multi-line brace group, ignoring escaped braces", 7, [7, 9]],
    ["the outer of two nested environments with the same name", 10, [10, 14]],
    ["the inner of two nested environments", 11, [11, 13]],
    ["a subsection up to its parent's next section, without trailing blank lines", 15, [15, 16]],
    ["the last section, stopping before \\end{document}", 18, [18, 19]],
  ] as const)("folds %s", (_name, line, expected) => {
    expect(foldLines(doc, line)).toEqual(expected);
  });

  it("offers nothing for plain lines or a single comment line", () => {
    expect(foldLines(doc, 12)).toBeNull();
    expect(foldLines("text\n% only\ntext", 2)).toBeNull();
  });

  it("does not fold an environment that never closes", () => {
    expect(foldLines("\\begin{figure}\ntext", 1)).toBeNull();
  });
});
