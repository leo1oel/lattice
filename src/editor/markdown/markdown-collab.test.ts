import { describe, expect, it } from "vitest";
import {
  canonicalizeSupportedMarkdown,
  minimalMarkdownPatch,
  preserveMarkdownEnvelope,
  rebaseMarkdownDraft,
} from "./markdown-collab";

describe("Markdown collaboration patches", () => {
  it("produces a minimal replacement", () => {
    expect(minimalMarkdownPatch("alpha beta omega", "alpha BETA omega"))
      .toEqual({ from: 6, to: 10, insert: "BETA" });
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

  it("uses UTF-16 offsets for minimal patches around astral characters", () => {
    expect(minimalMarkdownPatch("😀 alpha omega", "😀 ALPHA omega")).toEqual({ from: 3, to: 8, insert: "ALPHA" });
  });

  it("canonicalizes represented GFM table formatting without touching surrounding source", () => {
    const compact = "Authored  prose\n\n| A | B |\n| :--- | ---: |\n| x | y |";
    const padded = "Authored  prose\n\n| A   | B   |\n| :---- | ----: |\n| x   | y   |";
    expect(canonicalizeSupportedMarkdown(compact)).toBe(canonicalizeSupportedMarkdown(padded));
    expect(canonicalizeSupportedMarkdown("Authored prose")).not.toBe(
      canonicalizeSupportedMarkdown("Authored  prose"),
    );
  });

  it("treats a harmless escaped prose period as equivalent", () => {
    expect(canonicalizeSupportedMarkdown("Use w.r.t. here.")).toBe(
      canonicalizeSupportedMarkdown("Use w\\.r.t. here."),
    );
  });

  it("does not mistake setext headings or thematic breaks for one-column tables", () => {
    expect(canonicalizeSupportedMarkdown("Setext heading\n---")).toBe("Setext heading\n---");
    expect(canonicalizeSupportedMarkdown("Prose\n\n---\n\nMore")).toBe("Prose\n\n---\n\nMore");
    expect(canonicalizeSupportedMarkdown("Escaped \\| pipe\n---")).toBe("Escaped \\| pipe\n---");
    // A real one-column table still canonicalizes because its header has a pipe.
    const table = "| A |\n| --- |\n| x |";
    expect(canonicalizeSupportedMarkdown(table)).toContain("@@GFM_TABLE:");
  });

  it("preserves BOM, CRLF, and all trailing blank lines", () => {
    expect(preserveMarkdownEnvelope("Changed\n", "\uFEFFOriginal\r\n\r\n"))
      .toBe("\uFEFFChanged\r\n\r\n");
  });
});
