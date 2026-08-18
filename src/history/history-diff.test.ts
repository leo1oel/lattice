import { describe, expect, it } from "vitest";
import {
  annotatedDiffLines,
  changeKind,
  hunkedDiffLines,
  inlineDiffLines,
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

describe("the document with changes marked in place", () => {
  const kinds = (line: { segments: { text: string; kind: string }[] }) =>
    line.segments.map((part) => `${part.kind}:${part.text}`);

  it("reads as the document, with only the moved words marked", () => {
    const lines = inlineDiffLines(
      "intro\nthe quick brown fox\noutro\n",
      "intro\nthe slow brown fox\noutro\n",
    );
    expect(lines).toHaveLength(3);
    // Unchanged prose is present and unmarked, so the change has context.
    expect(lines[0]).toMatchObject({ line: 1, changed: false });
    expect(kinds(lines[0]!)).toEqual(["same:intro"]);
    expect(lines[2]).toMatchObject({ line: 3, changed: false });

    // The rewritten line reads through, with both versions of the word in
    // place: what was cut, then what replaced it.
    expect(lines[1]!.changed).toBe(true);
    expect(kinds(lines[1]!)).toEqual([
      "same:the ",
      "removed:quick",
      "added:slow",
      "same: brown fox",
    ]);
    expect(lines[1]!.line).toBe(2);
  });

  it("keeps a deleted line visible where it was cut from", () => {
    const lines = inlineDiffLines("one\ntwo\nthree\n", "one\nthree\n");
    const removed = lines.find((line) => line.segments.some((part) => part.kind === "removed"));
    expect(removed?.segments).toEqual([{ text: "two", kind: "removed" }]);
    // It is no longer part of the file, so it carries no line number.
    expect(removed?.line).toBeNull();
    // And the lines that remain are numbered as the document now reads.
    expect(lines.filter((line) => line.line !== null).map((line) => line.line)).toEqual([1, 2]);
  });

  it("numbers an inserted line as it now reads", () => {
    const lines = inlineDiffLines("one\ntwo\n", "one\nmiddle\ntwo\n");
    const added = lines.find((line) => line.segments.some((part) => part.kind === "added"));
    expect(added).toMatchObject({ line: 2, changed: true });
    expect(kinds(added!)).toEqual(["added:middle"]);
  });

  it("marks nothing when nothing changed", () => {
    const lines = inlineDiffLines("alpha\nbeta\n", "alpha\nbeta\n");
    expect(lines.every((line) => !line.changed)).toBe(true);
    expect(lines.map((line) => line.line)).toEqual([1, 2]);
  });

  it("does not merge lines when a run was replaced by a different number", () => {
    // One line becoming three is a rewrite of the passage, not of a line;
    // merging them word by word would pair sentences that have nothing to do
    // with each other.
    const lines = inlineDiffLines("one\n", "alpha\nbeta\ngamma\n");
    expect(lines.filter((line) => line.segments[0]?.kind === "removed")).toHaveLength(1);
    expect(lines.filter((line) => line.segments[0]?.kind === "added")).toHaveLength(3);
  });

  it("shows both versions whole when a line differs in too many places to mark", () => {
    // Two timestamps differ at every field; marking them word by word
    // interleaves into `2026-07-25T1125T19:0131:41Z46Z`, which reads as noise.
    const lines = inlineDiffLines(
      '  "lastSync": "2026-07-25T11:01:41Z",\n',
      '  "lastSync": "2026-07-25T19:31:46Z",\n',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]!.segments).toEqual([
      { text: '  "lastSync": "2026-07-25T11:01:41Z",', kind: "removed" },
    ]);
    expect(lines[1]!.segments).toEqual([
      { text: '  "lastSync": "2026-07-25T19:31:46Z",', kind: "added" },
    ]);
    expect(lines[0]!.line).toBeNull();
    expect(lines[1]!.line).toBe(1);
  });

  it("still marks a light edit in place rather than splitting the line", () => {
    const lines = inlineDiffLines("the old claim holds\n", "the new claim holds\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.segments.map((segment) => segment.kind)).toEqual([
      "same",
      "removed",
      "added",
      "same",
    ]);
  });
});
