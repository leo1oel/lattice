import { describe, expect, it } from "vitest";
import {
  normalizePdfSelection,
  parsePdfZoomPercent,
} from "./pdf-viewer-utils";

describe("PDF viewer helpers", () => {
  it("normalizes PDF text-layer selections for agent context", () => {
    expect(normalizePdfSelection("  Attention\u00a0is\nall   you need.  ")).toBe("Attention is all you need.");
    expect(normalizePdfSelection("\n\t")).toBe("");
  });

  it("accepts directly entered zoom percentages and bounds them", () => {
    expect(parsePdfZoomPercent("46")).toBe(0.46);
    expect(parsePdfZoomPercent(" 193% ")).toBe(1.93);
    expect(parsePdfZoomPercent("5")).toBe(0.3);
    expect(parsePdfZoomPercent("900")).toBe(5);
    expect(parsePdfZoomPercent("nope")).toBeNull();
  });
});
