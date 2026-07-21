import { describe, expect, it } from "vitest";
import { marksToMarkdown } from "./pdf-annotations-panel";
import type { PdfMark } from "./pdf-annotations";

describe("marksToMarkdown", () => {
  it("formats highlights and notes for export", () => {
    const marks: PdfMark[] = [
      {
        id: "1",
        kind: "highlight",
        page: 2,
        rects: [],
        color: "yellow",
        text: "attention is all you need",
        note: "",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "2",
        kind: "note",
        page: 3,
        rects: [],
        color: "blue",
        text: "compare baselines",
        note: "Needs a stronger claim",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const markdown = marksToMarkdown(marks);
    expect(markdown).toContain("### Highlight · p.2");
    expect(markdown).toContain("attention is all you need");
    expect(markdown).toContain("### Note · p.3");
    expect(markdown).toContain("> Needs a stronger claim");
  });
});
