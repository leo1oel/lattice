/**
 * Placing text selected on the compiled PDF in its LaTeX source. SyncTeX
 * names the line a point on the page came from; the selected text is then
 * looked for around that line. The PDF's text is the source after TeX read
 * it, and a selection reads it back imperfectly: words joined across line
 * breaks, ligatures, hyphenation, a word cut at either end. So both sides
 * are compared as their letters and digits alone, and only the selection's
 * two ends need to be found.
 */

/** Lines either side of SyncTeX's line to look in: it may name a paragraph's first line, or a later one. */
const LINES_BEFORE = 8;
const LINES_AFTER = 16;
/** How many letters from each end of the selection must match. */
const END_LENGTH = 24;

const LIGATURES: Record<string, string> = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };
const LETTER = /[\p{L}\p{N}]/u;

/** The PDF text's letters and digits, lower case, ligatures spelled out. */
function pdfLetters(text: string): string {
  return [...text.replace(/[ﬀ-ﬆ]/g, (ligature) => LIGATURES[ligature] ?? ligature)]
    .filter((char) => LETTER.test(char))
    .join("")
    .toLocaleLowerCase();
}

/**
 * The source's prose letters from `start`, lower case, with the offset of
 * each: command names (`\section`) and `%` comments are not prose.
 */
export function sourceLetters(source: string, start: number, end: number): { letters: string; offsets: number[] } {
  let letters = "";
  const offsets: number[] = [];
  for (let index = start; index < end; index += 1) {
    const char = source[index]!;
    if (char === "\\") {
      while (index + 1 < end && /[A-Za-z@]/.test(source[index + 1]!)) index += 1;
      continue;
    }
    if (char === "%" && source[index - 1] !== "\\") {
      while (index + 1 < end && source[index + 1] !== "\n") index += 1;
      continue;
    }
    if (!LETTER.test(char)) continue;
    letters += char.toLocaleLowerCase();
    offsets.push(index);
  }
  return { letters, offsets };
}

/** `[from, to)` widened to whole words, so a selection cut mid-word quotes the word. */
function wholeWords(source: string, from: number, to: number): { from: number; to: number } {
  while (from > 0 && LETTER.test(source[from - 1]!)) from -= 1;
  while (to < source.length && LETTER.test(source[to]!)) to += 1;
  return { from, to };
}

/**
 * The span of `source` the PDF text `text` came from, looked for around the
 * 1-based `line` SyncTeX gave: from where the selection's first letters are
 * to where its last ones are, nearest that line. When they cannot be found
 * (a formula, a figure's label), the text of `line` itself. Null when `line`
 * is outside the file.
 */
export function sourceRangeForPdfText(source: string, line: number, text: string): { from: number; to: number } | null {
  const lines = source.split("\n");
  if (line < 1 || line > lines.length) return null;
  const offsetOf = (index: number) => lines.slice(0, index).reduce((total, item) => total + item.length + 1, 0);
  const lineStart = offsetOf(line - 1);
  const { letters, offsets } = sourceLetters(
    source,
    offsetOf(Math.max(0, line - 1 - LINES_BEFORE)),
    offsetOf(Math.min(lines.length, line + LINES_AFTER)),
  );
  const wanted = pdfLetters(text);
  if (wanted) {
    const head = wanted.slice(0, END_LENGTH);
    const tail = wanted.slice(-END_LENGTH);
    let best: { from: number; to: number; distance: number } | null = null;
    for (let start = letters.indexOf(head); start >= 0; start = letters.indexOf(head, start + 1)) {
      const end = letters.indexOf(tail, start);
      if (end < 0) continue;
      const from = offsets[start]!;
      const to = offsets[end + tail.length - 1]! + 1;
      const distance = Math.abs(from - lineStart);
      if (to > from && (!best || distance < best.distance)) best = { from, to, distance };
    }
    if (best) return wholeWords(source, best.from, best.to);
  }
  const lineText = lines[line - 1]!;
  const from = lineStart + lineText.length - lineText.trimStart().length;
  const to = lineStart + lineText.trimEnd().length;
  return to > from ? { from, to } : null;
}
