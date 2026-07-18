import { describe, expect, it } from "vitest";
import { latexFigureInsertion } from "./figure-insertion";

describe("LaTeX figure insertion", () => {
  it("creates editable figure blocks with stable labels", () => {
    expect(latexFigureInsertion("before\nafter", 7, ["figures/Native UMM-converted.pdf"])).toBe(
      "\n\\begin{figure}[t]\n  \\centering\n  \\includegraphics[width=\\linewidth]{\\detokenize{figures/Native UMM-converted.pdf}}\n  \\caption{Describe the figure.}\n  \\label{fig:native-umm}\n\\end{figure}\n\n",
    );
  });
});
