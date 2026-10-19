import { describe, expect, it } from "vitest";
import { modeOnLoad, rememberedViewMode, setsDocumentMode, type RememberedViewModes } from "./document-view-modes";

const modes = (overrides: Partial<RememberedViewModes> = {}): RememberedViewModes => ({
  html: new Map([["site/chosen.html", "split"]]), bib: "source", document: "pdf", ...overrides,
});

describe("document view modes", () => {
  it("opens each readable kind in the view last chosen for it", () => {
    expect(rememberedViewMode("notes.md", modes())).toBe("pdf");
    expect(rememberedViewMode("main.tex", modes({ document: "split" }))).toBe("split");
    expect(rememberedViewMode("references.bib", modes({ bib: "pdf" }))).toBe("pdf");
    expect(rememberedViewMode("site/chosen.html", modes())).toBe("split");
    expect(rememberedViewMode("site/page.html", modes())).toBe("pdf");
    expect(rememberedViewMode("data.csv", modes())).toBeNull();
  });

  it("keeps or widens the canvas for a document with one view", () => {
    expect(modeOnLoad("notes.txt", "main.tex", "split", true, modes())).toBe("source");
    expect(modeOnLoad("notes.txt", "main.tex", "split", false, modes())).toBe("split");
    expect(modeOnLoad("notes.txt", "figure.png", "asset", false, modes())).toBe("split");
    expect(modeOnLoad("notes.txt", "page.html", "pdf", false, modes({ document: "source" }))).toBe("source");
    expect(modeOnLoad("notes.md", "page.html", "split", true, modes())).toBe("pdf");
  });

  it("remembers LaTeX and Markdown views, never an HTML file's or an asset's", () => {
    expect(setsDocumentMode("notes.md", "pdf")).toBe(true);
    expect(setsDocumentMode("main.tex", "split")).toBe(true);
    expect(setsDocumentMode("page.html", "pdf")).toBe(false);
    expect(setsDocumentMode("notes.md", "asset")).toBe(false);
    expect(setsDocumentMode("references.bib", "pdf")).toBe(false);
  });
});
