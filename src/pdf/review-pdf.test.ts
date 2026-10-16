import { describe, expect, it } from "vitest";
import type { EditorComment } from "../editor/comments/editor-comment-data";
import {
  findQuads, lineAndColumn, placeAnnotation, quoteLetters, separateNotes,
  type PageText, type PlacementReader, type SyncBox, type TextRun,
} from "./review-pdf";

/** A run of 10 pt text whose characters are each 5 pt wide, its baseline at `y`. */
const run = (str: string, x: number, y: number): TextRun => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10 });

const VIEW = [0, 0, 612, 792];
const page = (...runs: TextRun[]): PageText => ({ view: VIEW, runs });

const annotation = (change: Partial<EditorComment>): EditorComment => ({
  id: "a1", number: 1, path: "main.tex", from: 0, to: 0, quote: "", prefix: "", suffix: "", body: "Tighten",
  authorId: "me", authorName: "Ada", resolved: false, replies: [], createdAt: "2026-10-16T08:00:00.000Z", updatedAt: "2026-10-16T08:00:00.000Z",
  ...change,
});

const reader = (pages: PageText[], sync: SyncBox | null = null): PlacementReader => ({
  pageCount: pages.length,
  page: async (number) => pages[number - 1]!,
  sync: async () => sync,
});

describe("findQuads", () => {
  it("covers exactly the quoted words, one quad per line", () => {
    const text = page(
      run("Our method is", 72, 700),
      run("the first to scale", 140, 700),
      run("past a thousand GPUs.", 72, 688),
    );
    const quads = findQuads(text, quoteLetters("the first to scale past a thousand"), null)!;
    expect(quads).toHaveLength(2);
    expect(quads[0]![0]).toBeCloseTo(140);
    expect(quads[0]![2]).toBeCloseTo(140 + 18 * 5);
    // "past a thousand" is most of its run, shared out by the letters' widths: "GPUs." is wide.
    expect(quads[1]![0]).toBeCloseTo(72);
    expect(quads[1]![2]).toBeGreaterThan(72 + 60);
    expect(quads[1]![2]).toBeLessThan(72 + 15 * 5);
    // Upper corners above the baseline, lower ones below it.
    expect(quads[0]![1]).toBeGreaterThan(700);
    expect(quads[0]![5]).toBeLessThan(700);
  });

  it("reads a source quote's commands, ligatures and accents as the page prints them", () => {
    const text = page(run("We define the eﬃcient café as ours.", 72, 500));
    expect(findQuads(text, quoteLetters("define the \\emph{efficient} caf\\'e"), null)).not.toBeNull();
  });

  it("takes the occurrence nearest where the note was made", () => {
    const text = page(run("the same sentence again", 72, 700), run("the same sentence again", 72, 300));
    const quads = findQuads(text, quoteLetters("the same sentence"), 310)!;
    expect(quads[0]![5]).toBeLessThan(300);
  });

  it("does not match a citation's key against the bibliography that prints it", () => {
    const text = page(run("Prior work [1] used dense kernels.", 72, 700), run("[1] A. Vaswani. Attention is all you need.", 72, 100));
    expect(findQuads(text, quoteLetters("\\cite{vaswani}"), null)).toBeNull();
    expect(findQuads(text, quoteLetters("Prior work~\\citep[p.~3]{vaswani} used dense kernels"), null)).not.toBeNull();
  });

  it("finds nothing for words the page does not have, or too few to tell", () => {
    expect(findQuads(page(run("Something else entirely.", 72, 700)), quoteLetters("the first to scale"), null)).toBeNull();
    expect(findQuads(page(run("a b c", 72, 700)), quoteLetters("ab"), null)).toBeNull();
  });
});

describe("placeAnnotation", () => {
  it("highlights a PDF selection on the page it was made", async () => {
    const pages = [page(run("Intro.", 72, 700)), page(run("Results beat the baseline.", 72, 600))];
    const placement = await placeAnnotation(
      annotation({ pdf: { page: 2, rects: [{ x: 0.1, y: 0.24, width: 0.3, height: 0.02 }], text: "beat the baseline" } }),
      reader(pages),
    );
    expect(placement).toMatchObject({ kind: "highlight", page: 2 });
  });

  it("looks on the next page when SyncTeX names the one before", async () => {
    const pages = [page(run("Intro.", 72, 700)), page(run("Results beat the baseline.", 72, 600))];
    const placement = await placeAnnotation(
      annotation({ quote: "beat the baseline" }),
      reader(pages, { page: 1, x: 72, y: 700, width: 300, height: 10 }),
    );
    expect(placement).toMatchObject({ kind: "highlight", page: 2 });
  });

  it("puts a note in the margin beside SyncTeX's line when the words are not on the page", async () => {
    const placement = await placeAnnotation(
      annotation({ quote: "$\\alpha + \\beta$" }),
      reader([page(run("α + β", 72, 600))], { page: 1, x: 72, y: 180, width: 300, height: 10 }),
    );
    expect(placement).toEqual({ kind: "note", page: 1, x: 612 - 18 - 8, y: 792 - 180 });
  });

  it("leaves unplaced a note SyncTeX cannot find", async () => {
    expect(await placeAnnotation(annotation({ quote: "a lost passage" }), reader([page()]))).toEqual({ kind: "unplaced" });
  });
});

describe("separateNotes", () => {
  it("moves a note that would cover another in the same margin", () => {
    const views = new Map([[1, VIEW]]);
    const placed = separateNotes([
      { kind: "note", page: 1, x: 586, y: 700 },
      { kind: "note", page: 1, x: 586, y: 705 },
      { kind: "note", page: 2, x: 586, y: 700 },
    ], views);
    expect(placed.map((placement) => placement.kind === "note" && placement.y)).toEqual([700, 678, 700]);
  });
});

describe("lineAndColumn", () => {
  it("counts from 1, as SyncTeX does", () => {
    expect(lineAndColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
    expect(lineAndColumn("ab", 0)).toEqual({ line: 1, column: 1 });
  });
});
