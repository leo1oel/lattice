import { describe, expect, it } from "vitest";
import { scoreItem, scorePath } from "./picker-ranking";

describe("scoreItem", () => {
  const row = (label: string, extra: { detail?: string; group?: string; keywords?: string } = {}) => ({ label, ...extra });

  it("ranks the whole label, then its start, then a word start, then a run inside a word", () => {
    const query = "show";
    const scores = [row("Show"), row("Show Agent panel"), row("Panels: show all"), row("Slideshow")].map((item) => scoreItem(item, query));
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
    expect(new Set(scores).size).toBe(4);
  });

  it("finds every spaced part of the query in any order, above scattered letters", () => {
    const spaced = scoreItem(row("Show Agent panel"), "agent show");
    expect(spaced).toBeGreaterThan(0);
    expect(spaced).toBeGreaterThan(scoreItem(row("Save and go"), "sag"));
  });

  it("searches the words a row does not show", () => {
    expect(scoreItem(row("Use the dark theme"), "appearance")).toBe(0);
    expect(scoreItem(row("Use the dark theme", { keywords: "theme appearance" }), "appearance")).toBeGreaterThan(0);
  });

  it("finds nothing for letters the row does not hold in order", () => {
    expect(scoreItem(row("Build project"), "xyz")).toBe(0);
  });
});

describe("scorePath", () => {
  it("prefers the file named by the query over one whose path only contains it", () => {
    expect(scorePath("chapters/intro.tex", "intro.tex")).toBeGreaterThan(scorePath("intro.tex.bak/notes.md", "intro.tex"));
    expect(scorePath("notes/note-012.md", "note 12")).toBeGreaterThan(0);
  });
});
