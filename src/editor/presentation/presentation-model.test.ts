import { describe, expect, it } from "vitest";
import { deleteSlide, insertSlideAfter, parsePresentation, slideSummary, updateFrontmatterSetting } from "./presentation-model";

describe("presentation model", () => {
  it("parses frontmatter, notes, separators, and exact offsets", () => {
    const source = "---\r\ntheme: midnight\r\ntransition: zoom\r\n---\r\n# One\r\nNotes:\r\nhello\r\n---\r\n# Two";
    const deck = parsePresentation(source);
    expect(deck).toMatchObject({ theme: "midnight", transition: "zoom" });
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0].body).toBe("# One");
    expect(deck.slides[0].notes).toBe("hello");
    expect(source.slice(deck.slides[1].start, deck.slides[1].end)).toBe("# Two");
  });

  it("does not split fenced code or treat leading YAML as a slide", () => {
    const deck = parsePresentation("---\ntheme: paper\n---\n# A\n```md\n---\n```\n---\n# B");
    expect(deck.slides).toHaveLength(2);
    expect(deck.slides[0].body).toContain("---");
  });

  it("does not treat notes markers inside mixed fenced code as speaker notes", () => {
    const deck = parsePresentation("# A\n```md\n~~~\nNotes:\ninside code\n```\nNotes:\nactual note");
    expect(deck.slides[0].body).toContain("inside code");
    expect(deck.slides[0].notes).toBe("actual note");
  });

  it("keeps malformed frontmatter usable and defaults invalid settings", () => {
    const deck = parsePresentation("---\ntheme: neon\n# Still content");
    expect(deck.theme).toBe("lattice");
    expect(deck.transition).toBe("fade");
    expect(deck.slides).toHaveLength(1);
  });

  it("always provides a slide for empty input", () => {
    expect(parsePresentation("").slides).toHaveLength(1);
    expect(slideSummary(parsePresentation("").slides[0]).title).toBe("Untitled slide");
  });

  it("keeps the heading out of the excerpt and identifies the first slide image", () => {
    const [slide] = parsePresentation([
      "## Next Slide",
      "",
      "A concise explanation.",
      "",
      "![Plot](../figures/plot.png)",
    ].join("\n")).slides;

    expect(slideSummary(slide)).toEqual({
      title: "Next Slide",
      excerpt: "A concise explanation.",
      imageSource: "../figures/plot.png",
    });
  });

  it("updates settings while preserving comments and unrelated YAML", () => {
    const source = "---\n# deck config\ntheme: paper # old\nauthor: Ada\n---\n# Talk";
    const changed = updateFrontmatterSetting(source, "theme", "midnight");
    expect(changed).toContain("# deck config");
    expect(changed).toContain("author: Ada");
    expect(changed).toContain("theme: midnight # old");
  });

  it("creates frontmatter and preserves CRLF", () => {
    expect(updateFrontmatterSetting("# Talk\r\n", "transition", "none")).toBe("---\r\ntransition: none\r\n---\r\n# Talk\r\n");
  });

  it("inserts after a known slide", () => {
    const next = insertSlideAfter("# A\n---\n# B", 0, "# New");
    expect(parsePresentation(next).slides.map((slide) => slide.body)).toEqual(["# A", "# New", "# B"]);
  });

  it("turns the implicit empty slide into the first authored slide", () => {
    const next = insertSlideAfter("", 0, "# New");
    expect(parsePresentation(next).slides.map((slide) => slide.body)).toEqual(["# New"]);
  });

  it("deletes first, middle, and last slides without damaging frontmatter", () => {
    const source = "---\ntheme: paper\n---\n# One\n---\n# Two\n---\n# Three\n";
    expect(parsePresentation(deleteSlide(source, 0)).slides.map((slide) => slide.body))
      .toEqual(["# Two", "# Three"]);
    expect(parsePresentation(deleteSlide(source, 1)).slides.map((slide) => slide.body))
      .toEqual(["# One", "# Three"]);
    const withoutLast = deleteSlide(source, 2);
    expect(parsePresentation(withoutLast).slides.map((slide) => slide.body)).toEqual(["# One", "# Two"]);
    expect(withoutLast).toContain("theme: paper");
  });

  it("keeps the only slide rather than leaving an unusable empty deck", () => {
    expect(deleteSlide("# Only slide\n", 0)).toBe("# Only slide\n");
  });
});
