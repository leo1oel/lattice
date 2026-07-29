import { describe, expect, it } from "vitest";
import {
  annotationBounds,
  findPdfMatches,
  fitPdfScale,
  normalizePdfSelection,
  parsePdfZoomPercent,
  pdfRenderPixelRatio,
} from "./pdf-viewer-utils";

describe("PDF viewer helpers", () => {
  it("normalizes PDF text-layer selections for agent context", () => {
    expect(normalizePdfSelection("  Attention\u00a0is\nall   you need.  ")).toBe("Attention is all you need.");
    expect(normalizePdfSelection("\n\t")).toBe("");
  });

  it("finds every case-insensitive occurrence across pages", () => {
    expect(findPdfMatches(
      ["Attention is all you need. Attention scales.", "No match.", "attention again"],
      "ATTENTION",
    )).toEqual([
      { page: 1, occurrence: 0 },
      { page: 1, occurrence: 1 },
      { page: 3, occurrence: 0 },
    ]);
    expect(findPdfMatches(["text"], "   ")).toEqual([]);
  });

  it("normalizes and scales annotation rectangles", () => {
    expect(annotationBounds([30, 50, 10, 20], 2)).toEqual({
      left: 20,
      top: 40,
      width: 40,
      height: 60,
    });
    expect(annotationBounds([0, 0, Number.NaN, 10], 1)).toBeNull();
  });

  it("supersamples PDF pages on low-DPI displays without over-scaling", () => {
    expect(pdfRenderPixelRatio(1)).toBe(2);
    expect(pdfRenderPixelRatio(1.5)).toBe(2);
    expect(pdfRenderPixelRatio(2)).toBe(2);
    expect(pdfRenderPixelRatio(3)).toBe(2.5);
  });

  it("computes fit-to-width and fit-to-height scales", () => {
    expect(fitPdfScale("width", { width: 600, height: 800 }, { width: 648, height: 400 }, { x: 48, y: 40 }))
      .toBe(1);
    expect(fitPdfScale("height", { width: 600, height: 800 }, { width: 1248, height: 1240 }, { x: 48, y: 40 }))
      .toBe(1.5);
    expect(fitPdfScale("width", { width: 100, height: 100 }, { width: 1000, height: 1000 }))
      .toBe(5);
    expect(fitPdfScale("height", { width: 600, height: 800 }, { width: 200, height: 200 }))
      .toBe(0.3);
  });

  it("accepts directly entered zoom percentages and bounds them", () => {
    expect(parsePdfZoomPercent("46")).toBe(0.46);
    expect(parsePdfZoomPercent(" 193% ")).toBe(1.93);
    expect(parsePdfZoomPercent("5")).toBe(0.3);
    expect(parsePdfZoomPercent("900")).toBe(5);
    expect(parsePdfZoomPercent("nope")).toBeNull();
  });
});
