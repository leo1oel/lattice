import { describe, expect, it } from "vitest";
import {
  annotatedDiffLines,
  changeKind,
  hunkedDiffLines,
  jumpLineForDiff,
  pairedRewrites,
  unifiedDiffLines,
  wordSegments,
} from "./history-diff";

describe("history diff helpers", () => {
  it("classifies create edit and delete", () => {
    expect(changeKind(null, "new")).toBe("created");
    expect(changeKind("old", null)).toBe("deleted");
    expect(changeKind("old", "new")).toBe("edited");
  });

  it("renders unified added and removed lines", () => {
    expect(unifiedDiffLines("a\nb\n", "a\nc\n")).toEqual([
      { type: "context", text: "a" },
      { type: "removed", text: "b" },
      { type: "added", text: "c" },
    ]);
  });

  it("annotates before and after line numbers", () => {
    expect(annotatedDiffLines("a\nb\n", "a\nc\n")).toEqual([
      { type: "context", text: "a", beforeLine: 1, afterLine: 1 },
      { type: "removed", text: "b", beforeLine: 2, afterLine: null },
      { type: "added", text: "c", beforeLine: null, afterLine: 2 },
    ]);
  });

  it("collapses long unchanged runs into skip markers", () => {
    const before = ["keep", ...Array.from({ length: 20 }, (_, index) => `u${index}`), "old", "tail"].join("\n");
    const after = ["keep", ...Array.from({ length: 20 }, (_, index) => `u${index}`), "new", "tail"].join("\n");
    const hunks = hunkedDiffLines(before, after, 2);
    expect(hunks.some((line) => line.type === "skip")).toBe(true);
    expect(hunks.some((line) => line.type === "removed" && line.text === "old")).toBe(true);
    expect(hunks.some((line) => line.type === "added" && line.text === "new")).toBe(true);
    expect(hunks.filter((line) => line.type !== "skip").length).toBeLessThan(12);
  });

  it("jumps to after-line when present", () => {
    expect(jumpLineForDiff({ type: "added", text: "x", afterLine: 4, beforeLine: null })).toBe(4);
    expect(jumpLineForDiff({ type: "removed", text: "x", afterLine: null, beforeLine: 7 })).toBe(7);
    expect(jumpLineForDiff({ type: "skip", text: "…", skippedCount: 3 })).toBeNull();
  });
});

describe("word-level marks inside a rewritten line", () => {
  it("marks only the words that moved", () => {
    const { before, after } = wordSegments(
      "the quick brown fox",
      "the slow brown fox",
    );
    expect(before.filter((part) => part.changed).map((part) => part.text)).toEqual(["quick"]);
    expect(after.filter((part) => part.changed).map((part) => part.text)).toEqual(["slow"]);
    // Both sides still read as the whole line.
    expect(before.map((part) => part.text).join("")).toBe("the quick brown fox");
    expect(after.map((part) => part.text).join("")).toBe("the slow brown fox");
  });

  it("pairs a replaced line with its replacement", () => {
    const lines = annotatedDiffLines("alpha one\n", "alpha two\n");
    const marks = pairedRewrites(lines);
    expect(marks.size).toBe(2);
    expect(marks.get(0)?.filter((part) => part.changed).map((part) => part.text)).toEqual(["one"]);
    expect(marks.get(1)?.filter((part) => part.changed).map((part) => part.text)).toEqual(["two"]);
  });

  it("leaves a pure insertion alone", () => {
    // Nothing was replaced, so nothing should be marked as a word-level
    // change — the whole line is new and the line tint already says so.
    const lines = annotatedDiffLines("alpha\n", "alpha\nbeta\n");
    expect(pairedRewrites(lines).size).toBe(0);
  });

  it("does not invent a pairing when the runs are different lengths", () => {
    // One line replaced by three is not three rewrites; guessing at a pairing
    // would mark words as changed that nobody touched.
    const lines = annotatedDiffLines("one\n", "alpha\nbeta\ngamma\n");
    expect(pairedRewrites(lines).size).toBe(0);
  });

  it("pairs each line of an equal-length run with its own replacement", () => {
    const lines = annotatedDiffLines("one red\ntwo blue\n", "one green\ntwo blue\n");
    const marks = pairedRewrites(lines);
    // Only the first line differs, so only it is a rewrite.
    const changed = [...marks.values()].map(
      (segments) => segments.filter((part) => part.changed).map((part) => part.text).join(""),
    );
    expect(changed.sort()).toEqual(["green", "red"]);
  });
});
