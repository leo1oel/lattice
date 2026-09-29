/**
 * Heading slugs (spec R-BLK-13, R-INL-6): the rule the paper converter writes
 * Contents links with, and duplicate suffixes in document order.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { describe, expect, it } from "vitest";
import { createHeadingSlugger, headingSlug } from "./heading-slug";

describe("heading slugs", () => {
  it.each([
    ["Document title", "document-title"],
    ["  Results & Discussion!  ", "results-discussion"],
    ["Café Übersicht", "cafe-ubersicht"],
    ["3.2 Scaling laws (v2)", "3-2-scaling-laws-v2"],
    ["量子计算研究", "量子计算研究"],
    ["---", ""],
  ])("slugs %j as %j", (text, slug) => {
    expect(headingSlug(text)).toBe(slug);
  });

  it("tells repeated headings apart in document order and gives none to a heading without letters", () => {
    const slug = createHeadingSlugger();
    expect(["Repeat", "Repeat", "Other", "Repeat", "***"].map(slug)).toEqual(["repeat", "repeat-1", "other", "repeat-2", ""]);
  });
});
