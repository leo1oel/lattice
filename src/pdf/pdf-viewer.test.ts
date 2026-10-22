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
  const style = document.createElement("style")
  style.textContent = String(readFileSync("src/pdf/pdf-viewer.css", "utf8"))
  document.head.append(style)
  const rules = [...style.sheet!.cssRules].filter((rule): rule is CSSStyleRule => "selectorText" in rule)
  document.body.innerHTML = `<div class="pdf-scroll-area-viewport pdfSlick"></div>`
  const viewport = document.querySelector<HTMLElement>(".pdf-scroll-area-viewport")!
  /** The value the last rule matching `element` gives `property`. */
  const declared = (element: Element, property: string) => rules
    .filter((rule) => element.matches(rule.selectorText))
    .map((rule) => rule.style.getPropertyValue(property))
    .filter(Boolean)
    .at(-1) ?? null

  // PDF.js scales a fitted page to `container.clientWidth`, which counts
  // padding but not a border, and `removePageBorders` stops it from reserving
  // anything for the scrollbar. Padding here made every "fit width" page
  // exactly the horizontal inset too wide, so the pane always had a sideways
  // scrollbar it could never satisfy. SyncTeX maps clicks through the same
  // page geometry, so the gutter must stay a border.
  it("insets the pages with a border so a fitted page still fits", () => {
    expect(declared(viewport, "border")).toBe("var(--space-4) solid transparent")
    expect(declared(viewport, "box-sizing")).toBe("border-box")
    for (const side of ["padding", "padding-left", "padding-right", "padding-top", "padding-bottom"]) {
      expect(declared(viewport, side)).toBeNull()
    }
  })

  // PDFSlick styles this same element through `.pdfSlick`, so the override has
  // to out-specify it instead of relying on which chunk loads last.
  it("leaves its scrollbar to the Lattice overlay bars", () => {
    const scrollbarRules = rules.filter((rule) => viewport.matches(rule.selectorText) && rule.style.getPropertyValue("scrollbar-width"))
    expect(scrollbarRules.map((rule) => [rule.selectorText, rule.style.getPropertyValue("scrollbar-width")]))
      .toEqual([[".pdf-scroll-area-viewport.pdfSlick", "none"]])
    const webkitBar = rules.find((rule) => rule.selectorText === ".pdf-scroll-area-viewport::-webkit-scrollbar")
    expect(webkitBar?.style.getPropertyValue("display")).toBe("none")
  })
})

describe("PDF selection highlight", () => {
  // The page is paper in both themes; the dark theme's graphite accent is
  // near white, so a highlight in the accent did not show on it.
  it("draws in a color that shows on the paper page in either theme", () => {
    const css = String(readFileSync("src/pdf/pdf-viewer.css", "utf8"))
    const tint = /\.pdf-sel-rect \{[^}]*background: color-mix\(in srgb, var\((--[\w-]+)\)/.exec(css)?.[1]
    expect(tint).toBe("--editor-selection-tint")
    expect(String(readFileSync("src/styles/foundations.css", "utf8"))).toMatch(new RegExp(`${tint}: #[0-9a-f]{6};`))
    expect(String(readFileSync("src/styles/theme.css", "utf8"))).not.toContain(`${tint}:`)
  })

  it("stays over a live-preview page painted before pdf.js appended the text layer", () => {
    // The order the stylesheets reach the document in: the eager PDF sheet
    // (pdf-loading.tsx) and the live preview's before PDFSlick's lazy chunk.
    // jsdom cannot parse PDFSlick's nested CSS, so its text layer rule stands
    // in for that sheet.
    const styles = [
      readFileSync("src/pdf/pdf-viewer.css", "utf8"),
      readFileSync("src/live-preview/live-preview.css", "utf8"),
      ".textLayer { position: absolute; inset: 0; z-index: 0; }",
    ].map((css) => {
      const style = document.createElement("style")
      style.textContent = css
      return document.head.appendChild(style)
    })
    // What the live preview's first draw of a page leaves (live-preview-layer.tsx):
    // pdf.js inserts the text layer, once its text has streamed in, right
    // after its own canvas, so the paper canvas appended before then comes
    // after it in the tree.
    document.body.innerHTML = `<div class="pdf-preview"><div class="pdfViewer"><div class="page latticeLayered">
      <div class="canvasWrapper"><canvas></canvas></div>
      <div class="textLayer pdf-text-layer has-selection"><span>Selected</span><div class="pdf-sel-rect"></div></div>
      <div class="annotationLayer"></div>
      <canvas class="live-preview-page-layer"></canvas>
    </div></div></div>`
    const zIndex = (selector: string) => Number(getComputedStyle(document.querySelector(selector)!).zIndex)
    const paper = zIndex("canvas.live-preview-page-layer")
    // Equal z-indexes paint in tree order, which would put the paper on top.
    expect(zIndex(".textLayer")).toBeGreaterThan(paper)
    expect(zIndex(".annotationLayer")).toBeGreaterThan(paper)
    for (const style of styles) style.remove()
  })
})
