export type TableGeneratorOptions = {
  rows: number;
  cols: number;
  booktabs: boolean;
  float: boolean;
  caption: string;
  label: string;
};

export function clampTableSize(value: number, min = 1, max = 20): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function buildTabularSnippet(options: TableGeneratorOptions): {
  insert: string;
  cursorOffset: number;
} {
  const rows = clampTableSize(options.rows);
  const cols = clampTableSize(options.cols);
  const align = "l".repeat(cols);
  const header = Array.from({ length: cols }, (_, index) => `Col ${index + 1}`).join(" & ");
  const empty = Array.from({ length: cols }, () => " ").join(" & ");
  const bodyRows = Array.from({ length: Math.max(0, rows - 1) }, () => `    ${empty} \\\\`).join("\n");
  const tabular = [
    `  \\begin{tabular}{${align}}`,
    options.booktabs ? "    \\toprule" : "",
    `    ${header} \\\\`,
    options.booktabs ? "    \\midrule" : "    \\hline",
    bodyRows,
    options.booktabs ? "    \\bottomrule" : "",
    "  \\end{tabular}",
  ].filter(Boolean).join("\n");

  if (!options.float) {
    const insert = `${tabular}\n`;
    return { insert, cursorOffset: insert.indexOf("Col 1") };
  }

  const caption = options.caption.trim() || "Caption";
  const label = options.label.trim() || "tab:name";
  const insert = [
    "\\begin{table}[t]",
    "  \\centering",
    `  \\caption{${caption}}`,
    `  \\label{${label}}`,
    tabular,
    "\\end{table}",
    "",
  ].join("\n");
  return { insert, cursorOffset: insert.indexOf(caption) };
}
