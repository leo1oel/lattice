/**
 * Where citations, references, labels, and includes sit in LaTeX source: the
 * completion slot before the cursor, the key under a pointer, and the project
 * file an argument names.
 */
import {
  LABEL, findProjectPath, findProjectPathIgnoringCase, foldCase, type DefinitionTarget, type ReferenceInfo, type SymbolTarget,
} from "./latex-text";

/* eslint-disable lingui/no-unlocalized-strings -- regular-expression alternations of LaTeX command names */
const CITATION_COMMANDS = "cite|citep|citet|citealp|citealt|citeauthor|parencite|textcite|autocite|footcite";
const REFERENCE_COMMANDS = "ref|eqref|pageref|autoref|cref|Cref";
/* eslint-enable lingui/no-unlocalized-strings */
const OPEN_CITATION = new RegExp(`\\\\(?:${CITATION_COMMANDS})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^}]*)$`);
const OPEN_REFERENCE = new RegExp(`\\\\(?:${REFERENCE_COMMANDS})\\*?\\{([^}]*)$`);
const OPEN_INCLUDE = /\\(?:includegraphics|include|input)(?:\[[^\]]*\])?\{([^}]*)$/;
const BRACED_COMMANDS = new RegExp(`\\\\(?:${CITATION_COMMANDS}|${REFERENCE_COMMANDS}|label|input|include)$`);
export const CITATION = new RegExp(`\\\\(?:${CITATION_COMMANDS})\\*?(?:\\[[^\\]]*\\]){0,2}\\{([^}]*)\\}`, "g");
export const REFERENCE = new RegExp(`\\\\(?:${REFERENCE_COMMANDS})\\*?\\{([^}]*)\\}`, "g");
export const INCLUDE = /\\(?:input|include)\{([^}]*)\}/g;
export const GRAPHICS = /\\includegraphics(?:\[[^\]]*\])?\{((?:\\detokenize\{[^}]*\}|[^}]+))\}/g;
const GRAPHICS_EXTENSIONS = ["", ".pdf", ".png", ".jpg", ".jpeg", ".svg", ".eps", ".webp"];

export type KeySpan = { from: number; to: number; key: string };

/** Whether the text before the cursor ends in a command whose argument braces are inserted for you. */
export function shouldInsertCommandBraces(textBeforeCursor: string): boolean {
  return BRACED_COMMANDS.test(textBeforeCursor);
}

/** Each match of `pattern` (whose group 1 is the final braced argument), in document offsets. */
export function argumentsOf(text: string, pattern: RegExp, offset = 0) {
  return [...text.matchAll(pattern)].map((match) => {
    const end = offset + match.index + match[0].length;
    return { start: offset + match.index, end, from: end - 1 - match[1].length, content: match[1] };
  });
}

/** The trimmed, non-empty comma-separated keys of an argument starting at `from`. */
export function keySpans(content: string, from: number): KeySpan[] {
  return [...content.matchAll(/[^,]+/g)].flatMap((match) => {
    const key = match[0].trim();
    const start = from + match.index + match[0].length - match[0].trimStart().length;
    return key ? [{ from: start, to: start + key.length, key }] : [];
  });
}

function completionRange(pattern: RegExp, before: string, cursor: number, lastKey: boolean) {
  const content = pattern.exec(before)?.[1];
  if (content == null) return null;
  const query = lastKey ? content.slice(content.lastIndexOf(",") + 1).trimStart() : content;
  return { from: cursor - query.length, query };
}

export const citationCompletionRange = (before: string, cursor: number) =>
  completionRange(OPEN_CITATION, before, cursor, true);
export const referenceCompletionRange = (before: string, cursor: number) =>
  completionRange(OPEN_REFERENCE, before, cursor, true);
export const includeCompletionRange = (before: string, cursor: number) =>
  completionRange(OPEN_INCLUDE, before, cursor, false);

/** The comma-separated key under `position` inside a citation or reference command. */
function keyAt(text: string, pattern: RegExp, position: number): KeySpan | null {
  const offset = Math.max(0, position - 800);
  for (const command of argumentsOf(text.slice(offset, position + 800), pattern, offset)) {
    if (position < command.start || position > command.end) continue;
    const hovered = keySpans(command.content, command.from).find((key) => position >= key.from && position <= key.to);
    if (hovered) return hovered;
  }
  return null;
}

export const citationHoverTarget = (text: string, position: number) => keyAt(text, CITATION, position);
export const referenceHoverTarget = (text: string, position: number) => keyAt(text, REFERENCE, position);

