import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OverlayScrollbars } from "./overlay-scrollbar";

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

/** A 200×400 viewport over 800px of content, `scrollWidth` wide. */
function renderOverlay(scrollWidth = 400) {
  const viewport = sizedElement(document.createElement("div"), {
    clientHeight: 200,
    clientWidth: 400,
    scrollHeight: 800,
    scrollLeft: 0,
    scrollTop: 0,
    scrollWidth,
  });
  const view = render(<OverlayScrollbars getViewport={() => viewport} />);
  const bar = (orientation: string) =>
    view.container.querySelector<HTMLElement>(`.overlay-scrollbar[data-orientation="${orientation}"]`)!;
  const vertical = sizedElement(bar("vertical"), { clientHeight: 200 });
  const horizontal = sizedElement(bar("horizontal"), { clientWidth: 400 });
  return { horizontal, vertical, viewport };
}

describe("OverlayScrollbars", () => {
  it("marks only the axes that overflow, and reveals while the viewport scrolls then settles", async () => {
    const { horizontal, vertical, viewport } = renderOverlay();

    await waitFor(() => expect(vertical).toHaveAttribute("data-overflow-y-end"));
    expect(vertical).not.toHaveAttribute("data-overflow-y-start");
    // Neither end attribute is what the shared stylesheet hides on.
    expect(horizontal).not.toHaveAttribute("data-overflow-x-end");
    expect(horizontal).not.toHaveAttribute("data-overflow-x-start");
    expect(vertical.firstElementChild).toHaveStyle({ height: "48px" });

    viewport.scrollTop = 300;
    fireEvent.scroll(viewport);
    expect(vertical).toHaveAttribute("data-scrolling");
    await waitFor(() => expect(vertical).toHaveAttribute("data-overflow-y-start"));
    expect(vertical.firstElementChild).toHaveStyle({ transform: "translate3d(-2px, 72px, 0)" });
    await waitFor(() => expect(vertical).not.toHaveAttribute("data-scrolling"));
  });

  it("drags the thumb along its own axis", async () => {
    const { horizontal, vertical, viewport } = renderOverlay(1_200);
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
