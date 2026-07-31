export type LatexFigureEdit = {
  text: string;
  cursorOffset: number;
};

export type MarkdownAssetEdit = LatexFigureEdit;

export type FigureInsertOptions = {
  width: string;
  placement: string;
  caption: string;
  label?: string;
};

export const DEFAULT_FIGURE_OPTIONS: FigureInsertOptions = {
  width: "\\linewidth",
  placement: "t",
  caption: "Describe the figure.",
};

function figureLabelFromPath(path: string): string {
  const fileName = path.split("/").pop() ?? "figure";
  const stem = fileName.replace(/\.[^.]+$/, "").replace(/-converted$/, "");
  return stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "figure";
}

export function latexFigureInsertion(
  source: string,
  position: number,
  paths: string[],
  options: FigureInsertOptions = DEFAULT_FIGURE_OPTIONS,
): LatexFigureEdit {
  const width = options.width.trim() || "\\linewidth";
  const placement = options.placement.trim() || "t";
  const caption = options.caption.trim() || "Describe the figure.";
  const blocks = paths.map((path, index) => {
    const normalized = path.replace(/\\/g, "/");
    const base = options.label?.trim() || `fig:${figureLabelFromPath(normalized)}`;
    const resolvedLabel = paths.length > 1 && index > 0 ? `${base}-${index + 1}` : base;
    return [
      `\\begin{figure}[${placement}]`,
      "  \\centering",
      `  \\includegraphics[width=${width}]{\\detokenize{${normalized}}}`,
      `  \\caption{${caption}}`,
      `  \\label{${resolvedLabel}}`,
      "\\end{figure}",
    ].join("\n");
  }).join("\n\n");
  const before = source.slice(0, position);
  const after = source.slice(position);
  const prefix = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = !after ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const text = `${prefix}${blocks}${suffix}`;
  return {
    text,
    cursorOffset: text.indexOf(caption) + caption.length,
  };
}

function projectRelativePath(fromFile: string, targetPath: string): string {
  const from = fromFile.replace(/\\/g, "/").split("/").filter(Boolean);
  const target = targetPath.replace(/\\/g, "/").split("/").filter(Boolean);
  from.pop();
  while (from.length && target.length && from[0] === target[0]) {
    from.shift();
    target.shift();
  }
  return [...from.map(() => ".."), ...target].join("/") || ".";
}

function markdownLabel(path: string): string {
  const fileName = path.split("/").pop() ?? "asset";
  return fileName
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .trim() || "asset";
}

export function markdownAssetInsertion(
  source: string,
  position: number,
  paths: string[],
  markdownPath: string,
): MarkdownAssetEdit {
  const imageExtensions = new Set(["png", "jpg", "jpeg", "svg", "webp"]);
  const blocks = paths.map((path) => {
    const normalized = path.replace(/\\/g, "/");
    const fileName = normalized.split("/").pop() ?? "asset";
    const extension = fileName.split(".").pop()?.toLocaleLowerCase() ?? "";
    const destination = projectRelativePath(markdownPath, normalized);
    return imageExtensions.has(extension)
      ? `![${markdownLabel(normalized)}](<${destination}>)`
      : `[${fileName}](<${destination}>)`;
  }).join("\n\n");
  const before = source.slice(0, position);
  const after = source.slice(position);
  const prefix = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = !after ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const text = `${prefix}${blocks}${suffix}`;
  return {
    text,
    cursorOffset: text.length,
  };
}
