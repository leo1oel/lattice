import type { Diagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";
import { msg } from "@lingui/core/macro";
import { i18n } from "../../i18n";

export type MathRegion = {
  from: number;
  to: number;
  source: string;
  display: boolean;
  open: string;
  close: string;
};

type Delimiter = [open: string, close: string, display: boolean];

// eslint-disable-next-line lingui/no-unlocalized-strings -- LaTeX environment names
const ENVIRONMENTS = ["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*"];

/** Search order matters: `$$` before `$`, and every other form before a bare `$`. */
const DELIMITERS: Delimiter[] = [
  ["$$", "$$", true],
  ["\\[", "\\]", true],
  ["\\(", "\\)", false],
  ...ENVIRONMENTS.map((name): Delimiter => [`\\begin{${name}}`, `\\end{${name}}`, true]),
  ["$", "$", false],
];

function findDelimited(text: string, position: number, [open, close, display]: Delimiter): MathRegion | null {
  // Regions come in document order, so none past the caret can contain it.
  for (let start = text.indexOf(open); start >= 0 && start <= position;) {
    const end = text.indexOf(close, start + open.length);
    if (end < 0) return null;
    if (position <= end + close.length) {
      return { from: start, to: end + close.length, source: text.slice(start + open.length, end).trim(), display, open, close };
    }
    start = text.indexOf(open, end + close.length);
  }
  return null;
}

/** True when `text[from, to)` holds only spaces and tabs (and a CR). */
function blank(text: string, from: number, to: number): boolean {
  for (let index = from; index < to; index += 1) {
    const code = text.charCodeAt(index);
    if (code !== 32 && code !== 9 && code !== 13) return false;
  }
  return true;
}

/**
 * The paragraph around `position`: the lines between the nearest blank lines.
 * A blank line ends a paragraph, and TeX refuses one inside math, so no math
 * region crosses it. Searching only here keeps the caret's math lookup
 * O(paragraph) in a long document: it runs on every caret move and keystroke.
 */
function paragraphAround(text: string, position: number): [number, number] {
  let from = position > 0 ? text.lastIndexOf("\n", position - 1) + 1 : 0;
  let to = text.indexOf("\n", position);
  if (to < 0) to = text.length;
  if (blank(text, from, to)) return [from, to];
  while (from > 0) {
    const previous = text.lastIndexOf("\n", from - 2) + 1;
    if (blank(text, previous, from - 1)) break;
    from = previous;
  }
  while (to < text.length) {
    let next = text.indexOf("\n", to + 1);
    if (next < 0) next = text.length;
    if (blank(text, to + 1, next)) break;
    to = next;
  }
  return [from, to];
}

export function mathRegionAt(text: string, position: number): MathRegion | null {
  const clamped = Math.max(0, Math.min(position, text.length));
  const [from, to] = paragraphAround(text, clamped);
  const paragraph = text.slice(from, to);
  for (const delimiter of DELIMITERS) {
    const region = findDelimited(paragraph, clamped - from, delimiter);
    if (region) return { ...region, from: region.from + from, to: region.to + from };
  }
  return null;
}

/** `mathRegionAt` in an editor document, without joining the whole document into one string. */
export function mathRegionInDocument(doc: Text, position: number): MathRegion | null {
  let first = doc.lineAt(position);
  let last = first;
  if (!blank(first.text, 0, first.length)) {
    while (first.number > 1) {
      const previous = doc.line(first.number - 1);
      if (blank(previous.text, 0, previous.length)) break;
      first = previous;
    }
    while (last.number < doc.lines) {
      const next = doc.line(last.number + 1);
      if (blank(next.text, 0, next.length)) break;
      last = next;
    }
  }
  const region = mathRegionAt(doc.sliceString(first.from, last.to), position - first.from);
  return region && { ...region, from: region.from + first.from, to: region.to + first.from };
}

/** Jump between the opening and closing delimiters of the math region under the cursor. */
export function matchingMathDelimiter(text: string, position: number): { from: number; to: number } | null {
  const region = mathRegionAt(text, position);
  if (!region) return null;
  const open = { from: region.from, to: region.from + region.open.length };
  return position >= open.from && position < open.to
    ? { from: region.to - region.close.length, to: region.to }
    : open;
}

/** Flag unclosed $, $$, \\(, \\[ delimiters. Math environments are handled by structure lint. */
export function unclosedMathDiagnostics(text: string): Diagnostic[] {
  return DELIMITERS.filter(([open]) => !open.startsWith("\\begin")).flatMap(([open, close, display]): Diagnostic[] => {
    for (let start = text.indexOf(open); start >= 0;) {
      // Avoid matching single $ inside $$ when scanning for $.
      if (open === "$" && text.startsWith("$$", start)) {
        start = text.indexOf(open, start + 2);
        continue;
      }
      const end = text.indexOf(close, start + open.length);
      if (end < 0) {
        const message = display ? i18n._(msg`Unclosed display math ${open}.`) : i18n._(msg`Unclosed inline math ${open}.`);
        return [{ from: start, to: start + open.length, severity: "error", message, source: i18n._(msg`math`) }];
      }
      start = text.indexOf(open, end + close.length);
    }
    return [];
  });
}
