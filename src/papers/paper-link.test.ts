import { describe, expect, it } from "vitest";
import { paperLinkHref, paperReadingPath, parsePaperLinkPath, isPaperLibraryPath } from "./paper-link";

const attention = { arxivId: "1706.03762", hasFullText: true };

describe("paperReadingPath", () => {
  it("prefers the full text and falls back to the overview", () => {
    expect(paperReadingPath(attention)).toBe(".research/papers/1706.03762/paper.md");
    expect(paperReadingPath({ ...attention, hasFullText: false })).toBe(".research/papers/1706.03762/blog.md");
  });
});

describe("paperLinkHref", () => {
  it.each([
    ["stays root-relative for a note at the project root", "notes.md", ".research/papers/1706.03762/paper.md"],
    ["climbs out of the note's directory", "notes/deep/idea.md", "../../.research/papers/1706.03762/paper.md"],
  ])("%s", (_, activePath, href) => expect(paperLinkHref(activePath, attention)).toBe(href));

  it.each(["a.md", "a/b.md", "a/b/c.md"])("round-trips through parsePaperLinkPath from %s", (activePath) => {
    const href = paperLinkHref(activePath, { arxivId: "2010.11929", hasFullText: false });
    // Resolve the way resolveProjectLink does: relative to the note's dir.
    const parts = activePath.split("/").slice(0, -1);
    for (const part of href.split("/")) {
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    expect(parsePaperLinkPath(parts.join("/"))).toEqual({ arxivId: "2010.11929", view: "blog" });
  });
});

describe("isPaperLibraryPath", () => {
  it.each([
    [".research/papers", true],
    [".research/papers/1706.03762/paper.md", true],
    [".research/papers/1706.03762/paper_assets/figure.png", true],
    // A root-level manuscript and other research files are not cached bundles.
    ["paper.md", false],
    [".research/editor-comments.json", false],
    ["references.bib", false],
  ])("%s -> %s", (path, expected) => expect(isPaperLibraryPath(path)).toBe(expected));
});

describe("parsePaperLinkPath", () => {
  it.each([
    [".research/papers/1706.03762/paper.md", { arxivId: "1706.03762", view: "fulltext" }],
    [".research/papers/1706.03762/blog.md", { arxivId: "1706.03762", view: "blog" }],
    // Other project and paper-adjacent paths are ignored.
    ["main.tex", null],
    ["papers/1706.03762/paper.md", null],
    [".research/papers/1706.03762/metadata.json", null],
    [".research/papers/1706.03762/assets/figure.png", null],
    [".research/papers/a/b/paper.md", null],
  ])("%s", (path, expected) => expect(parsePaperLinkPath(path)).toEqual(expected));
});
