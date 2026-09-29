/**
 * Paths written in a document, resolved into the project.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { describe, expect, it } from "vitest";
import { documentRelativeProjectPath } from "./document-relative-path";

describe("documentRelativeProjectPath", () => {
  it.each([
    ["paper_assets/figure-001.webp", ".research/papers/2010.11929/paper.md", ".research/papers/2010.11929/paper_assets/figure-001.webp"],
    ["../figures/My Plot.png", "notes/method.md", "figures/My Plot.png"],
    ["./a/./b.png?raw#top", "notes.md", "a/b.png"],
    ["/figures/root.png", "notes/deep/method.md", "figures/root.png"],
    ["..\\figures\\win.png", "notes/method.md", "figures/win.png"],
    ["../../figure.png", "notes/method.md", null],
    ["https://example.com/figure.png", "notes.md", null],
    ["//cdn.example.com/figure.png", "notes.md", null],
    ["data:image/png;base64,AAAA", "notes.md", null],
    ["", "notes.md", null],
  ])("resolves %j from %j to %j", (path, document, expected) => {
    expect(documentRelativeProjectPath(path, document)).toBe(expected);
  });
});
