/**
 * Where each annotation goes in a review copy of the compiled PDF
 * (`save_review_pdf`, src-tauri/src/review_pdf.rs), measured on the PDF the
 * preview shows. The words the annotation quotes are looked for on its page
 * — the page it was made on, or the one SyncTeX gives for its source line —
 * and on the pages either side, compared as letters alone as
 * `pdf-source-anchor.ts` does. Found, they become a highlight over exactly
 * those words; not found (a formula, a passage edited since the build), the
 * note becomes a sticky note in the page's margin beside where SyncTeX or the
 * original selection put it. A note with neither is reported unplaced, never
 * pinned to some other place that happens to read the same.
 */
import { sourceLetters } from "../editor/comments/pdf-source-anchor";
import type { EditorComment } from "../editor/comments/editor-comment-data";

/** Upper-left, upper-right, lower-left, lower-right corners, in PDF user space. */
export type Quad = [number, number, number, number, number, number, number, number];

/** A run of text on a page as PDF.js reads it (`getTextContent`'s items). */
export type TextRun = { str: string; transform: number[]; width: number; height: number };

/** A page's text and its box in user space: `[x0, y0, x1, y1]`. */
export type PageText = { view: number[]; runs: readonly TextRun[] };

/** Where SyncTeX puts a source line: page, then the box's top left in points from the page's top left. */
export type SyncBox = { page: number; x: number; y: number; width: number; height: number };

export type ReviewPlacement =
  | { kind: "highlight"; page: number; quads: Quad[] }
  | { kind: "note"; page: number; x: number; y: number }
  | { kind: "unplaced" };

/** What a placement needs read from the PDF and the project. */
export type PlacementReader = {
  pageCount: number;
  page: (page: number) => Promise<PageText>;
  /** SyncTeX's box for the annotation's source position; null when it has none. */
  sync: (annotation: EditorComment) => Promise<SyncBox | null>;
};

/** Letters matched from each end of the quote; shorter ends are tried when these miss. */
const END_LENGTHS = [24, 12];
/** A sticky note's icon is this square (as `NOTE_SIZE` in review_pdf.rs), kept this far inside the page. */
const NOTE_SIZE = 18;
const NOTE_INSET = 8;
/** A glyph's box around its baseline, as fractions of the font size. */
const ASCENT = 0.78;
const DESCENT = 0.22;

const LETTER = /[\p{L}\p{N}]/u;

/** One character's letters as compared: ligatures spelled out, accents dropped, lower case. */
function foldLetters(char: string): string {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a Unicode normalization form
  return [...char.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase()].filter((part) => LETTER.test(part)).join("");
}

/** A page's letters, each with the run and character it was read from. */
function pageLetters(runs: readonly TextRun[]): { letters: string; at: Array<[run: number, char: number]> } {
  let letters = "";
  const at: Array<[number, number]> = [];
  runs.forEach((run, index) => {
    [...run.str].forEach((char, offset) => {
      for (const letter of foldLetters(char)) {
        letters += letter;
        at.push([index, offset]);
      }
    });
  });
  return { letters, at };
}

/** The letters a PDF selection reads, as one stretch. */
function pdfTextLetters(text: string): string[] {
  return [[...text].map(foldLetters).join("")];
}

/**
 * Commands whose argument is a key the page never prints: `\cite{vaswani}`
 * reads "[1]", so its letters would only match the bibliography.
 */
const KEY_COMMANDS = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|[a-zA-Z]*ref|label|url|href)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g;

/**
 * The prose letters of a source quote, without its commands and comments,
 * in the stretches between its citations and cross-references: what those
 * print ("[1]", "Section 2") is unknown here, so the quote's ends are found
 * in the stretches either side of them.
 */
export function quoteLetters(quote: string): string[] {
  return quote.split(KEY_COMMANDS)
    .map((prose) => [...sourceLetters(prose, 0, prose.length).letters].map(foldLetters).join(""))
    .filter(Boolean);
}

