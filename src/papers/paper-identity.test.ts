import { describe, expect, it } from "vitest";
import { paperAuthorNames, paperShortAuthors, paperSourceLabel } from "./paper-identity";

describe("paper identity", () => {
  it("reads BibTeX authors as people, in order", () => {
    expect(paperAuthorNames({ authors: "Vaswani, Ashish and Gomez, Aidan N. and {Google Brain}" }))
      .toEqual(["Ashish Vaswani", "Aidan N. Gomez", "Google Brain"]);
    expect(paperAuthorNames({ authors: "Ashish Vaswani AND Noam Shazeer and others" })).toEqual(["Ashish Vaswani", "Noam Shazeer"]);
    expect(paperAuthorNames({ authors: "von Neumann, Jr, John" })).toEqual(["John von Neumann"]);
    expect(paperAuthorNames({ authors: "  " })).toEqual([]);
    expect(paperAuthorNames({})).toEqual([]);
  });

  it("shortens authors to surnames", () => {
    expect(paperShortAuthors({ authors: "Vaswani, Ashish" })).toBe("Vaswani");
    expect(paperShortAuthors({ authors: "张三" })).toBe("张三");
    expect(paperShortAuthors({ authors: "Ashish Vaswani and Noam Shazeer" })).toBe("Vaswani and Shazeer");
    expect(paperShortAuthors({ authors: "Vaswani, Ashish and Shazeer, Noam and Parmar, Niki" })).toBe("Vaswani et al.");
    expect(paperShortAuthors({ authors: "Vaswani, Ashish and others" })).toBe("Vaswani et al.");
    expect(paperShortAuthors({ authors: "{Gemini Team} and others" })).toBe("Gemini Team et al.");
    expect(paperShortAuthors({ authors: "{Google Brain}" })).toBe("Google Brain");
    expect(paperShortAuthors({ authors: "{Barnes, Noble} and {van} Rossum, Guido" })).toBe("Barnes, Noble and van Rossum");
    expect(paperShortAuthors({ authors: undefined })).toBeNull();
  });

  // Exactly what `list_papers` delivers for these entries (pinned by the Rust
  // test `lists_authors_with_the_braces_that_group_a_corporate_name`): only
  // the braces say an organisation is one name, and an "and" inside them
  // separates nothing.
  it.each([
    ["{Gemini Team} and others", "Gemini Team et al.", ["Gemini Team"]],
    ["{Google Brain}", "Google Brain", ["Google Brain"]],
    ["{Research and Development Institute} and Doe, Jane", "Research and Development Institute and Doe", ["Research and Development Institute", "Jane Doe"]],
    ["{AT&T} and Borel, Émile", "AT&T and Borel", ["AT&T", "Émile Borel"]],
  ])("keeps the corporate author in %s whole", (authors, short, names) => {
    expect(paperShortAuthors({ authors })).toBe(short);
    expect(paperAuthorNames({ authors })).toEqual(names);
  });

  it("names a source only from what the entry records", () => {
    expect(paperSourceLabel({ arxivId: "1706.03762v7" })).toBe("arXiv 1706.03762v7");
    expect(paperSourceLabel({ arxivId: "hep-th/9901001" })).toBe("arXiv hep-th/9901001");
    expect(paperSourceLabel({ arxivId: "", doi: "10.1000/xyz", url: "https://doi.org/10.1000/xyz" })).toBe("DOI 10.1000/xyz");
    expect(paperSourceLabel({ arxivId: "web-0123", url: "https://www.example.org/a" })).toBe("example.org");
    expect(paperSourceLabel({ arxivId: "web-0123", url: "file:///etc/passwd" })).toBeNull();
    expect(paperSourceLabel({ arxivId: "web-0123" })).toBeNull();
  });
});
