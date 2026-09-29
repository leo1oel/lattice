import { describe, expect, it } from "vitest";
import { exactVisualSourceRanges } from "./visual-source-map";

const slices = (text: string, blockCount: number) => (
  exactVisualSourceRanges(text, blockCount)?.map(({ from, to }) => text.slice(from, to)) ?? null
);

describe("exact visual source ranges", () => {
  it("answers for the text it is given, not the previous answer", () => {
    const before = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
    const after = "# Title\n\nFirst paragraph, edited.\n\nSecond paragraph.\n";
    expect(slices(before, 3)).toEqual(["# Title", "First paragraph.", "Second paragraph."]);
    expect(slices(after, 3)).toEqual(["# Title", "First paragraph, edited.", "Second paragraph."]);
    // Asked again, the first text still maps to its own offsets.
    expect(slices(before, 3)).toEqual(["# Title", "First paragraph.", "Second paragraph."]);
  });

  it("checks the rendered block count on every call", () => {
    const text = "One.\n\nTwo.\n";
    expect(exactVisualSourceRanges(text, 2)).not.toBeNull();
    expect(exactVisualSourceRanges(text, 3)).toBeNull();
    expect(exactVisualSourceRanges(text, 2)).not.toBeNull();
  });

  it("keeps rejecting ambiguous documents once their blocks are memoized", () => {
    const unmappable = "<!-- c -->\n\n[^n]: First paragraph.\n\n  Not a continuation.\n";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (let blocks = 0; blocks <= 4; blocks += 1) expect(exactVisualSourceRanges(unmappable, blocks)).toBeNull();
    }
  });
});