/**
 * The quads over `wanted` (stretches of letters, in order) on a page: from
 * the first occurrence of its opening letters to the nearest following
 * occurrence of its closing ones, one quad per line. With several, the one
 * whose top is nearest `nearY` (user space). Null when it is not on the page.
 */
export function findQuads(page: PageText, wanted: readonly string[], nearY: number | null): Quad[] | null {
  const first = wanted[0] ?? "";
  const last = wanted.at(-1) ?? "";
  const size = wanted.reduce((total, part) => total + part.length, 0);
  if (size < 4) return null;
  const { letters, at } = pageLetters(page.runs);
  for (const length of END_LENGTHS) {
    const head = first.slice(0, length);
    const tail = last.slice(-length);
    // A citation or formula inside the quote reads differently on the page; allow for it.
    const longest = size * 1.5 + 40;
    const shortest = Math.max(head.length, tail.length, size - Math.floor(size / 2));
    let best: { quads: Quad[]; distance: number } | null = null;
    for (let start = letters.indexOf(head); start >= 0; start = letters.indexOf(head, start + 1)) {
      const end = letters.indexOf(tail, start + shortest - tail.length);
      if (end < 0 || end + tail.length - start > longest) continue;
      const quads = lineQuads(page.runs, at.slice(start, end + tail.length));
      if (!quads.length) continue;
      const distance = nearY === null ? 0 : Math.abs(quads[0]![1] - nearY);
      if (!best || distance < best.distance) best = { quads, distance };
      if (nearY === null) break;
    }
    if (best) return best.quads;
    if (first.length <= length && last.length <= length) break;
  }
  return null;
}

/**
 * Times Roman's advance widths for printable ASCII (space to tilde), in
 * thousandths of an em. PDF.js gives a run's extent, not each glyph's, so a
 * run's width is shared among its characters in these proportions: close
 * for any text face (Computer Modern included), where equal shares put a
 * highlight's ends a letter off on a long line.
 */
const ASCII_WIDTHS = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564, 564, 444,
  921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722,
  556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333, 278, 333, 469, 500,
  333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500,
  500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 480, 200, 480, 541,
];

function advance(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code >= 32 && code <= 126) return ASCII_WIDTHS[code - 32]!;
  // CJK and other wide scripts take a full em; other letters a typical one.
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char) ? 1000 : 500;
}

/** The boxes over the characters `span` names, one per line. */
function lineQuads(runs: readonly TextRun[], span: Array<[number, number]>): Quad[] {
  const perRun = new Map<number, [number, number]>();
  for (const [run, char] of span) {
    const range = perRun.get(run);
    perRun.set(run, range ? [Math.min(range[0], char), Math.max(range[1], char)] : [char, char]);
  }
  const lines: Array<{ baseline: number; size: number; left: number; right: number }> = [];
  for (const [index, [first, last]] of perRun) {
    const run = runs[index]!;
    const offsets = [0];
    for (const char of run.str) offsets.push(offsets.at(-1)! + advance(char));
    const total = offsets.at(-1)!;
    const [, , c = 0, d = 0, x = 0, baseline = 0] = run.transform;
    const size = run.height || Math.hypot(c, d);
    if (!total || !size) continue;
    const left = x + run.width * offsets[first]! / total;
    const right = x + run.width * offsets[last + 1]! / total;
    const line = lines.find((item) => Math.abs(item.baseline - baseline) < Math.min(item.size, size) / 2);
    if (line) {
      line.left = Math.min(line.left, left);
      line.right = Math.max(line.right, right);
      line.size = Math.max(line.size, size);
    } else {
      lines.push({ baseline, size, left, right });
    }
  }
  return lines
    .sort((a, b) => b.baseline - a.baseline)
    .map(({ baseline, size, left, right }) => {
      const top = baseline + size * ASCENT;
      const bottom = baseline - size * DESCENT;
      return [left, top, right, top, left, bottom, right, bottom];
    });
}

