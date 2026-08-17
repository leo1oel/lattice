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

const MARKDOWN_IMAGE_DESTINATION = /(!\[(?:\\.|[^\]\\\n])*\]\(\s*)(?:<([^>\n]*)>|((?:\\.|[^()\s])+))(?=(?:\s+(?:"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|\((?:\\.|[^)\n])*\)))?\s*\))/g;
const HTML_IMAGE_SOURCE = /(<img\b[^>]*?\s+src\s*=\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'=<>`]+))/gi;
const LATEX_IMAGE_DESTINATION = /(\\includegraphics\*?(?:\s*\[[^\]\n]*\])?\s*\{)(?:\\detokenize\{([^{}]*)\}|([^{}]*))(\})/g;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

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

function normalizeAssetReference(fromFile: string, rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath).replace(/\\/g, "/");
  } catch {
    return null;
  }
  if (!decoded || decoded.startsWith("/") || decoded.startsWith("//") || URI_SCHEME.test(decoded)) {
    return null;
  }
  const parts = fromFile.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/") || null;
}

function referencedAsset(
  fromFile: string,
  rawDestination: string,
  assetPaths: ReadonlySet<string>,
  extensionless: boolean,
): { path: string; suffix: string; extensionless: boolean } | null {
  const suffixStart = rawDestination.search(/[?#]/);
  const rawPath = suffixStart < 0 ? rawDestination : rawDestination.slice(0, suffixStart);
  const suffix = suffixStart < 0 ? "" : rawDestination.slice(suffixStart);
  const normalized = normalizeAssetReference(fromFile, rawPath);
  if (!normalized) return null;
  if (assetPaths.has(normalized)) return { path: normalized, suffix, extensionless: false };
  if (!extensionless || /\.[^/]+$/.test(normalized)) return null;
  const matches = [...assetPaths].filter((path) => path.replace(/\.[^/.]+$/, "") === normalized);
  return matches.length === 1 ? { path: matches[0], suffix, extensionless: true } : null;
}

function rewrittenAssetDestination(
  previousPath: string,
  nextPath: string,
  rawDestination: string,
  assetPaths: ReadonlySet<string>,
  options: { extensionless?: boolean; projectRootRelative?: boolean } = {},
): string | null {
  const reference = referencedAsset(
    previousPath,
    rawDestination,
    assetPaths,
    options.extensionless ?? false,
  );
  if (!reference) return null;
  if (options.projectRootRelative) {
    // Lattice runs latexmk from the project root. A path which already names
    // an asset from there is independent of the .tex file's own directory and
    // must stay unchanged when that file moves.
    const rootReference = referencedAsset(
      "root.tex",
      rawDestination,
      assetPaths,
      options.extensionless ?? false,
    );
    if (rootReference) return null;
  }
  const target = reference.extensionless
    ? reference.path.replace(/\.[^/.]+$/, "")
    : reference.path;
  const rewritten = projectRelativePath(nextPath, target);
  return `${rewritten}${reference.suffix}` === rawDestination
    ? null
    : `${rewritten}${reference.suffix}`;
}

function latexCommandIsCommented(source: string, position: number): boolean {
  const lineStart = source.lastIndexOf("\n", position - 1) + 1;
  for (let index = lineStart; index < position; index += 1) {
    if (source[index] !== "%") continue;
    let escapes = 0;
    for (let cursor = index - 1; cursor >= lineStart && source[cursor] === "\\"; cursor -= 1) {
      escapes += 1;
    }
    if (escapes % 2 === 0) return true;
  }
  return false;
}

function markdownProtectedRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of source.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  let fence: { character: string; length: number; start: number } | null = null;
  let lineStart = 0;
  while (lineStart < source.length) {
    const newline = source.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? source.length : newline + 1;
    const line = source.slice(lineStart, newline < 0 ? source.length : newline);
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (!fence && marker) {
      fence = { character: marker[0], length: marker.length, start: lineStart };
    } else if (
      fence
      && marker?.[0] === fence.character
      && marker.length >= fence.length
      && line.slice(line.indexOf(marker) + marker.length).trim() === ""
    ) {
      ranges.push([fence.start, lineEnd]);
      fence = null;
    }
    lineStart = lineEnd;
  }
  if (fence) ranges.push([fence.start, source.length]);
  return ranges;
}

/**
 * Keep image references pointing at the same project assets after a source
 * document moves. Markdown destinations are document-relative. LaTeX paths
 * that already resolve from the project root stay byte-identical because that
 * is latexmk's working directory; only explicitly document-relative paths are
 * rebased.
 */
export function rewriteMovedDocumentAssetPaths(
  source: string,
  previousPath: string,
  nextPath: string,
  assetPaths: ReadonlySet<string>,
): string {
  const previousDirectory = previousPath.includes("/")
    ? previousPath.slice(0, previousPath.lastIndexOf("/"))
    : "";
  const nextDirectory = nextPath.includes("/")
    ? nextPath.slice(0, nextPath.lastIndexOf("/"))
    : "";
  if (previousPath === nextPath || previousDirectory === nextDirectory) {
    return source;
  }
  if (/\.md$/i.test(previousPath)) {
    MARKDOWN_IMAGE_DESTINATION.lastIndex = 0;
    let protectedRanges = markdownProtectedRanges(source);
    const rewrittenSource = source.replace(
      MARKDOWN_IMAGE_DESTINATION,
      (match, prefix: string, angledPath: string | undefined, barePath: string | undefined, offset: number) => {
        if (protectedRanges.some(([start, end]) => offset >= start && offset < end)) return match;
        const destination = angledPath ?? barePath;
        if (!destination) return match;
        const rewritten = rewrittenAssetDestination(
          previousPath,
          nextPath,
          destination,
          assetPaths,
        );
        if (!rewritten) return match;
        return `${prefix}${angledPath === undefined ? rewritten.replaceAll(" ", "%20") : `<${rewritten}>`}`;
      },
    );
    HTML_IMAGE_SOURCE.lastIndex = 0;
    protectedRanges = markdownProtectedRanges(rewrittenSource);
    return rewrittenSource.replace(
      HTML_IMAGE_SOURCE,
      (
        match,
        prefix: string,
        doubleQuotedPath: string | undefined,
        singleQuotedPath: string | undefined,
        unquotedPath: string | undefined,
        offset: number,
      ) => {
        if (protectedRanges.some(([start, end]) => offset >= start && offset < end)) return match;
        const destination = doubleQuotedPath ?? singleQuotedPath ?? unquotedPath;
        if (!destination) return match;
        const rewritten = rewrittenAssetDestination(
          previousPath,
          nextPath,
          destination,
          assetPaths,
        );
        if (!rewritten) return match;
        if (doubleQuotedPath !== undefined) return `${prefix}"${rewritten}"`;
        if (singleQuotedPath !== undefined) return `${prefix}'${rewritten}'`;
        return `${prefix}${rewritten.replaceAll(" ", "%20")}`;
      },
    );
  }
  if (/\.tex$/i.test(previousPath)) {
    LATEX_IMAGE_DESTINATION.lastIndex = 0;
    return source.replace(
      LATEX_IMAGE_DESTINATION,
      (match, prefix: string, detokenizedPath: string | undefined, plainPath: string | undefined, closing: string, offset: number) => {
        if (latexCommandIsCommented(source, offset)) return match;
        const destination = detokenizedPath ?? plainPath;
        if (!destination) return match;
        const rewritten = rewrittenAssetDestination(
          previousPath,
          nextPath,
          destination.trim(),
          assetPaths,
          { extensionless: true, projectRootRelative: true },
        );
        if (!rewritten) return match;
        const body = detokenizedPath === undefined ? rewritten : `\\detokenize{${rewritten}}`;
        return `${prefix}${body}${closing}`;
      },
    );
  }
  return source;
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
