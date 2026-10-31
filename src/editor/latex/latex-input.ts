/** Typing helpers for LaTeX source: `\item` lists on Enter, and `\left(` growing its `\right)`. */
import { enclosingEnvironment } from "./latex-environments";

/** An edit to apply, and where the caret lands after it. */
export type InputEdit = { from: number; to: number; insert: string; cursor: number };

/** A line that starts with `\item` (not `\itemsep`), with its indent and optional `[label]`. */
const ITEM_LINE = /^([ \t]*)\\item(?![A-Za-z@])(\[[^\]]*\])?/;

/**
 * Enter on a line that starts with `\item`, after that `\item`, begins the
 * next item at the same indent. On an item with nothing written yet, it
 * leaves the list instead: the empty item goes, and when nothing but blanks
 * stand between it and the list's `\end`, the caret moves to a new line
 * after that `\end`. Any other line gets null, for the plain newline.
 */
export function listItemNewline(text: string, cursor: number): InputEdit | null {
  const lineFrom = text.lastIndexOf("\n", cursor - 1) + 1;
  const newline = text.indexOf("\n", cursor);
  const lineTo = newline === -1 ? text.length : newline;
  const line = text.slice(lineFrom, lineTo);
  const item = ITEM_LINE.exec(line);
  const itemEnd = lineFrom + (item?.[0].length ?? 0);
  if (!item || cursor < itemEnd) return null;
  const indent = item[1];
  if (line.slice(item[0].length).trim() || item[2]?.slice(1, -1).trim()) {
    // Blanks around the caret would trail the old item or lead the new one.
    const from = itemEnd + text.slice(itemEnd, cursor).trimEnd().length;
    const to = cursor + (/^[ \t]*/.exec(text.slice(cursor, lineTo))?.[0].length ?? 0);
    const insert = `\n${indent}\\item `;
    return { from, to, insert, cursor: from + insert.length };
  }
  const list = enclosingEnvironment(text, cursor);
  if (list && !text.slice(lineTo, list.end.from).trim()) {
    const beginLine = text.slice(text.lastIndexOf("\n", list.begin.from - 1) + 1, list.begin.from);
    const insert = `${text.slice(lineTo, list.end.to)}\n${/^[ \t]*/.exec(beginLine)?.[0] ?? ""}`;
    // The empty item's line goes with the newline before it.
    const from = Math.max(0, lineFrom - 1);
    return { from, to: list.end.to, insert, cursor: from + insert.length };
  }
  return { from: lineFrom + indent.length, to: lineTo, insert: "", cursor: lineFrom + indent.length };
}

/** `\left` and the sized `\bigl` family, each with the command that closes it. */
const SIZES: Record<string, string> = {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- LaTeX command names
  left: "right", bigl: "bigr", Bigl: "Bigr", biggl: "biggr", Biggl: "Biggr",
};
const DELIMITERS: Record<string, string> = {
  "(": ")", "[": "]", "\\{": "\\}", "|": "|", "\\|": "\\|", "\\langle": "\\rangle", "\\lvert": "\\rvert",
  "\\lVert": "\\rVert", "\\lfloor": "\\rfloor", "\\lceil": "\\rceil",
};
/** What closeBrackets writes after the caret for an opener's last character. */
const PAIRED: Record<string, string> = { "(": ")", "[": "]", "\\{": "}" };
const OPENED = new RegExp(`\\\\(${Object.keys(SIZES).join("|")})\\s*(${Object.keys(DELIMITERS)
  .map((delimiter) => delimiter.replace(/[\\()[\]{}|]/g, "\\$&")).join("|")})$`);
const CLOSER = new RegExp(`\\\\(?:${Object.values(SIZES).join("|")})(?![A-Za-z])`, "g");
const OPENER = new RegExp(`\\\\(?:${Object.keys(SIZES).join("|")})(?![A-Za-z])`, "g");

/**
 * The `\right)` (or `\bigr]`, …) to write at the caret after a just-typed
 * `\left(` (or `\bigl[`, …), given the caret's line split at the caret; the
 * caret stays between them. The `)`, `]` or `}` that bracket pairing wrote
 * after the caret is replaced, becoming part of the closer. Nothing is
 * written when the line already closes as many sizes as it opens, as when the
 * opener is retyped in front of its partner.
 */
export function sizedDelimiterClose(before: string, after: string): { replace: number; insert: string } | null {
  const match = OPENED.exec(before.slice(-16));
  const line = before + after;
  if (!match || (line.match(CLOSER)?.length ?? 0) >= (line.match(OPENER)?.length ?? 0)) return null;
  const pair = PAIRED[match[2]];
  return { replace: pair && after.startsWith(pair) ? 1 : 0, insert: `\\${SIZES[match[1]]}${DELIMITERS[match[2]]}` };
}
