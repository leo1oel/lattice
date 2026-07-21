import { describe, expect, it } from "vitest";
import { latexFigureInsertion } from "./figure-insertion";

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
