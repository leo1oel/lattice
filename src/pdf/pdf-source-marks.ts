/**
 * Where an annotation made in the .tex source is drawn on the compiled PDF,
 * so a reader of the PDF sees every note, not only the ones made on it.
 *
 * SyncTeX's forward search (`synctex_view`, the lookup Reveal in PDF makes)
 * names the page and line the range starts on in the last build; the words
 * the range quotes are then looked for there and on the pages either side,
 * exactly as the review PDF places a source note (review-pdf.ts
 * `placeAnnotation`), so the PDF marks the words the .tex marks. When they do
 * not read on the page (a formula, a macro), the mark falls back to the box
 * SyncTeX gives each source line of the range: line-granular, and only while
 * those lines are still the ones the PDF was built from. After an edit above
 * or inside the range, SyncTeX's line numbers belong to the old text and
 * would mark some other passage, so such a note has no mark until the next
 * build rather than a wrong one.
 */
import type { EditorComment, PdfRect } from "../editor/comments/editor-comment-data";
import { markOf, quadBands, type PdfMarkPlace } from "./pdf-annotation-place";
import { lineAndColumn, placeAnnotation, type PageText, type SyncBox } from "./review-pdf";

/** A mark and the page it is drawn on. */
export type PlacedMark = PdfMarkPlace & { page: number };

/** What placing a source note reads: the PDF on screen, and SyncTeX's map of the build it came from. */
export type SourceMarkReader = {
  pageCount: number;
  page: (page: number) => Promise<PageText>;
  /** `synctex_view` for a 1-based source line and column; null when SyncTeX has no box for it. */
  sync: (path: string, line: number, column: number) => Promise<SyncBox | null>;
};

/** Source lines looked up, each a SyncTeX process of its own, for a long range's line marks. */
const MAX_LINE_BOXES = 12;
/**
 * A box taller than this (points) is not a line: SyncTeX answers a line in a
 * figure or a float with the whole of it, which would bury the page in amber.
 */
const MAX_LINE_HEIGHT = 36;

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** SyncTeX's box (points from the page's top left) as fractions of the page. */
function boxRect(box: SyncBox, view: readonly number[]): PdfRect | null {
  const [x0 = 0, y0 = 0, x1 = 612, y1 = 792] = view;
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0 || box.width <= 0 || box.height <= 0 || box.height > MAX_LINE_HEIGHT) return null;
  const x = Math.min(1, Math.max(0, box.x / width));
  const y = Math.min(1, Math.max(0, box.y / height));
  return { x: round(x), y: round(y), width: round(Math.min(1 - x, box.width / width)), height: round(Math.min(1 - y, box.height / height)) };
}

/**
 * Whether `annotation`'s lines in `source` are the lines the PDF was built
 * from (`built`, the file's text then): nothing up to the end of its range
 * has changed since, so SyncTeX's line numbers still name its passage.
 */
export function linesAsBuilt(annotation: Pick<EditorComment, "to">, source: string, built: string | null): boolean {
  return built !== null && source.slice(0, annotation.to) === built.slice(0, annotation.to);
}

/**
 * Where `annotation`, made in `source` (its file's text now), is drawn on the
 * PDF `reader` reads: over its words when they read near SyncTeX's line, else
 * over SyncTeX's boxes for its lines when `asBuilt`; null when neither.
 */
export async function placeSourceMark(
  annotation: EditorComment,
  source: string,
  asBuilt: boolean,
  reader: SourceMarkReader,
): Promise<PlacedMark | null> {
  const start = lineAndColumn(source, annotation.from);
  const first = reader.sync(annotation.path, start.line, start.column).catch(() => null);
  const placement = await placeAnnotation({ ...annotation, pdf: undefined }, {
    pageCount: reader.pageCount,
    page: reader.page,
    sync: () => first,
  });
  if (placement.kind === "highlight") {
    const text = await reader.page(placement.page);
    const mark = markOf(text, quadBands(text, placement.quads));
    return mark && { page: placement.page, ...mark };
  }
  if (placement.kind === "unplaced" || !asBuilt) return null;
  const view = (await reader.page(placement.page)).view;
  const last = Math.min(lineAndColumn(source, Math.max(annotation.from, annotation.to - 1)).line, start.line + MAX_LINE_BOXES - 1);
  const rects: PdfRect[] = [];
  for (let line = start.line; line <= last; line += 1) {
    const box = line === start.line ? await first : await reader.sync(annotation.path, line, 1).catch(() => null);
    const rect = box && box.page === placement.page ? boxRect(box, view) : null;
    // Lines TeX set as one (a paragraph's source lines often are) give one box.
    if (rect && !rects.some((other) => other.x === rect.x && other.y === rect.y)) rects.push(rect);
  }
  rects.sort((a, b) => a.y - b.y || a.x - b.x);
  const mark = markOf(await reader.page(placement.page), rects);
  return mark && { page: placement.page, ...mark };
}
