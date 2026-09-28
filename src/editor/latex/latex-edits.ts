/** Pure text edits behind the source editor's commands and status bar. */
export type TextEdit = { from: number; to: number; insert: string };
export type SelectionEdit = TextEdit & { cursorFrom: number; cursorTo: number };

const WORD = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g;

export function countWords(text: string): number {
  return text.match(WORD)?.length ?? 0;
}

export type TextStats = { words: number; chars: number; lines: number };

export function textStats(text: string): TextStats {
  if (!text) return { words: 0, chars: 0, lines: 0 };
  return { words: countWords(text), chars: text.length, lines: text.split("\n").length };
}

export function sortSelectedLines(text: string, from: number, to: number): TextEdit | null {
  if (from === to) return null;
  const start = text.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const newline = text.indexOf("\n", to);
  const end = newline === -1 ? text.length : newline;
  const block = text.slice(start, end);
  const lines = block.split("\n");
  if (lines.length < 2) return null;
  const insert = lines.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).join("\n");
  return insert === block ? null : { from: start, to: end, insert };
}

export type CaseMode = "upper" | "lower" | "title";

const CASES: Record<CaseMode, (text: string) => string> = {
  upper: (text) => text.toLocaleUpperCase(),
  lower: (text) => text.toLocaleLowerCase(),
  title: (text) => text.replace(WORD, (word) => word.charAt(0).toLocaleUpperCase() + word.slice(1).toLocaleLowerCase()),
};

export function transformCase(text: string, from: number, to: number, mode: CaseMode): TextEdit | null {
  if (from === to) return null;
  const selected = text.slice(from, to);
  const insert = CASES[mode](selected);
  return insert === selected ? null : { from, to, insert };
}

/**
 * Surround the selection and keep it selected. An empty selection gets
 * `placeholder` between the delimiters and the cursor after it.
 */
export function wrapRange(
  text: string,
  from: number,
  to: number,
  before: string,
  after: string,
  placeholder = "",
): SelectionEdit {
  const selected = text.slice(from, to);
  const inner = selected || placeholder;
  const start = from + before.length;
  return {
    from,
    to,
    insert: `${before}${inner}${after}`,
    cursorFrom: selected ? start : start + inner.length,
    cursorTo: start + inner.length,
  };
}

export function wrapEnvironment(text: string, from: number, to: number, name: string): SelectionEdit {
  const env = name.trim() || "equation";
  return wrapRange(text, from, to, `\\begin{${env}}\n`, `\n\\end{${env}}`, "  ");
}

export type CommentWrapStyle = "comment-env" | "iffalse";

export function wrapCommentRegion(text: string, from: number, to: number, style: CommentWrapStyle): SelectionEdit {
  return style === "comment-env"
    ? wrapEnvironment(text, from, to, "comment")
    : wrapRange(text, from, to, "\\iffalse\n", "\n\\fi", "  ");
}

export function toggleLineComments(text: string, from: number, to: number): SelectionEdit {
  const start = text.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const lineEnd = text.indexOf("\n", to > from ? to - 1 : from);
  const end = lineEnd === -1 ? text.length : lineEnd;
  const lines = text.slice(start, end).split("\n");
  const contentLines = lines.filter((line) => line.trim());
  const uncomment = contentLines.length > 0 && contentLines.every((line) => /^\s*%/.test(line));
  const insert = lines.map((line) => {
    if (!line.trim()) return line;
    if (uncomment) return line.replace(/^(\s*)%\s?/, "$1");
    const indent = line.match(/^\s*/)![0];
    return `${indent}% ${line.slice(indent.length)}`;
  }).join("\n");
  return { from: start, to: end, insert, cursorFrom: start, cursorTo: start + insert.length };
}
