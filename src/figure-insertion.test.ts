import { describe, expect, it } from "vitest";
import {
  latexFigureInsertion,
  markdownAssetInsertion,
  rewriteMovedDocumentAssetPaths,
} from "./figure-insertion";

describe("LaTeX figure insertion", () => {
  it("creates editable figure blocks with stable labels", () => {
    const edit = latexFigureInsertion("before\nafter", 7, ["figures/Native UMM-converted.pdf"]);
    expect(edit.text).toBe(
      "\n\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{\\detokenize{figures/Native UMM-converted.pdf}}\n  \\caption{Describe the figure.}\n  \\label{fig:native-umm}\n\\end{figure}\n\n",
    );
    expect(edit.text.slice(0, edit.cursorOffset).endsWith("Describe the figure.")).toBe(true);
  });

  it("applies custom width caption placement and label", () => {
    const edit = latexFigureInsertion("body", 0, ["figures/plot.pdf"], {
      width: "0.5\\linewidth",
      placement: "ht",
      caption: "A plot",
      label: "fig:plot",
    });
    expect(edit.text).toContain("\\begin{figure}[ht]");
    expect(edit.text).toContain("width=0.5\\linewidth");
    expect(edit.text).toContain("\\caption{A plot}");
    expect(edit.text).toContain("\\label{fig:plot}");
  });
});

describe("Markdown asset insertion", () => {
  it("uses a relative image link for renderable figures", () => {
    const edit = markdownAssetInsertion(
      "# Notes\nNext",
      8,
      ["figures/Native UMM.svg"],
      "notes/method.md",
    );
    expect(edit.text).toBe("\n![Native UMM](<../figures/Native UMM.svg>)\n\n");
  });

  it("uses a regular link for PDF files", () => {
    const edit = markdownAssetInsertion("", 0, ["figures/result.pdf"], "notes/method.md");
    expect(edit.text).toBe("[result.pdf](<../figures/result.pdf>)\n");
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

  it("rebases Markdown image destinations while preserving titles and external URLs", () => {
    const source = [
      "![Plot](figures/plot.png)",
      '![Native](<figures/Native UMM.svg> "Overview")',
      "![Remote](https://example.com/plot.png)",
      "![Encoded](figures/My%20Plot.png)",
      '<img src="figures/scaled-dot-product-attention.png" alt="Attention" width={223} />',
      "[Download](figures/plot.png)",
      "```md",
      "![Example](figures/plot.png)",
      "```",
      "<!-- ![Commented](figures/plot.png) -->",
    ].join("\n");

    expect(rewriteMovedDocumentAssetPaths(
      source,
      "notes.md",
      "chapters/notes.md",
      assets,
    )).toBe([
      "![Plot](../figures/plot.png)",
      '![Native](<../figures/Native UMM.svg> "Overview")',
      "![Remote](https://example.com/plot.png)",
      "![Encoded](../figures/My%20Plot.png)",
      '<img src="../figures/scaled-dot-product-attention.png" alt="Attention" width={223} />',
      "[Download](figures/plot.png)",
      "```md",
      "![Example](figures/plot.png)",
      "```",
      "<!-- ![Commented](figures/plot.png) -->",
    ].join("\n"));
  });

  it("rebases Markdown images when moving back to the project root", () => {
    expect(rewriteMovedDocumentAssetPaths(
      "![Plot](../figures/plot.png)",
      "chapters/notes.md",
      "notes.md",
      assets,
    )).toBe("![Plot](figures/plot.png)");
  });

  it("keeps project-root LaTeX paths stable and rebases document-relative paths", () => {
    const source = [
      "\\includegraphics{figures/plot.png}",
      "\\includegraphics[width=\\linewidth]{\\detokenize{../figures/Native UMM.svg}}",
      "% \\includegraphics{../figures/plot.png}",
    ].join("\n");

    expect(rewriteMovedDocumentAssetPaths(
      source,
      "chapters/method.tex",
      "chapters/archive/method.tex",
      assets,
    )).toBe([
      "\\includegraphics{figures/plot.png}",
      "\\includegraphics[width=\\linewidth]{\\detokenize{../../figures/Native UMM.svg}}",
      "% \\includegraphics{../figures/plot.png}",
    ].join("\n"));
  });

  it("leaves missing paths and non-document files unchanged", () => {
    expect(rewriteMovedDocumentAssetPaths(
      "![Missing](missing.png)",
      "notes.md",
      "chapters/notes.md",
      assets,
    )).toBe("![Missing](missing.png)");
    expect(rewriteMovedDocumentAssetPaths(
      "![Plot](figures/plot.png)",
      "notes.txt",
      "chapters/notes.txt",
      assets,
    )).toBe("![Plot](figures/plot.png)");
  });
});
