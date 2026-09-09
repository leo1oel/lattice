import { describe, expect, it } from "vitest";
import {
  normalizePdfSelection,
  parsePdfZoomPercent,
  pdfSlickTranslationId,
} from "./pdf-viewer-utils";

describe("PDF viewer helpers", () => {
  it.each([
    ["document_properties_page_size_orientation_portrait", "pdfjs-document-properties-page-size-orientation-portrait"],
    ["document_properties_page_size_orientation_landscape", "pdfjs-document-properties-page-size-orientation-landscape"],
    ["document_properties_page_size_unit_inches", "pdfjs-document-properties-page-size-unit-inches"],
    ["document_properties_page_size_unit_millimeters", "pdfjs-document-properties-page-size-unit-millimeters"],
    ["document_properties_page_size_name_letter", "pdfjs-document-properties-page-size-name-letter"],
    ["document_properties_page_size_name_legal", "pdfjs-document-properties-page-size-name-legal"],
    ["document_properties_page_size_name_a3", "pdfjs-document-properties-page-size-name-a-three"],
    ["document_properties_page_size_name_a4", "pdfjs-document-properties-page-size-name-a-four"],
    ["pdfjs-find-match-count", "pdfjs-find-match-count"],
  ])("maps PDFSlick's %s to the current Fluent ID", (legacy, current) => {
    expect(pdfSlickTranslationId(legacy)).toBe(current);
  });

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
