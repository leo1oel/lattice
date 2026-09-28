import { describe, expect, it } from "vitest";
import { latexFigureInsertion, markdownAssetInsertion, rewriteMovedDocumentAssetPaths } from "./figure-insertion";

describe("figure insertion", () => {
  it("creates editable LaTeX figure blocks with stable labels, or a custom width, caption, placement, and label", () => {
    const edit = latexFigureInsertion("before\nafter", 7, ["figures/Native UMM-converted.pdf"]);
    expect(edit.text).toBe(
      "\n\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{\\detokenize{figures/Native UMM-converted.pdf}}\n  \\caption{Describe the figure.}\n  \\label{fig:native-umm}\n\\end{figure}\n\n",
    );
    expect(edit.text.slice(0, edit.cursorOffset).endsWith("Describe the figure.")).toBe(true);

    const { text } = latexFigureInsertion("body", 0, ["figures/plot.pdf"], {
      width: "0.5\\linewidth",
      placement: "ht",
      caption: "A plot",
      label: "fig:plot",
    });
    for (const part of ["\\begin{figure}[ht]", "width=0.5\\linewidth", "\\caption{A plot}", "\\label{fig:plot}"]) {
      expect(text).toContain(part);
    }
  });

  it.each([
    ["a relative image link for renderable figures", "# Notes\nNext", 8, "figures/Native UMM.svg", "\n![Native UMM](<../figures/Native UMM.svg>)\n\n"],
    ["a regular link for PDF files", "", 0, "figures/result.pdf", "[result.pdf](<../figures/result.pdf>)\n"],
  ])("inserts Markdown assets as %s", (_name, source, position, path, expected) => {
    expect(markdownAssetInsertion(source, position, [path], "notes/method.md").text).toBe(expected);
  });
});

describe("moved document image paths", () => {
  const assets = new Set([
    "figures/plot.png",
    "figures/Native UMM.svg",
    "figures/My Plot.png",
    "figures/scaled-dot-product-attention.png",
    "chapters/local.png",
  ]);
  const lines = (...parts: string[]) => parts.join("\n");
  // Plain links, fenced examples, and commented images are never rebased.
  const untouched = [
    "[Download](figures/plot.png)", "```md", "![Example](figures/plot.png)", "```",
    "<!-- ![Commented](figures/plot.png) -->",
  ];

  it.each([
    [
      "rebases Markdown image destinations while preserving titles and external URLs",
      "notes.md",
      "chapters/notes.md",
      lines(
        "![Plot](figures/plot.png)",
        '![Native](<figures/Native UMM.svg> "Overview")',
        "![Remote](https://example.com/plot.png)",
        "![Encoded](figures/My%20Plot.png)",
        '<img src="figures/scaled-dot-product-attention.png" alt="Attention" width={223} />',
        ...untouched,
      ),
      lines(
        "![Plot](../figures/plot.png)",
        '![Native](<../figures/Native UMM.svg> "Overview")',
        "![Remote](https://example.com/plot.png)",
        "![Encoded](../figures/My%20Plot.png)",
        '<img src="../figures/scaled-dot-product-attention.png" alt="Attention" width={223} />',
        ...untouched,
      ),
    ],
    ["rebases Markdown images when moving back to the project root", "chapters/notes.md", "notes.md", "![Plot](../figures/plot.png)", "![Plot](figures/plot.png)"],
    [
      "keeps project-root LaTeX paths stable and rebases document-relative paths",
      "chapters/method.tex",
      "chapters/archive/method.tex",
      lines(
        "\\includegraphics{figures/plot.png}",
        "\\includegraphics[width=\\linewidth]{\\detokenize{../figures/Native UMM.svg}}",
        "% \\includegraphics{../figures/plot.png}",
      ),
      lines(
        "\\includegraphics{figures/plot.png}",
        "\\includegraphics[width=\\linewidth]{\\detokenize{../../figures/Native UMM.svg}}",
        "% \\includegraphics{../figures/plot.png}",
      ),
    ],
    ["leaves missing paths unchanged", "notes.md", "chapters/notes.md", "![Missing](missing.png)", "![Missing](missing.png)"],
    ["leaves non-document files unchanged", "notes.txt", "chapters/notes.txt", "![Plot](figures/plot.png)", "![Plot](figures/plot.png)"],
  ])("%s", (_name, from, to, source, expected) => {
    expect(rewriteMovedDocumentAssetPaths(source, from, to, assets)).toBe(expected);
  });
});
