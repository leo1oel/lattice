import { describe, expect, it } from "vitest";
import { scanConstructs, type Construct } from "./visual-scan";

const scan = (text: string) => scanConstructs(text, 0).constructs;
/** Each construct's kind and the source it covers. */
const covered = (text: string) => scan(text).map((construct) => [construct.kind, text.slice(construct.from, construct.to)]);
const only = <K extends Construct["kind"]>(text: string, kind: K) =>
  scan(text).filter((construct): construct is Extract<Construct, { kind: K }> => construct.kind === kind);

describe("scanConstructs", () => {
  it("finds styled text with its hidden command and brace", () => {
    const text = "a \\textbf{bold \\emph{both}} b";
    const [bold, emph] = only(text, "style");
    expect(bold.style).toBe("bold");
    expect(text.slice(bold.open.from, bold.open.to)).toBe("\\textbf{");
    expect(text.slice(bold.close.from, bold.close.to)).toBe("}");
    expect(text.slice(bold.open.to, bold.close.from)).toBe("bold \\emph{both}");
    expect(emph.style).toBe("emph");
    expect(text.slice(emph.open.to, emph.close.from)).toBe("both");
  });

  it("reads an old-style switch at the start of a group", () => {
    const [style] = only("x {\\bf strong} y {a \\it no}", "style");
    expect(style.style).toBe("bold");
    expect(only("x {\\bf strong} y {a \\it no}", "style")).toHaveLength(1);
  });

  it("leaves an unclosed argument as source", () => {
    expect(only("\\textbf{never closed", "style")).toEqual([]);
    expect(only("\\section{Intro", "heading")).toEqual([]);
  });

  it("reads headings with a star and a short title", () => {
    const text = "\\section*[Short]{A \\emph{long} title}\n";
    const [heading] = only(text, "heading");
    expect(heading.level).toBe(2);
    expect(text.slice(heading.open.from, heading.open.to)).toBe("\\section*[Short]{");
    expect(text.slice(heading.open.to, heading.close.from)).toBe("A \\emph{long} title");
  });

  it("finds inline and display math with each delimiter", () => {
    const text = "$a$ and \\(b\\) and $$c$$ and \\[d\\]\n\\begin{equation}\\label{eq:e} e \\end{equation}\n\\begin{align*}f &= g\\end{align*}";
    const math = only(text, "math");
    expect(math.map((region) => [region.display, text.slice(region.body.from, region.body.to)])).toEqual([
      [false, "a"], [false, "b"], [true, "c"], [true, "d"], [true, "\\label{eq:e} e "], [true, "f &= g"],
    ]);
    expect(math[4].environment).toBe("equation");
  });

  it("does not read math across a blank line, or an escaped dollar as one", () => {
    expect(only("$a\n\nb$", "math")).toEqual([]);
    expect(only("costs \\$5 and \\$6", "math")).toEqual([]);
    expect(only("\\begin{equation}\nx\n\n\\end{equation}", "math")).toEqual([]);
  });

  it("reads nothing inside math, comments, verbatim and \\verb", () => {
    const text = "$\\textbf{x}$ % \\emph{y}\n\\begin{verbatim}\n\\section{z} $w$\n\\end{verbatim}\n\\verb|\\cite{k}|";
    expect(covered(text)).toEqual([["math", "$\\textbf{x}$"]]);
  });

  it("turns quotes, dashes, ties, escapes and accents into the characters they print", () => {
    const text = "``a'' `b' c--d e---f g~h \\% \\& \\'e \\\"{o} \\c{c} \\ldots \\LaTeX{} x";
    expect(only(text, "symbol").map((symbol) => [text.slice(symbol.from, symbol.to), symbol.text])).toEqual([
      ["``", "“"], ["''", "”"], ["`", "‘"], ["--", "–"], ["---", "—"], ["~", " "], ["\\%", "%"], ["\\&", "&"],
      ["\\'e", "é"], ["\\\"{o}", "ö"], ["\\c{c}", "ç"], ["\\ldots", "…"], ["\\LaTeX{}", "LaTeX"],
    ]);
  });

  it("leaves a line break and unknown commands as source", () => {
    expect(scan("a \\\\ b \\foo[bar]{baz} \\newline")).toEqual([]);
  });

  it("reads references, citations with notes, labels and includes", () => {
    const text = "\\eqref{eq:a} \\cref{fig:a,fig:b} \\citep[see][p.~5]{smith, doe} \\label{sec:x} \\input{chapters/intro}";
    expect(only(text, "reference").map((reference) => [reference.command, reference.keys])).toEqual([
      ["eqref", ["eq:a"]], ["cref", ["fig:a", "fig:b"]],
    ]);
    const [citation] = only(text, "citation");
    expect(citation.keys).toEqual(["smith", "doe"]);
    expect(citation.notes).toEqual(["see", "p.~5"]);
    expect(only(text, "label")[0].key).toBe("sec:x");
    expect(only(text, "include")[0].path).toBe("chapters/intro");
  });

  it("numbers list items per list and depth, and reads description terms", () => {
    const text = [
      "\\begin{enumerate}",
      "  \\item one",
      "  \\begin{itemize}",
      "    \\item inner",
      "  \\end{itemize}",
      "  \\item two",
      "\\end{enumerate}",
      "\\begin{description}\\item[Term] text\\end{description}",
    ].join("\n");
    const items = only(text, "item");
    expect(items.map((item) => [item.list, item.depth, item.index])).toEqual([
      ["enumerate", 1, 1], ["itemize", 2, 1], ["enumerate", 1, 2], ["description", 1, 1],
    ]);
    expect(text.slice(items[0].from, items[0].to)).toBe("\\item ");
    const term = items[3].term!;
    expect(text.slice(term.from, term.to)).toBe("Term");
    expect(only(text, "environment").map((token) => [token.name, token.begin])).toEqual([
      ["enumerate", true], ["itemize", true], ["itemize", false], ["enumerate", false], ["description", true], ["description", false],
    ]);
  });

  it("continues a list's numbering from the frames open where a scan starts", () => {
    const { constructs, open } = scanConstructs("\\item c\n\\item d", 100, [{ name: "enumerate", items: 2 }]);
    expect(constructs.map((construct) => construct.kind === "item" && construct.index)).toEqual([3, 4]);
    expect(constructs[0].from).toBe(100);
    expect(open).toEqual([{ name: "enumerate", items: 4 }]);
  });

  it("reads a figure's image and numbers its caption from its label", () => {
    const text = [
      "\\begin{figure}[t]",
      "  \\centering",
      "  \\includegraphics[width=0.5\\linewidth]{figures/plot}",
      "  \\caption{A \\emph{plot}.}\\label{fig:plot}",
      "\\end{figure}",
    ].join("\n");
    const [image] = only(text, "image");
    expect(image.path).toBe("figures/plot");
    expect(image.options).toBe("width=0.5\\linewidth");
    const [caption] = only(text, "caption");
    expect(caption.float).toBe("figure");
    expect(caption.label).toBe("fig:plot");
    expect(only(text, "environment")[0].argument).toBe("t");
    expect(only(text, "symbol").map((symbol) => text.slice(symbol.from, symbol.to))).toEqual(["\\centering"]);
  });

  it("reads \\url and \\href without reading their addresses as LaTeX", () => {
    const text = "\\url{https://a.org/%7Ex_y} \\href{https://b.org/#top}{the \\emph{site}}";
    const [url, emph] = only(text, "style");
    expect(url.style).toBe("link");
    expect(text.slice(url.open.to, url.close.from)).toBe("https://a.org/%7Ex_y");
    expect(emph.style).toBe("emph");
    const [link] = only(text, "link");
    expect(link.url).toBe("https://b.org/#top");
    expect(text.slice(link.open.to, link.close.from)).toBe("the \\emph{site}");
  });

  it("offsets every construct by where the text starts in the document", () => {
    const [math] = scanConstructs("x $y$", 50).constructs;
    expect([math.from, math.to]).toEqual([52, 55]);
  });
});