/** The `\includegraphics` path under `position`, as written, with its span. */
export function graphicsHoverTarget(text: string, position: number): { from: number; to: number; path: string } | null {
  const offset = Math.max(0, position - 800);
  for (const { from, content } of argumentsOf(text.slice(offset, position + 800), GRAPHICS, offset)) {
    const path = unwrapLatexPath(content);
    if (path && position >= from && position <= from + content.length) return { from, to: from + content.length, path };
  }
  return null;
}

/** A whole-argument target (label, include, or figure path) under `position`. */
function argumentAt(text: string, pattern: RegExp, position: number, read: (raw: string) => string) {
  for (const { from, content } of argumentsOf(text, pattern)) {
    const value = read(content);
    if (value && position >= from && position <= from + content.length) return value;
  }
  return null;
}

const trim = (raw: string) => raw.trim();

export function unwrapLatexPath(raw: string): string {
  const trimmed = raw.trim();
  const detokenized = trimmed.match(/^\\detokenize\{([^}]*)\}?$/);
  return (detokenized ? detokenized[1] : trimmed).trim().replace(/\\/g, "/");
}

/**
 * The project paths an unwrapped argument may name, in the order they are
 * tried: the path as written or with the extension TeX or graphicx adds, a
 * figure under each `\graphicspath` root too.
 */
function pathCandidates(path: string, kind: "tex" | "graphics", graphicsRoots: string[]) {
  if (kind === "tex") {
    return (path.endsWith(".tex") ? [""] : ["", ".tex"]).map((extension) => ({ candidate: `${path}${extension}`, extension }));
  }
  const extensions = path.includes(".") ? [""] : GRAPHICS_EXTENSIONS;
  return ["", ...graphicsRoots.map((root) => `${root}/`)].flatMap((prefix) => extensions.map((extension) => ({
    candidate: `${prefix}${path}${extension}`.replace(/\/+/g, "/"),
    extension,
  })));
}

/** A URL resolves to itself; anything else must name a project file. */
export function resolveProjectPath(
  raw: string,
  projectPaths: string[],
  kind: "tex" | "graphics",
  graphicsRoots: string[] = [],
): string | null {
  const path = unwrapLatexPath(raw);
  if (!path || /^https?:/.test(path)) return path || null;
  for (const { candidate } of pathCandidates(path, kind, graphicsRoots)) {
    const found = findProjectPath(candidate, projectPaths);
    if (found) return found;
  }
  return null;
}

/**
 * The project file an argument names only when letter case is ignored, and
 * the argument's path respelled in that file's case. macOS's disk ignores
 * case, so the build here finds the file; TeX on Linux (Overleaf, arXiv) does
 * not when a folder's case differs. `path` is null when the respelling has
 * no place in the argument (a doubled `/` the lookup collapsed).
 */
export function miscasedProjectPath(
  raw: string,
  projectPaths: string[],
  kind: "tex" | "graphics",
  graphicsRoots: string[] = [],
): { file: string; path: string | null } | null {
  const path = unwrapLatexPath(raw);
  if (!path || /^https?:/.test(path)) return null;
  for (const { candidate, extension } of pathCandidates(path, kind, graphicsRoots)) {
    const file = findProjectPathIgnoringCase(candidate, projectPaths);
    if (!file) continue;
    // The file ends with the candidate, folded, and folding keeps lengths,
    // so the written path sits just before the extension the lookup added.
    const end = file.length - extension.length;
    const respelled = file.slice(end - path.length, end);
    return { file, path: respelled !== path && foldCase(respelled) === foldCase(path) ? respelled : null };
  }
  return null;
}

export function symbolAt(text: string, position: number): SymbolTarget | null {
  const label = argumentAt(text, LABEL, position, trim) ?? referenceHoverTarget(text, position)?.key;
  if (label) return { kind: "label", label };
  const citation = citationHoverTarget(text, position);
  return citation ? { kind: "citation", key: citation.key } : null;
}

export function definitionTargetAt(
  text: string,
  position: number,
  references: ReferenceInfo[],
  projectPaths: string[] = [],
  graphicsRoots: string[] = [],
): DefinitionTarget | null {
  const label = referenceHoverTarget(text, position)?.key ?? argumentAt(text, LABEL, position, trim);
  const reference = label && references.find((item) => item.label === label);
  if (reference) return { kind: "reference", path: reference.path, line: reference.line, label: reference.label };
  const citation = citationHoverTarget(text, position);
  if (citation) return { kind: "citation", key: citation.key };
  const figure = argumentAt(text, GRAPHICS, position, unwrapLatexPath);
  if (figure) return { kind: "asset", path: resolveProjectPath(figure, projectPaths, "graphics", graphicsRoots) ?? figure };
  const include = argumentAt(text, INCLUDE, position, trim);
  if (!include) return null;
  return { kind: "include", path: resolveProjectPath(include, projectPaths, "tex") ?? (include.endsWith(".tex") ? include : `${include}.tex`) };
}
