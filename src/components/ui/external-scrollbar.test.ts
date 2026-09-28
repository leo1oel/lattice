import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ExternalScrollbar } from "./external-scrollbar";
import { calculateScrollAxisGeometry, calculateVerticalScrollGeometry } from "./external-scrollbar-geometry";

afterEach(cleanup);

describe("ExternalScrollbar", () => {
  it("reveals when the pointer enters its scroll viewport", () => {
    const viewport = document.createElement("div");
    const view = render(createElement(
      "div",
      null,
      createElement(ExternalScrollbar, { getViewport: () => viewport }),
    ));
    const scrollbar = view.container.querySelector(".external-scrollbar");

    expect(scrollbar).not.toHaveAttribute("data-hovering");
    fireEvent.pointerEnter(viewport);
    expect(scrollbar).toHaveAttribute("data-hovering");
    fireEvent.pointerLeave(viewport);
    expect(scrollbar).not.toHaveAttribute("data-hovering");
  });
});

describe("calculateVerticalScrollGeometry", () => {
  it.each([
    [0, { overflow: true, thumbHeight: 48, thumbOffset: 0 }],
    [300, { thumbOffset: 72 }],
    [600, { thumbOffset: 144 }],
  ])("maps scrollTop %i onto the inset thumb track", (scrollTop, expected) => {
    expect(calculateVerticalScrollGeometry({ clientHeight: 200, scrollHeight: 800, scrollTop }))
      .toMatchObject(expected);
  });

  it("hides the scrollbar when the viewport has no overflow", () => {
    expect(calculateVerticalScrollGeometry({ clientHeight: 200, scrollHeight: 200, scrollTop: 0 }))
      .toMatchObject({ overflow: false, maxScrollTop: 0, scrollTop: 0 });
  });

  it("keeps a usable minimum thumb and clamps stale scroll positions", () => {
    expect(calculateVerticalScrollGeometry({ clientHeight: 100, scrollHeight: 10_000, scrollTop: 20_000 }))
      .toMatchObject({ overflow: true, scrollTop: 9_900, thumbHeight: 18, thumbOffset: 74 });
  });
});

describe("calculateScrollAxisGeometry with the overlay metrics", () => {
  const overlay = { minThumb: 24, minOverflow: 1 };

  it.each([
    [{ content: 800, offset: 0, track: 200, viewport: 200 }, { overflow: true, thumbOffset: 0, thumbSize: 48 }],
    [{ content: 800, offset: 300, track: 200, viewport: 200 }, { thumbOffset: 72 }],
    [{ content: 800, offset: 600, track: 200, viewport: 200 }, { thumbOffset: 144 }],
    // A sub-pixel extent is rounding noise, not overflow.
    [{ content: 400.4, offset: 0, track: 400, viewport: 400 }, { canScrollEnd: false, canScrollStart: false, overflow: false }],
    // A usable thumb, and a stale offset clamped into range.
    [{ content: 10_000, offset: 20_000, track: 100, viewport: 100 }, { overflow: true, thumbOffset: 68, thumbSize: 24 }],
  ])("maps %o", (input, expected) => {
    expect(calculateScrollAxisGeometry(input, overlay)).toMatchObject(expected);
  });
});
