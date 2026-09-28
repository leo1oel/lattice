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

  it("preserves balanced and TeX-escaped braces in modeled fields", () => {
    expect(formatBibEntry({
      type: "misc",
      key: "protected",
      title: "The {{NASA}} Set \\{x\\} {Study}",
      author: "{{World Health Organization}} and Doe, Jane",
      year: "2026",
      note: "Drops unmatched } closing and { opening safely",
    })).toBe(`@misc{protected,
  title = {The {{NASA}} Set \\{x\\} {Study}},
  author = {{{World Health Organization}} and Doe, Jane},
  year = {2026},
  note = {Drops unmatched  closing and  opening safely}
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

    for (const field of ["title = {Edited title}", "eprint = {2601.01234}", "archiveprefix = {arXiv}", "pages = {1--10}",
      "note = {Keep {NASA}}", "howpublished = {\\url{https://example.org}}"]) expect(formatted).toContain(field);
    for (const stale of ["Stale title", "Removed journal"]) expect(formatted).not.toContain(stale);
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

  it("rejects duplicate citation keys without renaming a key used by the caller", () => {
    const old = "@article{Smith2025,title={Chemistry}}@book{other,title={Other}}";
    expect(() => appendBibEntry(old, "@article{smith2025,title={Geometry}}"))
      .toThrow("already exists");
    expect(() => appendBibEntry("@book{x,title={Unfinished}", "@book{new,title={New}}"))
      .toThrow("unfinished");
  });

  it("does not treat commented entries or at-signs inside titles as citation keys", () => {
    const old = "% @book{new,title={Comment}}\n@comment{ @book{new,title={Comment}} }\n@book{old,title={Example @book{new,title={Nested}}}}";
    const entry = "@article(new,title={New})";
    expect(appendBibEntry(old, entry)).toContain(entry);
  });
});
