import { describe, expect, it } from "vitest";
import { minimalMarkdownPatch, rebaseMarkdownDraft } from "./markdown-collab";

describe("Markdown collaboration patches", () => {
  it("produces a minimal replacement in UTF-16 offsets, around astral characters too", () => {
    expect(minimalMarkdownPatch("alpha beta omega", "alpha BETA omega"))
      .toEqual({ from: 6, to: 10, insert: "BETA" });
    expect(minimalMarkdownPatch("😀 alpha omega", "😀 ALPHA omega")).toEqual({ from: 3, to: 8, insert: "ALPHA" });
  });

  it.each([
    ["non-overlapping source and visual edits", "alpha beta omega", "ALPHA beta omega", "alpha beta OMEGA", "ALPHA beta OMEGA"],
    ["adjacent replacements", "abcd", "aBcd", "abcD", "aBcD"],
    ["UTF-16 offsets around astral characters", "😀 alpha omega", "😀 ALPHA omega", "😀 alpha OMEGA", "😀 ALPHA OMEGA"],
    // Refusals let the caller preserve the draft.
    ["overlapping edits", "alpha beta", "alpha local", "alpha remote", null],
    ["same-boundary insertions", "ab", "aLocalb", "aRemoteb", null],
  ])("rebases (or refuses) %s", (_name, base, draft, canonical, expected) => {
    expect(rebaseMarkdownDraft(base, draft, canonical)).toBe(expected);
  });
});
