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
});
