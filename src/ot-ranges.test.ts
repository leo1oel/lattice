import { describe, expect, it } from "vitest";
import { isCollapsed, transformSpan } from "./ot-ranges";

/** "0123456789", with a span over "345". */
const SPAN = { from: 3, length: 3 };

describe("transformSpan", () => {
  it("moves a span along when text is inserted before it", () => {
    expect(transformSpan(SPAN, [{ p: 0, i: "ab" }])).toEqual({ from: 5, length: 3 });
  });

  it("leaves a span alone when text is inserted after it", () => {
    expect(transformSpan(SPAN, [{ p: 6, i: "ab" }])).toEqual(SPAN);
    expect(transformSpan(SPAN, [{ p: 9, i: "ab" }])).toEqual(SPAN);
  });

  it("puts text typed at either edge outside the span", () => {
    // Typing right in front of a suggestion should not make it cover what was
    // typed — accepting it would then change text nobody proposed changing.
    expect(transformSpan(SPAN, [{ p: 3, i: "ab" }])).toEqual({ from: 5, length: 3 });
    expect(transformSpan(SPAN, [{ p: 6, i: "ab" }])).toEqual({ from: 3, length: 3 });
  });

  it("grows a span around text typed inside it", () => {
    expect(transformSpan(SPAN, [{ p: 4, i: "ab" }])).toEqual({ from: 3, length: 5 });
  });

  it("pulls a span back when text before it is deleted", () => {
    expect(transformSpan(SPAN, [{ p: 0, d: "01" }])).toEqual({ from: 1, length: 3 });
  });

  it("shrinks a span when part of it is deleted", () => {
    // "345" losing "45"
    expect(transformSpan(SPAN, [{ p: 4, d: "45" }])).toEqual({ from: 3, length: 1 });
    // "345" losing "34", which also moves the start back
    expect(transformSpan(SPAN, [{ p: 3, d: "34" }])).toEqual({ from: 3, length: 1 });
  });

  it("collapses a span whose text is deleted outright", () => {
    const gone = transformSpan(SPAN, [{ p: 3, d: "345" }]);
    expect(isCollapsed(gone)).toBe(true);
    // And a deletion that swallows the span along with its surroundings.
    expect(isCollapsed(transformSpan(SPAN, [{ p: 1, d: "12345678" }]))).toBe(true);
  });

  it("handles a deletion that straddles the start", () => {
    // Deleting "234" removes "34" from the span and two characters before it.
    expect(transformSpan(SPAN, [{ p: 2, d: "234" }])).toEqual({ from: 2, length: 1 });
  });

  it("applies a run of operations in order", () => {
    expect(transformSpan(SPAN, [{ p: 0, i: "xx" }, { p: 0, d: "x" }])).toEqual({
      from: 4,
      length: 3,
    });
  });

  it("leaves a span untouched by an empty operation list", () => {
    expect(transformSpan(SPAN, [])).toEqual(SPAN);
  });
});
