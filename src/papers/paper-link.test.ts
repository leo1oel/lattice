import { describe, expect, it } from "vitest";
import { paperLinkHref, paperReadingPath, parsePaperLinkPath } from "./paper-link";

describe("paperReadingPath", () => {
  it("prefers the full text and falls back to the overview", () => {
    expect(paperReadingPath({ arxivId: "1706.03762", hasFullText: true }))
      .toBe(".research/papers/1706.03762/paper.md");
    expect(paperReadingPath({ arxivId: "1706.03762", hasFullText: false }))
      .toBe(".research/papers/1706.03762/blog.md");
  });
});

describe("paperLinkHref", () => {
  it("stays root-relative for a note at the project root", () => {
    expect(paperLinkHref("notes.md", { arxivId: "1706.03762", hasFullText: true }))
      .toBe(".research/papers/1706.03762/paper.md");
  });

  it("climbs out of the note's directory", () => {
    expect(paperLinkHref("notes/deep/idea.md", { arxivId: "1706.03762", hasFullText: true }))
      .toBe("../../.research/papers/1706.03762/paper.md");
  });

  it("round-trips through parsePaperLinkPath from any depth", () => {
    const paper = { arxivId: "2010.11929", hasFullText: false };
    for (const activePath of ["a.md", "a/b.md", "a/b/c.md"]) {
      const href = paperLinkHref(activePath, paper);
      // Resolve the way resolveProjectLink does: relative to the note's dir.
      const parts = activePath.split("/").slice(0, -1);
      for (const part of href.split("/")) {
        if (part === "..") parts.pop();
        else parts.push(part);
      }
      expect(parsePaperLinkPath(parts.join("/")))
        .toEqual({ arxivId: "2010.11929", view: "blog" });
    }
  });
});

describe("parsePaperLinkPath", () => {
  it("recognizes both reading views", () => {
    expect(parsePaperLinkPath(".research/papers/1706.03762/paper.md"))
      .toEqual({ arxivId: "1706.03762", view: "fulltext" });
    expect(parsePaperLinkPath(".research/papers/1706.03762/blog.md"))
      .toEqual({ arxivId: "1706.03762", view: "blog" });
  });

  it("ignores other project and paper-adjacent paths", () => {
    expect(parsePaperLinkPath("main.tex")).toBeNull();
    expect(parsePaperLinkPath("papers/1706.03762/paper.md")).toBeNull();
    expect(parsePaperLinkPath(".research/papers/1706.03762/metadata.json")).toBeNull();
    expect(parsePaperLinkPath(".research/papers/1706.03762/assets/figure.png")).toBeNull();
    expect(parsePaperLinkPath(".research/papers/a/b/paper.md")).toBeNull();
  });
});
