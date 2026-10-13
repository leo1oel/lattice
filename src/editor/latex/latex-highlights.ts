/**
 * Highlights in LaTeX source: the `\colorbox[HTML]{FFF1A6}{…}` the selection
 * toolbar writes, a `\colorbox{yellow}{…}` typed by hand, and soul's `\hl{…}`
 * (coloured by `\sethlcolor`, which this does not follow). Pure text, so the
 * toolbar, its Remove and the Annotations panel read highlights the same way.
 */
import type { TextEdit } from "./latex-edits";

export type LatexHighlight = {
  /** The command's backslash. */
  from: number;
  /** Just past the closing brace. */
  to: number;
  /** The highlighted text, inside the last pair of braces. */
  contentFrom: number;
  contentTo: number;
  /** `#RRGGBB` for an HTML colour, a colour name as written, or null for `\hl`. */
  color: string | null;
};

const START = /\\(?:colorbox|hl)(?![A-Za-z@])/g;
const COMMAND = /^\\(?:colorbox|hl)(?![A-Za-z@])/;

/** Just past the brace that closes the group opened at `open`, or -1 when it never closes. */
function groupEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return index + 1;
  }
  return -1;
}

function skipSpace(text: string, index: number): number {
  while (text[index] === " " || text[index] === "\t") index += 1;
  return index;
}

/** The highlight whose command starts at `from`, or null when the text there is not one. */
function highlightFrom(text: string, from: number): LatexHighlight | null {
  // `\\colorbox` is a line break followed by the word: an even run of
  // backslashes in front means this one is escaped.
  let slashes = 0;
  while (text[from - 1 - slashes] === "\\") slashes += 1;
  if (slashes % 2) return null;
  const isBox = text.startsWith("\\colorbox", from);
  let index = skipSpace(text, from + (isBox ? 9 : 3));
  let color: string | null = null;
  if (isBox) {
    let model = "";
    if (text[index] === "[") {
      const close = text.indexOf("]", index);
      if (close < 0) return null;
      model = text.slice(index + 1, close).trim();
      index = skipSpace(text, close + 1);
    }
    if (text[index] !== "{") return null;
    const specEnd = groupEnd(text, index);
    if (specEnd < 0) return null;
    const spec = text.slice(index + 1, specEnd - 1).trim();
    color = /^html$/i.test(model) && /^[0-9a-f]{6}$/i.test(spec) ? `#${spec.toUpperCase()}` : spec;
    index = skipSpace(text, specEnd);
  }
  if (text[index] !== "{") return null;
  const to = groupEnd(text, index);
  if (to < 0) return null;
  return { from, to, contentFrom: index + 1, contentTo: to - 1, color };
}

/** Every highlight in `text`, in order; a highlight nested in another follows it. */
export function latexHighlights(text: string): LatexHighlight[] {
  const found: LatexHighlight[] = [];
  START.lastIndex = 0;
  for (let match = START.exec(text); match; match = START.exec(text)) {
    const highlight = highlightFrom(text, match.index);
    if (highlight) found.push(highlight);
  }
  return found;
}

/** How far from a selection a highlight's ends may lie (a highlighted paragraph, not a chapter). */
const REACH = 4000;

/** A document as CodeMirror's `Text` reads it, so a selection need not copy the whole file. */
type Doc = { length: number; sliceString: (from: number, to?: number) => string };

/**
 * The innermost highlight around `[from, to)`: one whose text holds the
 * selection, or whose command the selection covers exactly. It reads only
 * the text near the selection, so it is cheap enough for every selection change.
 */
export function highlightAround(doc: Doc, from: number, to: number): LatexHighlight | null {
  const offset = Math.max(0, from - REACH);
  const text = doc.sliceString(offset, Math.min(doc.length, to + REACH));
  const start = from - offset;
  const end = to - offset;
  for (let at = start; at >= 0;) {
    const candidate = Math.max(text.lastIndexOf("\\colorbox", at), text.lastIndexOf("\\hl", at));
    if (candidate < 0) return null;
    // `\hline` and its like start the same way.
    const found = COMMAND.test(text.slice(candidate, candidate + 10)) ? highlightFrom(text, candidate) : null;
    if (found && ((found.contentFrom <= start && end <= found.contentTo) || (found.from === start && found.to === end))) {
      return {
        from: found.from + offset, to: found.to + offset,
        contentFrom: found.contentFrom + offset, contentTo: found.contentTo + offset,
        color: found.color,
      };
    }
    at = candidate - 1;
  }
  return null;
}

/** The command that opens a highlight of `color` (`#RRGGBB`, or a colour name). */
export function highlightOpening(color: string): string {
  const hex = color.trim().match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  return hex ? `\\colorbox[HTML]{${hex[1]!.toUpperCase()}}{` : `\\colorbox{${color.trim() || "yellow"}}{`;
}

/** Take the highlight off, leaving its text where it was. */
export function removeHighlight(highlight: LatexHighlight): TextEdit[] {
  return [
    { from: highlight.from, to: highlight.contentFrom, insert: "" },
    { from: highlight.contentTo, to: highlight.to, insert: "" },
  ];
}

/** Give the highlight another colour, its text untouched. */
export function recolorHighlight(highlight: LatexHighlight, color: string): TextEdit {
  return { from: highlight.from, to: highlight.contentFrom, insert: highlightOpening(color) };
}
