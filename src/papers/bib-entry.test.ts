import { describe, expect, it } from "vitest";
import { appendBibEntry, formatBibEntry, slugifyCitationKey } from "./bib-entry";

describe("bibliography entry drafting", () => {
  it("slugifies a citation key from author, year, and title", () => {
    expect(slugifyCitationKey("Attention Is All You Need", "Vaswani, Ashish", "2017"))
      .toBe("vaswani2017attention");
  });

  it("formats a BibTeX article with required fields", () => {
    expect(formatBibEntry({
      type: "article",
      key: "vaswani2017attention",
      title: "Attention Is All You Need",
      author: "Vaswani, Ashish",
      year: "2017",
      journal: "NeurIPS",
    })).toBe(`@article{vaswani2017attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish},
  year = {2017},
  journal = {NeurIPS}
}
`);
  });

  it("preserves extra fields without allowing modeled fields to reappear", () => {
    const formatted = formatBibEntry({
      type: "article",
      key: "paper",
      title: "Edited title",
      author: "Author",
      year: "2026",
      extraFields: {
        eprint: "2601.01234",
        archiveprefix: "arXiv",
        pages: "1--10",
        note: "Keep {NASA}",
        howpublished: "\\url{https://example.org}",
        title: "Stale title",
        journal: "Removed journal",
      },
    });

    expect(formatted).toContain("title = {Edited title}");
    expect(formatted).toContain("eprint = {2601.01234}");
    expect(formatted).toContain("archiveprefix = {arXiv}");
    expect(formatted).toContain("pages = {1--10}");
    expect(formatted).toContain("note = {Keep {NASA}}");
    expect(formatted).toContain("howpublished = {\\url{https://example.org}}");
    expect(formatted).not.toContain("Stale title");
    expect(formatted).not.toContain("Removed journal");
  });

  it("appends an entry with a blank line separator", () => {
    expect(appendBibEntry("@misc{a,\n  title = {A}\n}\n", "@misc{b,\n  title = {B}\n}\n"))
      .toBe(`@misc{a,
  title = {A}
}

@misc{b,
  title = {B}
}
`);
  });
});
