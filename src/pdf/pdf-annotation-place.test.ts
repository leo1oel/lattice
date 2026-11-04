import { describe, expect, it } from "vitest";
import { sourceRangeForPdfText } from "../editor/comments/pdf-source-anchor";
import { placePdfMark } from "./pdf-annotation-place";
import type { PageText, TextRun } from "./review-pdf";

/** A run of 10 pt text whose characters are each 5 pt wide (as `review-pdf.test.ts`), its baseline at `y`. */
const run = (str: string, x: number, y: number): TextRun => ({ str, transform: [10, 0, 0, 10, x, y], width: str.length * 5, height: 10 });
const VIEW = [0, 0, 612, 792];
const page = (...runs: TextRun[]): PageText => ({ view: VIEW, runs });
/** A selection's saved box near a baseline, as the text layer measured it: any height. */
const saved = (x: number, baseline: number, height: number) => ({ x: x / 612, y: (792 - baseline - height * 0.8) / 792, width: 0.2, height: height / 792 });

const SOURCE = [
  "\\section{From sequence models to attention}",
  "A sequence model must decide how information at one position can influence another.",
  "Recurrent neural networks pass a hidden state from left to right, creating a path.",
].join("\n");
const LINE_ONE = "A sequence model must decide how information";
const LINE_TWO = "at one position can influence another. Recurrent";
const LINE_THREE = "neural networks pass a hidden state from left to right,";
const PAGE = page(run(LINE_ONE, 72, 700), run(LINE_TWO, 72, 688), run(LINE_THREE, 72, 676));

describe("placePdfMark", () => {
  it("marks on the PDF the whole words the source range holds when the selection began mid-word", () => {
    // The drag began after "mode": SyncTeX's line, then the words, widened to whole ones.
    const text = "l must decide how information at one position can influence another. Recurrent neural networks pass a hidden state from left to right";
    const range = sourceRangeForPdfText(SOURCE, 2, text)!;
    const quote = SOURCE.slice(range.from, range.to);
    expect(quote.startsWith("model must decide")).toBe(true);
    const place = placePdfMark(PAGE, { quote, pdf: { page: 1, rects: [saved(72 + 15 * 5, 700, 9)], text } })!;
    // "model" is the 11th character of the first line, at 5 pt each: the band starts there, not at its "l".
    expect(Math.abs(place.rects[0]!.x * 612 - (72 + LINE_ONE.indexOf("model") * 5))).toBeLessThan(2.5);
    expect(place.rects).toHaveLength(3);
    // And ends with "right", not with the line's comma.
    const last = place.rects.at(-1)!;
    // (A run's width is shared in Times's proportions, so a glyph lands within a couple of points.)
    const comma = 72 + LINE_THREE.indexOf(",") * 5;
    expect(Math.abs((last.x + last.width) * 612 - comma)).toBeLessThan(2.5);
  });

  it("gives every line of one size the same band, whatever the selection's boxes measured", () => {
    const quote = "information at one position";
    const place = placePdfMark(PAGE, { quote, pdf: { page: 1, rects: [saved(300, 700, 13), saved(72, 688, 7)], text: quote } })!;
    expect(place.rects).toHaveLength(2);
    expect(place.rects[0]!.height).toBe(place.rects[1]!.height);
    // The band reaches below the glyph box's foot (the baseline less 0.22 em), clear of the descenders.
    const foot = (place.rects[0]!.y + place.rects[0]!.height) * 792;
    expect(foot).toBeGreaterThan(792 - 700 + 2.2);
  });

  it("stands the pin in the left margin, clear of the words, for a passage inside a line", () => {
    const quote = "information at one position";
    const place = placePdfMark(PAGE, { quote, pdf: { page: 1, rects: [saved(300, 700, 9)], text: quote } })!;
    expect(place.pin.side).toBe("start");
    expect(place.pin.x * 612).toBeCloseTo(72, 0);
    expect(place.pin.y).toBeCloseTo(place.rects[0]!.y + place.rects[0]!.height / 2, 4);
  });

  it("stands the pin right of a two-column page's right-hand column", () => {
    const columns = page(
      run("Left column text runs here.", 54, 700),
      run("Right column words to mark.", 320, 700),
      run("Right column goes on below.", 320, 688),
    );
    const quote = "words to mark";
    const place = placePdfMark(columns, { quote, pdf: { page: 1, rects: [saved(370, 700, 9)], text: quote } })!;
    expect(place.pin.side).toBe("end");
    expect(place.pin.x * 612).toBeCloseTo(320 + "Right column goes on below.".length * 5, 0);
  });

  it("draws the saved selection when its words do not read on the page", () => {
    const rects = [saved(200, 500, 9)];
    const place = placePdfMark(PAGE, { quote: "$\\alpha$", pdf: { page: 1, rects, text: "α" } })!;
    expect(place.rects).toEqual(rects);
  });
});
