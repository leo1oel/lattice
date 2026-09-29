import type { Diagnostic } from "@codemirror/lint";
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
  for (let start = text.indexOf(open); start >= 0;) {
    const end = text.indexOf(close, start + open.length);
    if (end < 0) return null;
    if (position >= start && position <= end + close.length) {
      return { from: start, to: end + close.length, source: text.slice(start + open.length, end).trim(), display, open, close };
    }
    start = text.indexOf(open, end + close.length);
  }
  return null;
}

export function mathRegionAt(text: string, position: number): MathRegion | null {
  const clamped = Math.max(0, Math.min(position, text.length));
  for (const delimiter of DELIMITERS) {
    const region = findDelimited(text, clamped, delimiter);
    if (region) return region;
  }
  return null;
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
