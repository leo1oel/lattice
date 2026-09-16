// Vitest empties CSS imports, so read the stylesheet off disk.
import { readFileSync } from "node:fs";
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

describe("PDF scroll viewport", () => {
  const viewerCss = String(readFileSync("src/pdf/pdf-viewer.css", "utf8"))
  const viewport = /\.pdf-scroll-area-viewport \{[^}]*\}/.exec(viewerCss)?.[0] ?? ""

  // PDF.js scales a fitted page to `container.clientWidth`, which counts
  // padding but not a border, and `removePageBorders` stops it from reserving
  // anything for the scrollbar. Padding here made every "fit width" page
  // exactly the horizontal inset too wide, so the pane always had a sideways
  // scrollbar it could never satisfy.
  it("insets the pages with a border so a fitted page still fits", () => {
    expect(viewport).toContain("border: var(--space-10) solid transparent")
    expect(viewport).toContain("box-sizing: border-box")
    expect(viewport).not.toContain("padding")
  })

  // PDFSlick styles this same element through `.pdfSlick`, so the override has
  // to out-specify it instead of relying on which chunk loads last.
  it("leaves its scrollbar to the Lattice overlay bars", () => {
    expect(viewport).not.toContain("scrollbar-width")
    expect(viewerCss).toContain(".pdf-scroll-area-viewport.pdfSlick { scrollbar-width: none; }")
    expect(viewerCss).toContain(".pdf-scroll-area-viewport::-webkit-scrollbar { display: none;")
  })
})
