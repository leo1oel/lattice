import { describe, expect, it, vi } from "vitest";
import { findQuoteInPages, quoteAnchorsIn } from "./pdf-quote-page";

vi.mock("./pdfjs-runtime", () => ({ getDocument: vi.fn() }));

/** A PDF.js document whose pages hold these lines, one text run per line. */
const documentOf = (pages: string[][]) => ({
  numPages: pages.length,
  getPage: async (number: number) => ({
    getTextContent: async () => ({ items: pages[number - 1].map((line) => ({ str: line, hasEOL: true })) }),
  }),
});

describe("finding a full-text passage in the PDF", () => {
  const quote = "We propose a new simple network architecture, the Transformer, based solely on attention mechanisms";

  it("names the page that holds it, across the PDF's line breaks and hyphenation", async () => {
    const pdf = documentOf([
      ["Attention Is All You Need", "Abstract"],
      ["The dominant sequence transduction models are complex. We propose a new", "simple network architecture, the Trans-", "former, based solely on attention mechanisms, dispensing", "with recurrence."],
    ]);
    await expect(findQuoteInPages(pdf, quote)).resolves.toEqual({ page: 2, first: "We propose a new", last: "solely on attention mechanisms" });
  });

  it("grows the anchors until they find only this passage on its page", () => {
    const page = "We propose a new loss. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.";
    const anchors = quoteAnchorsIn(page, quote)!;
    expect(anchors.first).not.toBe("We propose a new");
    expect(page.indexOf(anchors.first)).toBeGreaterThan(0);
  });

  it("finds nothing for a passage the PDF does not hold", async () => {
    await expect(findQuoteInPages(documentOf([["Something else entirely"]]), quote)).resolves.toBeNull();
  });
});
