import { describe, expect, it } from "vitest";
import { calculateVerticalScrollGeometry } from "./external-scrollbar-geometry";

describe("calculateVerticalScrollGeometry", () => {
  it("maps viewport scroll position onto the inset thumb track", () => {
    const start = calculateVerticalScrollGeometry({
      clientHeight: 200,
      scrollHeight: 800,
      scrollTop: 0,
    });
    const middle = calculateVerticalScrollGeometry({
      clientHeight: 200,
      scrollHeight: 800,
      scrollTop: 300,
    });
    const end = calculateVerticalScrollGeometry({
      clientHeight: 200,
      scrollHeight: 800,
      scrollTop: 600,
    });

    expect(start).toMatchObject({
      overflow: true,
      thumbHeight: 48,
      thumbOffset: 0,
    });
    expect(middle.thumbOffset).toBe(72);
    expect(end.thumbOffset).toBe(144);
  });

  it("hides the scrollbar when the viewport has no overflow", () => {
    expect(calculateVerticalScrollGeometry({
      clientHeight: 200,
      scrollHeight: 200,
      scrollTop: 0,
    })).toMatchObject({
      overflow: false,
      maxScrollTop: 0,
      scrollTop: 0,
    });
  });

  it("keeps a usable minimum thumb and clamps stale scroll positions", () => {
    expect(calculateVerticalScrollGeometry({
      clientHeight: 100,
      scrollHeight: 10_000,
      scrollTop: 20_000,
    })).toMatchObject({
      overflow: true,
      scrollTop: 9_900,
      thumbHeight: 18,
      thumbOffset: 74,
    });
  });
});
