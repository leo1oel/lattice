import { describe, expect, it } from "vitest";
import {
  countWords,
  sortSelectedLines,
  textStats,
  toggleLineComments,
  transformCase,
  wrapCommentRegion,
  wrapEnvironment,
  wrapRange,
} from "./latex-edits";

describe("LaTeX text edits", () => {
  it("counts words for the editor status bar", () => {
    expect(countWords("Hello, world — and pre-trained models.")).toBe(5);
    expect(countWords("")).toBe(0);
    expect(textStats("one two\nthree").words).toBe(3);
  });

  it("wraps a selection or empty cursor for bold and math", () => {
    expect(wrapRange("hello world", 0, 5, "\\textbf{", "}"))
      .toEqual({ from: 0, to: 5, insert: "\\textbf{hello}", cursorFrom: 8, cursorTo: 13 });
    expect(wrapRange("x", 0, 0, "$", "$")).toEqual({ from: 0, to: 0, insert: "$$", cursorFrom: 1, cursorTo: 1 });
  });

  it("wraps selections in environments, comment environments, or iffalse blocks", () => {
    expect(wrapEnvironment("x", 0, 1, "equation").insert).toBe("\\begin{equation}\nx\n\\end{equation}");
    expect(wrapEnvironment("", 0, 0, " ")).toMatchObject({ insert: "\\begin{equation}\n  \n\\end{equation}", cursorFrom: 19, cursorTo: 19 });
    expect(wrapCommentRegion("draft", 0, 5, "comment-env").insert).toBe("\\begin{comment}\ndraft\n\\end{comment}");
    expect(wrapCommentRegion("draft", 0, 5, "iffalse").insert).toBe("\\iffalse\ndraft\n\\fi");
  });

  it("toggles % line comments", () => {
    const source = "alpha\nbeta\ngamma\n";
    const commented = toggleLineComments(source, 6, 10);
    expect(commented.insert).toBe("% beta");
    const next = `${source.slice(0, commented.from)}${commented.insert}${source.slice(commented.to)}`;
    expect(toggleLineComments(next, commented.from, commented.from + commented.insert.length).insert).toBe("beta");
  });

  it("sorts selected lines and transforms case", () => {
    const source = "zeta\nalpha\nbeta\n";
    expect(sortSelectedLines(source, 0, source.length - 1)).toEqual({ from: 0, to: 15, insert: "alpha\nbeta\nzeta" });
    expect(transformCase("hello WORLD", 0, 11, "title")?.insert).toBe("Hello World");
    expect(transformCase("Hello", 0, 5, "upper")?.insert).toBe("HELLO");
  });
});
