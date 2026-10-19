import { describe, expect, it } from "vitest";
import type { DisplayList, Fragment, Line, PageUpdate } from "./rtex-protocol";
import { PreviewModel, reanchor } from "./rtex-model";

// Coordinates in points, stored in sp (the plugin's model tests, with Lattice's base PDF added).
const U = 65536;
const line = (x: number, y: number, extra: Partial<Line> = {}): Line => ({ x: x * U, y: y * U, w: 100 * U, h: 7 * U, d: 2 * U, items: [], ...extra });
const dl = (lines: Line[], kind = "page"): DisplayList => ({ kind, fonts: {}, lines, other: [], flags: [], width: 0, height: 0, depth: 0, page_width: 600, page_height: 800 });
const page = (n: number, lines: Line[], exact = true): PageUpdate => ({ page: n, exact, hash: n, dl: dl(lines) });
const frag = (pageNumber: number, xs: number[], baselines: number[], first = 1): Fragment => ({
  page: pageNumber,
  first_line: first,
  last_line: first + baselines.length - 1,
  x: xs[0] * U,
  xs: xs.map((v) => v * U),
  baselines: baselines.map((v) => v * U),
  approximate: false,
});
const placements = [
  { par_id: 5, fragments: [frag(1, [10, 10], [112, 124]), frag(2, [10], [100])], lines: 3, kind: "par" },
  { par_id: 6, fragments: [frag(1, [10], [100])], lines: 1, kind: "heading:section" },
];

/** rtex loaded the files at revision 1, the revision the PDF on screen was built from. */
function setup() {
  const model = new PreviewModel();
  model.baseRevision = 1;
  model.applyLayout({
    pages: [page(1, [line(10, 100), line(10, 112), line(10, 124)]), page(2, [line(10, 100), line(10, 112)], false)],
    pagesTotal: 2,
    placements,
    revision: 1,
    layoutVersion: 1,
    hasFallback: true,
  });
  return model;
}

describe("the live preview model", () => {
  it("leaves pages to the PDF until rtex lays them out past it", () => {
    const model = setup();
    expect(model.pageSource(1)).toEqual({ kind: "base" });
    expect(model.pageSource(2)).toEqual({ kind: "base" });
    model.applyLayout({ pages: [page(1, [line(10, 100)])], pagesTotal: 2, placements, revision: 4, layoutVersion: 2, hasFallback: false });
    expect(model.pageSource(1).kind).toBe("display-list");
    expect(model.pageSource(2)).toEqual({ kind: "base" });
    // A build of revision 4 is on screen: the PDF holds that page again.
    model.setBase(4);
    expect(model.pageSource(1)).toEqual({ kind: "base" });
  });

  it("draws a page it cannot describe exactly from the fallback PDF of its own layout", () => {
    const model = setup();
    model.applyLayout({ pages: [page(2, [line(10, 100)], false)], pagesTotal: 2, placements, revision: 3, layoutVersion: 2, hasFallback: true });
    expect(model.pageSource(2)).toMatchObject({ kind: "fallback", layoutVersion: 2 });
    // A later layout changed it again without a PDF: no fallback matches it, so the PDF under it stays.
    model.applyLayout({ pages: [page(2, [line(10, 100)], false)], pagesTotal: 2, placements, revision: 5, layoutVersion: 3, hasFallback: false });
    expect(model.pageSource(2)).toEqual({ kind: "base" });
  });

  it("hides a unit's rows and places its live rows", () => {
    const model = setup();
    const fast = dl([line(0, 7), line(0, 19), line(0, 31), line(0, 43)], "paragraph");
    const dirty = model.applyParagraph(5, fast, [frag(1, [10, 10], [112, 124]), frag(2, [10, 10], [100, 112], 3)], 3);
    expect([...dirty].sort()).toEqual([1, 2]);
    expect([...model.hiddenLines(1)].sort()).toEqual([1, 2]);
    expect([...model.hiddenLines(2)]).toEqual([0]);
    const rows = model.overlaysOn(2)[0].rows;
    expect(rows).toHaveLength(2);
    expect([rows[0].dx, rows[0].dy]).toEqual([10 * U, (100 - 31) * U]);
  });

  it("never lets an older paragraph result replace a newer one", () => {
    const model = setup();
    model.applyParagraph(5, dl([line(0, 7)], "paragraph"), [frag(1, [10], [112])], 6);
    expect(model.applyParagraph(5, dl([line(0, 9)], "paragraph"), [frag(1, [10], [112])], 4).size).toBe(0);
    expect(model.overlays.get(5)?.revision).toBe(6);
  });

  it("drops live rows the PDF or a layout already holds, and re-anchors newer ones", () => {
    const model = setup();
    model.applyParagraph(5, dl([line(0, 7)], "paragraph"), [frag(1, [10], [112])], 3);
    model.applyParagraph(6, dl([line(0, 9)], "paragraph"), [frag(1, [10], [100])], 5);
    model.applyLayout({ pages: [], pagesTotal: 2, placements: [{ par_id: 6, fragments: [frag(2, [20], [300])], lines: 1, kind: "par" }], revision: 4, layoutVersion: 2, hasFallback: false });
    expect([...model.overlays.keys()]).toEqual([6]);
    expect(model.overlays.get(6)?.fragments[0].baselines).toEqual([300 * U]);
    model.setBase(5);
    expect(model.overlays.size).toBe(0);
  });

  it("knows when pagination has caught up with the text and the PDF", () => {
    const model = setup();
    expect(model.paginationSettled(1, 2)).toBe(true);
    // An edit rtex has not laid out yet.
    expect(model.paginationSettled(2, 2)).toBe(false);
    model.applyLayout({ pages: [page(3, [line(10, 100)])], pagesTotal: 3, placements, revision: 2, layoutVersion: 2, hasFallback: false });
    // The PDF on screen has two pages; rtex's newer layout has three.
    expect(model.paginationSettled(2, 2)).toBe(false);
    model.setBase(2);
    expect(model.paginationSettled(2, 3)).toBe(true);
  });

  it("extends rows past the placement on its last page", () => {
    const rows = [line(0, 10), line(0, 22), line(0, 34)];
    const fragments = reanchor([frag(3, [50, 50], [200, 212])], rows);
    expect(fragments).toHaveLength(1);
    expect(fragments[0].baselines).toEqual([200 * U, 212 * U, 224 * U]);
    expect(fragments[0].approximate).toBe(true);
  });
});
