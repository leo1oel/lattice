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
