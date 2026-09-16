import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OverlayScrollbars } from "./overlay-scrollbar";
import { calculateOverlayAxisGeometry } from "./overlay-scrollbar-geometry";

afterEach(cleanup);

// jsdom has no layout, so every measured dimension is declared outright. The
// scroll offsets become plain writable properties for the same reason: the
// component's own writes have to read back.
function sizedElement(element: HTMLElement, sizes: Record<string, number>) {
  for (const [name, value] of Object.entries(sizes)) {
    Object.defineProperty(element, name, { configurable: true, value, writable: true });
  }
  return element;
}

function renderOverlay(sizes: Record<string, number>) {
  const viewport = sizedElement(document.createElement("div"), {
    scrollLeft: 0,
    scrollTop: 0,
    ...sizes,
  });
  const view = render(<OverlayScrollbars getViewport={() => viewport} />);
  const vertical = view.container.querySelector<HTMLElement>(
    '.overlay-scrollbar[data-orientation="vertical"]',
  )!;
  const horizontal = view.container.querySelector<HTMLElement>(
    '.overlay-scrollbar[data-orientation="horizontal"]',
  )!;
  sizedElement(vertical, { clientHeight: 200 });
  sizedElement(horizontal, { clientWidth: 400 });
  return { horizontal, vertical, viewport };
}

describe("OverlayScrollbars", () => {
  it("marks only the axes that overflow", async () => {
    const { horizontal, vertical, viewport } = renderOverlay({
      clientHeight: 200,
      clientWidth: 400,
      scrollHeight: 800,
      scrollWidth: 400,
    });

    await waitFor(() => expect(vertical).toHaveAttribute("data-overflow-y-end"));
    expect(vertical).not.toHaveAttribute("data-overflow-y-start");
    // Neither end attribute is what the shared stylesheet hides on.
    expect(horizontal).not.toHaveAttribute("data-overflow-x-end");
    expect(horizontal).not.toHaveAttribute("data-overflow-x-start");
    expect(vertical.firstElementChild).toHaveStyle({ height: "48px" });

    viewport.scrollTop = 300;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(vertical).toHaveAttribute("data-overflow-y-start"));
    expect(vertical.firstElementChild).toHaveStyle({
      transform: "translate3d(-2px, 72px, 0)",
    });
  });

  it("reveals while the viewport scrolls and settles again", async () => {
    const { vertical, viewport } = renderOverlay({
      clientHeight: 200,
      clientWidth: 400,
      scrollHeight: 800,
      scrollWidth: 400,
    });

    fireEvent.scroll(viewport);
    expect(vertical).toHaveAttribute("data-scrolling");
    await waitFor(() => expect(vertical).not.toHaveAttribute("data-scrolling"));
  });

  it("drags the thumb along its own axis", async () => {
    const { horizontal, vertical, viewport } = renderOverlay({
      clientHeight: 200,
      clientWidth: 400,
      scrollHeight: 800,
      scrollWidth: 1_200,
    });
    await waitFor(() => expect(vertical).toHaveAttribute("data-overflow-y-end"));

    fireEvent.pointerDown(vertical.firstElementChild!, { clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(vertical, { clientY: 12, pointerId: 1 });
    // 600px of scroll across 144px of travel.
    expect(viewport.scrollTop).toBeCloseTo(50, 5);
    fireEvent.pointerUp(vertical, { pointerId: 1 });

    fireEvent.pointerDown(horizontal.firstElementChild!, { clientX: 0, pointerId: 2 });
    fireEvent.pointerMove(horizontal, { clientX: 10, pointerId: 2 });
    expect(viewport.scrollLeft).toBeGreaterThan(0);
    expect(viewport.scrollTop).toBeCloseTo(50, 5);
  });
});

describe("calculateOverlayAxisGeometry", () => {
  it("maps the scroll position onto the inset track", () => {
    expect(calculateOverlayAxisGeometry({
      content: 800,
      offset: 0,
      track: 200,
      viewport: 200,
    })).toMatchObject({ overflow: true, thumbOffset: 0, thumbSize: 48 });
    expect(calculateOverlayAxisGeometry({
      content: 800,
      offset: 300,
      track: 200,
      viewport: 200,
    }).thumbOffset).toBe(72);
    expect(calculateOverlayAxisGeometry({
      content: 800,
      offset: 600,
      track: 200,
      viewport: 200,
    }).thumbOffset).toBe(144);
  });

  it("treats a sub-pixel extent as no overflow", () => {
    expect(calculateOverlayAxisGeometry({
      content: 400.4,
      offset: 0,
      track: 400,
      viewport: 400,
    })).toMatchObject({ canScrollEnd: false, canScrollStart: false, overflow: false });
  });

  it("keeps a usable thumb and clamps a stale offset", () => {
    expect(calculateOverlayAxisGeometry({
      content: 10_000,
      offset: 20_000,
      track: 100,
      viewport: 100,
    })).toMatchObject({ overflow: true, thumbOffset: 68, thumbSize: 24 });
  });
});
