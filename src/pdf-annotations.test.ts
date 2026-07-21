import { describe, expect, it } from "vitest";
import {
  createPdfMark,
  markAnchorPoint,
  pdfMarkFill,
  selectionRectsInPage,
} from "./pdf-annotations";

describe("pdf annotations helpers", () => {
  it("creates marks from a selection draft", () => {
    const mark = createPdfMark(
      {
        text: "Attention is all you need",
        page: 2,
        rects: [{ x1: 10, y1: 20, x2: 120, y2: 34 }],
      },
      "note",
      "green",
      "Check claim",
    );
    expect(mark.kind).toBe("note");
    expect(mark.page).toBe(2);
    expect(mark.color).toBe("green");
    expect(mark.note).toBe("Check claim");
    expect(mark.text).toContain("Attention");
    expect(mark.id).toBeTruthy();
  });

  it("maps colors and anchor points", () => {
    expect(pdfMarkFill("pink")).toContain("255");
    expect(markAnchorPoint({
      id: "1",
      kind: "highlight",
      page: 3,
      rects: [{ x1: 0, y1: 10, x2: 40, y2: 30 }],
      color: "yellow",
      text: "x",
      note: "",
      createdAt: "",
    })).toEqual({ page: 3, x: 20, y: 20 });
  });

  it("converts client rects into page-space quads", () => {
    const page = document.createElement("div");
    page.getBoundingClientRect = () => ({
      x: 100,
      y: 200,
      left: 100,
      top: 200,
      right: 700,
      bottom: 1000,
      width: 600,
      height: 800,
      toJSON() {
        return {};
      },
    });
    const range = {
      getClientRects: () => [{
        x: 140,
        y: 260,
        left: 140,
        top: 260,
        right: 220,
        bottom: 280,
        width: 80,
        height: 20,
        toJSON() {
          return {};
        },
      }] as unknown as DOMRectList,
    } as Range;
    expect(selectionRectsInPage(range, page, 2)).toEqual([{
      x1: 20,
      y1: 30,
      x2: 60,
      y2: 40,
    }]);
  });
});