/** The page's right margin, where a sticky note's icon stands, at `top` (user space) kept on the page. */
function marginNote(page: number, view: number[], top: number): ReviewPlacement {
  const [x0 = 0, y0 = 0, x1 = 612, y1 = 792] = view;
  return {
    kind: "note",
    page,
    x: Math.max(x0, x1 - NOTE_SIZE - NOTE_INSET),
    y: Math.min(y1 - NOTE_INSET, Math.max(y0 + NOTE_SIZE + NOTE_INSET, top)),
  };
}

/** Pages to look on: `page` first, then the ones either side. */
const nearbyPages = (page: number, count: number) => [page, page + 1, page - 1].filter((item) => item >= 1 && item <= count);

/** Where `annotation` goes on the PDF `reader` reads. */
export async function placeAnnotation(annotation: EditorComment, reader: PlacementReader): Promise<ReviewPlacement> {
  const anchor = annotation.pdf && annotation.pdf.page <= reader.pageCount ? annotation.pdf : null;
  const sync = anchor ? null : await reader.sync(annotation).catch(() => null);
  const home = anchor?.page ?? (sync && sync.page <= reader.pageCount ? sync.page : null);
  if (home === null) return { kind: "unplaced" };
  const homeText = await reader.page(home);
  const height = (homeText.view[3] ?? 0) - (homeText.view[1] ?? 0);
  // Where on the page it was: SyncTeX's box, or the selection's first line.
  const top = (homeText.view[3] ?? 0) - (anchor ? (anchor.rects[0]?.y ?? 0) * height : sync!.y);
  const wanted = anchor ? pdfTextLetters(anchor.text) : quoteLetters(annotation.quote);
  for (const page of nearbyPages(home, reader.pageCount)) {
    const text = page === home ? homeText : await reader.page(page);
    const quads = findQuads(text, wanted, page === home ? top : null);
    if (quads) return { kind: "highlight", page, quads };
  }
  return marginNote(home, homeText.view, top);
}

/**
 * Sticky notes that would stand on one another in a page's margin, moved
 * down (or up, near the page's foot) until each has its own place.
 */
export function separateNotes(placements: ReviewPlacement[], views: ReadonlyMap<number, number[]>): ReviewPlacement[] {
  const taken = new Map<number, number[]>();
  return placements.map((placement) => {
    if (placement.kind !== "note") return placement;
    const used = taken.get(placement.page) ?? [];
    const bottom = (views.get(placement.page)?.[1] ?? 0) + NOTE_SIZE + NOTE_INSET;
    const step = NOTE_SIZE + 4;
    const clear = (direction: 1 | -1) => {
      let y = placement.y;
      for (let other = used.find((item) => Math.abs(item - y) < step); other !== undefined; other = used.find((item) => Math.abs(item - y) < step)) {
        y = other + direction * step;
      }
      return y;
    };
    let y = clear(-1);
    if (y < bottom) y = clear(1);
    used.push(y);
    taken.set(placement.page, used);
    return { ...placement, y };
  });
}

/** The 1-based line and column of `offset` in `source`, as SyncTeX takes them. */
export function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lineStart = before.lastIndexOf("\n") + 1;
  return { line: before.split("\n").length, column: offset - lineStart + 1 };
}

/** `paper.pdf` → `paper-review.pdf`. */
export function reviewFileName(fileName: string): string {
  const stem = fileName.replace(/\.pdf$/i, "") || "paper";
  // eslint-disable-next-line lingui/no-unlocalized-strings -- a file name, as the compiled PDF's
  return `${stem}-review.pdf`;
}

/** Hex SHA-256 of the PDF's bytes, which the backend checks it is annotating. */
export async function pdfDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  // eslint-disable-next-line lingui/no-unlocalized-strings -- an algorithm name
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
