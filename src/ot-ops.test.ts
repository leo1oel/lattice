import { describe, expect, it } from "vitest";
import { applyOps, diffToOps, transformCaret } from "./ot-ops";

/** Round-trip helper: ops derived from a change must reproduce that change. */
function roundTrip(before: string, after: string) {
  const ops = diffToOps(before, after);
  expect(applyOps(before, ops)).toBe(after);
  return ops;
}

describe("diffToOps", () => {
  it("says nothing when the text is unchanged", () => {
    expect(diffToOps("same", "same")).toEqual([]);
  });

  it("describes typing as a single insert at the caret", () => {
    expect(roundTrip("hello world", "hello brave world")).toEqual([
      { p: 6, i: "brave " },
    ]);
  });

  it("describes deleting a selection as a single delete", () => {
    expect(roundTrip("hello brave world", "hello world")).toEqual([
      { p: 6, d: "brave " },
    ]);
  });

  it("describes a replacement as a delete followed by an insert", () => {
    expect(roundTrip("the quick fox", "the slow fox")).toEqual([
      { p: 4, d: "quick" },
      { p: 4, i: "slow" },
    ]);
  });

  it("handles edits at the very start and end", () => {
    expect(roundTrip("body", "\\section{A}\nbody")).toEqual([
      { p: 0, i: "\\section{A}\n" },
    ]);
    expect(roundTrip("body", "body\n")).toEqual([{ p: 4, i: "\n" }]);
    expect(roundTrip("body", "")).toEqual([{ p: 0, d: "body" }]);
    expect(roundTrip("", "body")).toEqual([{ p: 0, i: "body" }]);
  });

  it("does not mistake repeated text for a bigger change", () => {
    // The naive prefix/suffix walk must not overlap; "aa" → "aaa" is one insert.
    const ops = roundTrip("aa", "aaa");
    expect(ops).toHaveLength(1);
    expect(ops[0].i).toBe("a");
  });

  it("round-trips multi-line LaTeX edits", () => {
    const before = "\\begin{abstract}\nOne paragraph.\n\\end{abstract}\n";
    const after = "\\begin{abstract}\nOne paragraph. Added.\n\\end{abstract}\n";
    roundTrip(before, after);
  });
});

describe("applyOps", () => {
  it("applies a sequence in order", () => {
    expect(applyOps("abcdef", [{ p: 1, d: "bc" }, { p: 1, i: "X" }])).toBe("aXdef");
  });

  it("refuses ops that do not fit, rather than corrupting the text", () => {
    // A delete whose content disagrees means the local copy drifted.
    expect(applyOps("hello", [{ p: 0, d: "goodbye" }])).toBeNull();
    expect(applyOps("hello", [{ p: 99, i: "x" }])).toBeNull();
    expect(applyOps("hello", [{ p: -1, i: "x" }])).toBeNull();
  });
});

describe("transformCaret", () => {
  it("keeps the caret in place when text is inserted above it", () => {
    expect(transformCaret(10, [{ p: 0, i: "abc" }])).toBe(13);
  });

  it("leaves the caret alone when the edit is below it", () => {
    expect(transformCaret(5, [{ p: 20, i: "abc" }])).toBe(5);
  });

  it("does not drag the caret when someone types exactly at it", () => {
    expect(transformCaret(5, [{ p: 5, i: "abc" }])).toBe(5);
  });

  it("pulls the caret back when text above it is deleted", () => {
    expect(transformCaret(10, [{ p: 0, d: "abc" }])).toBe(7);
  });

  it("clamps the caret to the start of a deletion that contained it", () => {
    expect(transformCaret(5, [{ p: 3, d: "abcdef" }])).toBe(3);
  });
});
