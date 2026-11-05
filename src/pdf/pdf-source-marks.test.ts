import { describe, expect, it, vi } from "vitest";
import { createEditorComment, type EditorComment } from "../editor/comments/editor-comment-data";
import { linesAsBuilt, placeSourceMark, type SourceMarkReader } from "./pdf-source-marks";
import type { PageText, SyncBox, TextRun } from "./review-pdf";

/** A run of 10 pt text whose characters are each 5 pt wide (as `review-pdf.test.ts`), its baseline at `y`. */
const run = (str: string, x: number, y: number): TextRun => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10 });
const VIEW = [0, 0, 612, 792];
const page = (...runs: TextRun[]): PageText => ({ view: VIEW, runs });

const SOURCE = [
  "\\section{Attention}",
  "Scaled dot-product attention divides the scores",
  "by $\\sqrt{d_k}$ before the softmax, which keeps",
  "the gradients from vanishing.",
].join("\n");

/** A note made in main.tex over `quote` in `source`. */
function note(quote: string, source = SOURCE): EditorComment {
  const from = source.indexOf(quote);
  return createEditorComment({ path: "main.tex", source, from, to: from + quote.length, number: 3, body: "Why?", authorId: "me", authorName: "Ada" })!;
}

/** SyncTeX's box for each typeset line: source lines 2–4 set as two lines at 700 and 688 on page 1. */
const LINE_BOXES: Record<number, SyncBox> = {
  2: { page: 1, x: 72, y: 792 - 700 - 8, width: 400, height: 10 },
  3: { page: 1, x: 72, y: 792 - 688 - 8, width: 400, height: 10 },
  4: { page: 1, x: 72, y: 792 - 688 - 8, width: 400, height: 10 },
};

function reader(pages: PageText[], boxes: Record<number, SyncBox> = LINE_BOXES) {
  const sync = vi.fn(async (_path: string, line: number) => boxes[line] ?? null);
  const value: SourceMarkReader = { pageCount: pages.length, page: async (number) => pages[number - 1]!, sync };
  return { reader: value, sync };
}

// The PDF prints the formula in a math font whose glyphs read as no letters.
const PRINTED = page(
  run("Scaled dot-product attention divides the scores by", 72, 700),
  run("\u221A\uE000 before the softmax, which keeps the gradients from vanishing.", 72, 688),
);
const round = (value: number) => Math.round(value * 10_000) / 10_000;

describe("placeSourceMark", () => {
  it("marks on the PDF the words a .tex note quotes, on the line SyncTeX names", async () => {
    const { reader: pdf, sync } = reader([PRINTED]);
    const mark = (await placeSourceMark(note("divides the scores"), SOURCE, true, pdf))!;
    expect(mark.page).toBe(1);
    expect(mark.rects).toHaveLength(1);
    // "divides the scores" starts 29 characters into its run, 5 pt each.
    expect(mark.rects[0]!.x).toBeCloseTo((72 + 29 * 5) / 612, 2);
    expect(mark.rects[0]!.width).toBeLessThan(20 * 5 / 612);
    // The pin stands at the column's left edge, beside the first line.
    expect(mark.pin).toMatchObject({ x: round(72 / 612), side: "start" });
    // Found by its words, it asks SyncTeX only where its range starts.
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith("main.tex", 2, 30);
  });

  it("finds the words on the next page when SyncTeX names the one before", async () => {
    const { reader: pdf } = reader([page(run("Introduction.", 72, 700)), PRINTED]);
    expect(await placeSourceMark(note("divides the scores"), SOURCE, true, pdf)).toMatchObject({ page: 2 });
  });

  it("falls back to SyncTeX's box for each line of a formula the page prints differently, one per typeset line", async () => {
    const { reader: pdf } = reader([PRINTED]);
    const mark = (await placeSourceMark(note("$\\sqrt{d_k}$ before the softmax, which keeps\nthe gradients"), SOURCE, true, pdf))!;
    // Source lines 3 and 4 are typeset on one line: one band, SyncTeX's box.
    expect(mark.rects).toEqual([{ x: round(72 / 612), y: round((792 - 688 - 8) / 792), width: round(400 / 612), height: round(10 / 792) }]);
  });

  it("draws no mark from SyncTeX's lines once the source above the note has changed since the build", async () => {
    const { reader: pdf } = reader([PRINTED]);
    // A line added above: SyncTeX's line 3 is now another passage of the PDF.
    const edited = `% a new comment line\n${SOURCE}`;
    const formula = note("$\\sqrt{d_k}$", edited);
    expect(linesAsBuilt(formula, edited, SOURCE)).toBe(false);
    expect(await placeSourceMark(formula, edited, false, pdf)).toBeNull();
    // Its words still read on the PDF, so a prose note keeps its mark.
    expect(await placeSourceMark(note("before the softmax", edited), edited, false, pdf)).not.toBeNull();
  });

  it("draws no mark where SyncTeX has no box, or only a float's", async () => {
    const { reader: none } = reader([PRINTED], {});
    expect(await placeSourceMark(note("divides the scores"), SOURCE, true, none)).toBeNull();
    const figure = { 3: { page: 1, x: 72, y: 200, width: 400, height: 240 } };
    const { reader: tall } = reader([PRINTED], figure);
    expect(await placeSourceMark(note("$\\sqrt{d_k}$"), SOURCE, true, tall)).toBeNull();
  });

  it("draws no mark when SyncTeX fails, as with a PDF built without its map", async () => {
    const pdf: SourceMarkReader = {
      pageCount: 1, page: async () => PRINTED, sync: async () => { throw new Error("Build the project before locating source in the PDF."); },
    };
    expect(await placeSourceMark(note("divides the scores"), SOURCE, true, pdf)).toBeNull();
  });
});

describe("linesAsBuilt", () => {
  it("holds while nothing up to the note's end has changed since the build", () => {
    const formula = note("$\\sqrt{d_k}$");
    expect(linesAsBuilt(formula, SOURCE, SOURCE)).toBe(true);
    expect(linesAsBuilt(formula, `${SOURCE}\nA new closing line.`, SOURCE)).toBe(true);
    expect(linesAsBuilt(formula, SOURCE.replace("Scaled", "Scaled, "), SOURCE)).toBe(false);
    expect(linesAsBuilt(formula, SOURCE, null)).toBe(false);
  });
});
