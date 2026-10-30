/**
 * The word under a double-click on a PDF page, read off PDF.js's text layer,
 * for a reverse SyncTeX jump to land on it (see
 * `src/editor/latex/synctex-word.ts`).
 *
 * A text layer is a set of absolutely positioned glyph spans; one visual line
 * is often several of them, split wherever the PDF moved its pen. The line is
 * put back together from the spans level with the clicked one, left to right,
 * with a space wherever two of them stand apart. Which character was hit is
 * measured glyph by glyph: the spans are transparent and `user-select: none`
 * outside a drag (pdf-text-layer-selection.ts), so the caret-from-point APIs
 * cannot be relied on to find it.
 */
import type { SyncTexWord } from "../app-types";
import { clickedWordIn } from "../editor/latex/synctex-word";

const GLYPH_SPANS = ".textLayer span:not(.markedContent):not(.endOfContent)";
/** A horizontal gap between two spans wider than this share of the line's height reads as a space. */
const SPACE_GAP = 0.15;

type Box = Pick<DOMRect, "left" | "right" | "top" | "bottom">;

const contains = (box: Box, x: number, y: number) => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

/** The offset of the character of `span` at `x`, by measuring each glyph; null when none is under it. */
function characterAt(span: HTMLElement, x: number, y: number): number | null {
  const node = span.firstChild;
  if (!(node instanceof Text)) return null;
  const range = document.createRange();
  for (let offset = 0; offset < node.length; offset += 1) {
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const box = range.getBoundingClientRect();
    if (box.right > box.left && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return offset;
  }
  return null;
}

/** The text of the visual line `span` is on, and where `span`'s own text starts in it. */
function lineOf(page: HTMLElement, span: HTMLElement): { text: string; start: number } {
  const box = span.getBoundingClientRect();
  const middle = (item: Box) => (item.top + item.bottom) / 2;
  const level = [...page.querySelectorAll<HTMLElement>(GLYPH_SPANS)]
    .map((item) => ({ item, box: item.getBoundingClientRect() }))
    .filter(({ item, box: other }) => item === span || (
      other.right > other.left && middle(other) >= box.top && middle(other) <= box.bottom
    ))
    .sort((a, b) => a.box.left - b.box.left);
  let text = "";
  let start = 0;
  let previous: Box | null = null;
  for (const { item, box: other } of level) {
    if (previous && other.left - previous.right > SPACE_GAP * (box.bottom - box.top) && !/\s$/.test(text)) text += " ";
    if (item === span) start = text.length;
    text += item.textContent ?? "";
    previous = other;
  }
  return { text, start };
}

/** The word double-clicked at (`x`, `y`) on `page`, or null when the click was not on a word. */
export function pdfClickedWord(page: HTMLElement, x: number, y: number): SyncTexWord | null {
  const span = [...page.querySelectorAll<HTMLElement>(GLYPH_SPANS)]
    .find((item) => contains(item.getBoundingClientRect(), x, y));
  if (!span) return null;
  const offset = characterAt(span, x, y);
  if (offset === null) return null;
  const line = lineOf(page, span);
  return clickedWordIn(line.text, line.start + offset);
}
