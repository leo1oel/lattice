import { describe, expect, it } from "vitest";
import { protectedDifference, protectedLatexSignature, protectedLatexSpans } from "./latex-protected";

const spans = (source: string) => protectedLatexSpans(source).map(({ from, to, kind }) => [kind, source.slice(from, to)]);
const changed = (before: string, after: string) =>
  protectedDifference(protectedLatexSignature(before), protectedLatexSignature(after));

describe("protectedLatexSpans", () => {
  it("protects math in every delimiter form", () => {
    expect(spans("Let $x$ and $$y$$ with \\(a\\) and \\[b\\].")).toEqual([
      ["math", "$x$"], ["math", "$$y$$"], ["math", "\\(a\\)"], ["math", "\\[b\\]"],
    ]);
    expect(spans("a \\begin{align*}x &= 1\n\ny\\end{align*} b")).toEqual([["math", "\\begin{align*}x &= 1\n\ny\\end{align*}"]]);
  });

  it("treats an escaped dollar or percent as prose and a bare percent as a comment", () => {
    expect(spans("costs \\$5, 50\\% off % note\nnext")).toEqual([
      ["command", "\\$"], ["command", "\\%"], ["comment", "% note"],
    ]);
    expect(spans("$a\\$b$ c")).toEqual([["math", "$a\\$b$"]]);
  });

  it("protects citation, reference and label commands with every argument", () => {
    expect(spans("see \\cite[p.~4]{smith, jones} and \\ref {fig:a}\\label{sec:x}.")).toEqual([
      ["reference", "\\cite[p.~4]{smith, jones}"], ["reference", "\\ref {fig:a}"], ["reference", "\\label{sec:x}"],
    ]);
  });

  it("leaves prose arguments of known text commands editable", () => {
    expect(spans("\\caption[Short]{A exmaple \\emph{figure}}")).toEqual([
      ["command", "\\caption[Short]"], ["command", "{"], ["command", "\\emph"], ["command", "{"], ["command", "}"], ["command", "}"],
    ]);
    expect(spans("\\textcolor{red}{hi}")).toEqual([["command", "\\textcolor{red}"], ["command", "{"], ["command", "}"]]);
  });

  it("protects an unknown macro's arguments whole", () => {
    expect(spans("\\todo[inline]{fix teh text} \\LaTeX{} is")).toEqual([
      ["command", "\\todo[inline]{fix teh text}"], ["command", "\\LaTeX{}"],
    ]);
  });

  it("protects environment boundaries, verbatim code and paragraph breaks", () => {
    expect(spans("\\begin{figure}[t]\nText.\n\n  More \\verb|$x| here.\n\\end{figure}")).toEqual([
      ["environment", "\\begin{figure}[t]"], ["paragraph", "\n\n  "], ["verbatim", "\\verb|$x|"], ["environment", "\\end{figure}"],
    ]);
    expect(spans("\\begin{verbatim}\n% $x\n\\end{verbatim}")).toEqual([["verbatim", "\\begin{verbatim}\n% $x\n\\end{verbatim}"]]);
  });

  it("ends an unclosed inline math at its paragraph", () => {
    expect(spans("an $x open\n\nnext $y$")).toEqual([["math", "$x open"], ["paragraph", "\n\n"], ["math", "$y$"]]);
  });
});

describe("protectedDifference", () => {
  it("accepts prose edits that keep every protected span", () => {
    expect(changed("We beleive $x$ \\cite{a}.", "We believe $x$ \\cite{a}.")).toBeNull();
    expect(changed("\\caption{A exmaple}", "\\caption{An example}")).toBeNull();
    expect(changed("one\n\ntwo", "one\n  \ntwo")).toBeNull();
  });

  it("names the kind of protected LaTeX an edit changed", () => {
    expect(changed("We beleive $x$.", "We believe $y$.")).toBe("math");
    expect(changed("see \\cite{a}.", "see \\cite{b}.")).toBe("reference");
    expect(changed("text % todo\nmore", "text % to do\nmore")).toBe("comment");
    expect(changed("one\n\ntwo", "one two")).toBe("paragraph");
    expect(changed("50\\% of", "50% of")).toBe("command");
    expect(changed("price", "price $5")).toBe("math");
    expect(changed("\\LaTeX is", "\\LaTeXis")).toBe("command");
    expect(changed("\\emph{word}", "\\emph{word")).toBe("command");
  });
});
