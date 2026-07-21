import { describe, expect, it } from "vitest";
import {
  annotatedDiffLines,
  changeKind,
  hunkedDiffLines,
  jumpLineForDiff,
  unifiedDiffLines,
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
