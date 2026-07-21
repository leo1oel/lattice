import { describe, expect, it } from "vitest";
import { INSERT_GROUPS, INSERT_SNIPPETS } from "./insert-snippets";

describe("insert snippets", () => {
  it("covers every advertised group with labeled previews", () => {
    expect(INSERT_SNIPPETS.length).toBeGreaterThan(200);
    for (const group of INSERT_GROUPS) {
      const items = INSERT_SNIPPETS.filter((snippet) => snippet.group === group);
      expect(items.length, group).toBeGreaterThan(0);
      for (const snippet of items) {
        expect(snippet.label.trim()).not.toBe("");
        expect(snippet.detail.trim()).not.toBe("");
        expect(snippet.insert.trim()).not.toBe("");
        expect(Boolean(snippet.glyph || snippet.mathPreview || snippet.codePreview)).toBe(true);
      }
    }
  });

  it("keeps snippet ids unique", () => {
    const ids = INSERT_SNIPPETS.map((snippet) => snippet.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
