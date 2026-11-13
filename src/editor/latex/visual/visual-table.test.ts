import { describe, expect, it } from "vitest";
import { parseTable } from "./visual-table";

const cells = (source: string) => parseTable(source, 0)!.rows.map((row) => row.cells.map((cell) => [cell.text, cell.column, cell.rowspan]));

describe("parseTable", () => {
  it("counts the columns a multirow above covers in each cell's column", () => {
    const table = parseTable(String.raw`\begin{tabular}{lcc}
\multirow{2}{*}{Model} & \multicolumn{2}{c}{Accuracy} \\ \cmidrule{2-3}
 & Val & Test \\
\end{tabular}`, 0)!;
    expect(table.rows[1].cells.map((cell) => [cell.text, cell.column])).toEqual([["Val", 1], ["Test", 2]]);
  });

  // multirow's manual: a negative count spans the rows above, with the text set in their middle.
  it("spans a negative multirow over the rows above it", () => {
    expect(cells(String.raw`\begin{tabular}{lc}
 & 1 \\
\cellcolor{gray} & 2 \\
\multirow{-3}{*}{Group} & 3 \\
After & 4 \\
\end{tabular}`)).toEqual([
      [["Group", 0, 3], ["1", 1, 1]],
      [["2", 1, 1]],
      [["3", 1, 1]],
      [["After", 0, 1], ["4", 1, 1]],
    ]);
  });

  it("sets a negative multirow in its own row when the rows above have no room for it", () => {
    expect(cells(String.raw`\begin{tabular}{lc}
Full & 1 \\
\multirow{-2}{*}{Group} & 2 \\
\end{tabular}`)).toEqual([[["Full", 0, 1], ["1", 1, 1]], [["Group", 0, 1], ["2", 1, 1]]]);
  });
});
