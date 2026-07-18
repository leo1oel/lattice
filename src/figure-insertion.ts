export function latexFigureInsertion(source: string, position: number, paths: string[]): string {
  const blocks = paths.map((path) => {
    const normalized = path.replace(/\\/g, "/");
    const fileName = normalized.split("/").pop() ?? "figure";
    const stem = fileName.replace(/\.[^.]+$/, "").replace(/-converted$/, "");
    const label = stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "figure";
    return [
      "\\begin{figure}[t]",
      "  \\centering",
      `  \\includegraphics[width=\\linewidth]{\\detokenize{${normalized}}}`,
      "  \\caption{Describe the figure.}",
      `  \\label{fig:${label}}`,
      "\\end{figure}",
    ].join("\n");
  }).join("\n\n");
  const before = source.slice(0, position);
  const after = source.slice(position);
  const prefix = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = !after ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return `${prefix}${blocks}${suffix}`;
}
