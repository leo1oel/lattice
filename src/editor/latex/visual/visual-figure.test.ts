import { describe, expect, it } from "vitest";
import { figureEntryGraphic, figureEntryLabels } from "./visual-figure";

/** An entry as Reactio Draw writes it: the drawing, its compound marks set over it. */
const REACTIO_ENTRY = String.raw`% editable-figure source: Document_1.reactio
% Made by Reactio Draw: the drawing is Document_1.pdf, its compound numbers are set here with \cmpd (chemnum)
\begingroup
\sbox0{\includegraphics{Document_1.pdf}}%
\edef\rdw{\the\ifdim\wd0>\linewidth\linewidth\else\wd0\fi}%
\providecommand\reactiofigurefont[1]{\fontfamily{#1}\selectfont}%
\begin{tikzpicture}
  \node[inner sep=0pt,anchor=south west] (rdfig) at (0,0) {\includegraphics[width=\rdw,keepaspectratio]{Document_1.pdf}};
  \begin{scope}[x={(rdfig.south east)},y={(rdfig.north west)},every node/.style={inner sep=0pt,anchor=base}]
    \node at (0.1665,0.1119) {\reactiofigurefont{phv}\fontsize{10}{12}\selectfont \textbf{\rcmpd{1}}~(xx\%)};
    \node at (0.5688,0.3996) {\fontsize{8}{10}\selectfont \cmpd{ketone,alcohol.OMe}};
    % \node at (0.9,0.9) {\cmpd{commented}};
  \end{scope}
\end{tikzpicture}%
\endgroup%`;

describe("editable figure entries", () => {
  it("names the graphic the entry draws", () => {
    expect(figureEntryGraphic(REACTIO_ENTRY)).toBe("Document_1.pdf");
    expect(figureEntryGraphic("% \\includegraphics{old.pdf}\n\\includegraphics[width=3cm]{figures/new}")).toBe("figures/new");
    expect(figureEntryGraphic("\\input{other}")).toBeNull();
  });

  it("reads the labels set over the graphic: place, size, bold, compound numbers and text", () => {
    expect(figureEntryLabels(REACTIO_ENTRY)).toEqual([
      { x: 0.1665, y: 0.1119, size: 10, font: "sans", runs: [{ bold: true, compounds: ["1"] }, { bold: false, text: " (xx%)" }] },
      { x: 0.5688, y: 0.3996, size: 8, font: null, runs: [{ bold: false, compounds: ["ketone", "alcohol.OMe"] }] },
    ]);
  });

  it("reads no labels outside a scope spanning the graphic, and none from an unclosed node", () => {
    expect(figureEntryLabels("\\begin{tikzpicture}\\node at (1,2) {\\cmpd{a}};\\end{tikzpicture}")).toEqual([]);
    expect(figureEntryLabels("\\begin{scope}[x={(f.south east)},y={(f.north west)}]\\node at (0.1,0.2) {\\cmpd{a}")).toEqual([]);
  });
});
