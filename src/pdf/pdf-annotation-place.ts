/**
 * Where an annotation made on the PDF is drawn on its page. The highlight
 * covers the words its source range quotes, found in the page's text as the
 * review PDF finds them (review-pdf.ts): the selection's own boxes come from
 * the text layer, whose fallback font puts a glyph a few letters off the
 * canvas mid-line, and a selection cut mid-word quotes the whole word in the
 * source, so drawing those boxes left the PDF marking other words than the
 * .tex. Each line's band is one box from the line's font size, so lines
 * match in height whatever glyphs they hold, and it reaches a little below
 * the descenders so its rule never cuts a letter. The pin stands in the
 * margin beside the column the passage starts in, never over its words.
 */
import type { EditorComment, PdfRect } from "../editor/comments/editor-comment-data";
import { anchoredQuads, type PageText } from "./review-pdf";

/**
 * A mark on its page, in fractions of the page: one band per line, and the
 * pin's column edge and first line, and which side of its column it stands:
 * the left margin, or the right one of a page's right-hand column.
 */
export type PdfMarkPlace = { rects: PdfRect[]; pin: { x: number; y: number; side: "start" | "end" } };

/** How far a band reaches below the glyph box (baseline − 0.22 em), as a fraction of the font size: its rule clears the descenders. */
const RULE_CLEARANCE = 0.1;

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** A text run's left, right and baseline on the page, in user space. */
function runBox(run: PageText["runs"][number]) {
  const x = run.transform[4] ?? 0;
  return { left: x, right: x + run.width, baseline: run.transform[5] ?? 0, size: run.height || Math.hypot(run.transform[2] ?? 0, run.transform[3] ?? 0) };
}

/**
 * The pin's place for a passage whose first line is `first` (fractions of
 * the page): the left edge of the text column, or for a passage in the
 * right-hand column of a two-column page, that column's right edge. A line
 * with text across the page's middle is one column wide.
 */
function pinPlace(page: PageText | null, first: PdfRect): PdfMarkPlace["pin"] {
  const y = round(first.y + first.height / 2);
  const [x0 = 0, y0 = 0, x1 = 612, y1 = 792] = page?.view ?? [];
  const width = x1 - x0;
  const runs = (page?.runs ?? []).filter((run) => run.str.trim() && run.width > 0).map(runBox);
  if (!runs.length || width <= 0) return { x: first.x, y, side: "start" };
  const middle = x0 + width / 2;
  const top = y1 - first.y * (y1 - y0);
  const bottom = y1 - (first.y + first.height) * (y1 - y0);
  const line = runs.filter((run) => run.baseline <= top && run.baseline >= bottom);
  const spansMiddle = line.some((run) => run.left < middle && run.right > middle);
  const right = !spansMiddle && x0 + first.x * width > middle;
  const fraction = (value: number) => round((value - x0) / width);
  if (right) return { x: fraction(Math.max(...runs.filter((run) => run.left >= middle).map((run) => run.right))), y, side: "end" };
  const column = spansMiddle ? runs : runs.filter((run) => run.left < middle);
  return { x: Math.min(first.x, fraction(Math.min(...column.map((run) => run.left)))), y, side: "start" };
}

/**
 * Where `annotation` is drawn on `page` (its text, or null when it could not
 * be read): over its quoted words, or, when they do not read on the page,
 * the selection's boxes as they were saved.
 */
export function placePdfMark(page: PageText | null, annotation: Pick<EditorComment, "quote" | "pdf">): PdfMarkPlace | null {
  const anchor = annotation.pdf;
  const saved = anchor?.rects ?? [];
  const [x0 = 0, y0 = 0, x1 = 612, y1 = 792] = page?.view ?? [];
  const width = x1 - x0;
  const height = y1 - y0;
  const nearY = saved[0] ? y1 - saved[0].y * height : null;
  const quads = page && width > 0 && height > 0 ? anchoredQuads(page, annotation, nearY) : null;
  const rects = quads
    ? quads.map(([left, top, right, , , bottom]): PdfRect => {
      const low = bottom - (top - bottom) * RULE_CLEARANCE;
      return { x: round((left - x0) / width), y: round((y1 - top) / height), width: round((right - left) / width), height: round((top - low) / height) };
    })
    : saved;
  const first = rects[0] && { ...rects[0], x: Math.min(...rects.map((rect) => rect.x)) };
  return first ? { rects, pin: pinPlace(page, first) } : null;
}
