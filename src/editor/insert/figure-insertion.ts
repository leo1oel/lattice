type InsertionEdit = {
  text: string;
  cursorOffset: number;
};

export type FigureInsertOptions = {
  width: string;
  placement: string;
  caption: string;
  label?: string;
};

export const DEFAULT_FIGURE_OPTIONS: FigureInsertOptions = {
  width: "\\linewidth",
  placement: "t",
  // eslint-disable-next-line lingui/no-unlocalized-strings -- placeholder caption written into the LaTeX source
  caption: "Describe the figure.",
};

const MARKDOWN_IMAGE_DESTINATION = /(!\[(?:\\.|[^\]\\\n])*\]\(\s*)(?:<([^>\n]*)>|((?:\\.|[^()\s])+))(?=(?:\s+(?:"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|\((?:\\.|[^)\n])*\)))?\s*\))/g;
const HTML_IMAGE_SOURCE = /(<img\b[^>]*?\s+src\s*=\s*)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s"'=<>`]+))/gi;
const LATEX_IMAGE_DESTINATION = /(\\includegraphics\*?(?:\s*\[[^\]\n]*\])?\s*\{)(?:\\detokenize\{([^{}]*)\}|([^{}]*))(?=\})/g;
const URI_SCHEME = /^[a-z][a-z\d+.-]*:/i;

const directoryOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));
const withoutExtension = (path: string) => path.replace(/\.[^/.]+$/, "");
const escapeSpaces = (path: string) => path.replaceAll(" ", "%20");

/** Separate inserted blocks from their neighbors by exactly one blank line. */
function blockInsertionText(source: string, position: number, blocks: string): string {
  const before = source.slice(0, position);
  const after = source.slice(position);
  const prefix = !before || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const suffix = !after ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  return `${prefix}${blocks}${suffix}`;
}

function figureLabelFromPath(path: string): string {
  const stem = (path.split("/").pop() ?? "figure").replace(/\.[^.]+$/, "").replace(/-converted$/, "");
  return stem.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "figure";
}

export function latexFigureInsertion(
  source: string,
  position: number,
  paths: string[],
  options: FigureInsertOptions = DEFAULT_FIGURE_OPTIONS,
): InsertionEdit {
  const width = options.width.trim() || "\\linewidth";
  const placement = options.placement.trim() || "t";
  const caption = options.caption.trim() || DEFAULT_FIGURE_OPTIONS.caption;
  const blocks = paths.map((path, index) => {
    const normalized = path.replace(/\\/g, "/");
    const base = options.label?.trim() || `fig:${figureLabelFromPath(normalized)}`;
    return [
      `\\begin{figure}[${placement}]`,
      "  \\centering",
      `  \\includegraphics[width=${width}]{\\detokenize{${normalized}}}`,
      `  \\caption{${caption}}`,
      `  \\label{${index > 0 ? `${base}-${index + 1}` : base}}`,
      "\\end{figure}",
    ].join("\n");
  }).join("\n\n");
  const text = blockInsertionText(source, position, blocks);
  return { text, cursorOffset: text.indexOf(caption) + caption.length };
}

const MARKDOWN_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "svg", "webp"]);

export function markdownAssetInsertion(
  source: string,
  position: number,
  paths: string[],
  markdownPath: string,
): InsertionEdit {
  const blocks = paths.map((path) => {
    const normalized = path.replace(/\\/g, "/");
    const fileName = normalized.split("/").pop() ?? "asset";
    const destination = projectRelativePath(markdownPath, normalized);
    if (!MARKDOWN_IMAGE_EXTENSIONS.has(fileName.split(".").pop()?.toLocaleLowerCase() ?? "")) {
      return `[${fileName}](<${destination}>)`;
    }
    const label = fileName.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim() || "asset";
    return `![${label}](<${destination}>)`;
  }).join("\n\n");
  const text = blockInsertionText(source, position, blocks);
  return { text, cursorOffset: text.length };
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
  if (!decoded || decoded.startsWith("/") || URI_SCHEME.test(decoded)) return null;
  const parts = fromFile.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (!parts.pop()) return null;
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
  const matches = [...assetPaths].filter((path) => withoutExtension(path) === normalized);
  return matches.length === 1 ? { path: matches[0], suffix, extensionless: true } : null;
}

function rewrittenAssetDestination(
  previousPath: string,
  nextPath: string,
  rawDestination: string,
  assetPaths: ReadonlySet<string>,
  latex = false,
): string | null {
  const reference = referencedAsset(previousPath, rawDestination, assetPaths, latex);
  if (!reference) return null;
  // Lattice runs latexmk from the project root. A LaTeX path which already
  // names an asset from there is independent of the .tex file's own directory
  // and must stay unchanged when that file moves.
  if (latex && referencedAsset("root.tex", rawDestination, assetPaths, true)) return null;
  const target = reference.extensionless ? withoutExtension(reference.path) : reference.path;
  const rewritten = `${projectRelativePath(nextPath, target)}${reference.suffix}`;
  return rewritten === rawDestination ? null : rewritten;
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

/** Whether `offset` sits inside an HTML comment or a fenced code block. */
function markdownProtection(source: string): (offset: number) => boolean {
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
  return (offset) => ranges.some(([start, end]) => offset >= start && offset < end);
}

/**
 * Rewrite every destination `pattern` captures. The pattern captures a prefix
 * and then one alternative group per destination syntax; `formats[i]` puts a
 * rewritten path back into alternative `i`'s syntax.
 */
function rewriteDestinations(
  source: string,
  pattern: RegExp,
  formats: Array<(path: string) => string>,
  skip: (offset: number) => boolean,
  rewrite: (destination: string) => string | null,
): string {
  return source.replace(pattern, (match: string, prefix: string, ...rest: unknown[]) => {
    const alternative = rest.slice(0, formats.length).findIndex((group) => group !== undefined);
    if (alternative < 0 || skip(rest[formats.length] as number)) return match;
    const rewritten = rewrite(rest[alternative] as string);
    return rewritten ? prefix + formats[alternative](rewritten) : match;
  });
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
  if (directoryOf(previousPath) === directoryOf(nextPath)) return source;
  const rewrite = (destination: string) =>
    rewrittenAssetDestination(previousPath, nextPath, destination, assetPaths);
  if (/\.md$/i.test(previousPath)) {
    const markdown = rewriteDestinations(
      source,
      MARKDOWN_IMAGE_DESTINATION,
      [(path) => `<${path}>`, escapeSpaces],
      markdownProtection(source),
      rewrite,
    );
    return rewriteDestinations(
      markdown,
      HTML_IMAGE_SOURCE,
      [(path) => `"${path}"`, (path) => `'${path}'`, escapeSpaces],
      markdownProtection(markdown),
      rewrite,
    );
  }
  if (/\.tex$/i.test(previousPath)) {
    return rewriteDestinations(
      source,
      LATEX_IMAGE_DESTINATION,
      [(path) => `\\detokenize{${path}}`, (path) => path],
      (offset) => latexCommandIsCommented(source, offset),
      (destination) => rewrittenAssetDestination(previousPath, nextPath, destination.trim(), assetPaths, true),
    );
  }
  return source;
}
