import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScrollArea } from "./scroll-area";

function setScrollGeometry(element: HTMLElement, geometry: {
  clientHeight: number;
  clientWidth: number;
  scrollHeight: number;
  scrollWidth: number;
}) {
  for (const [name, value] of Object.entries(geometry)) {
    Object.defineProperty(element, name, { configurable: true, value });
  }
}

describe("ScrollArea", () => {
  it("exposes the real viewport and forwards viewport props", () => {
    const viewportRef = createRef<HTMLDivElement>();
    const onScroll = vi.fn();
    render(
      <ScrollArea
        viewportRef={viewportRef}
        viewportProps={{ "aria-label": "Results", onScroll }}
      >
        <p>Result</p>
      </ScrollArea>,
    );

    const viewport = screen.getByLabelText("Results");
    expect(viewportRef.current).toBe(viewport);
    expect(viewport).toHaveAttribute("data-slot", "scroll-area-viewport");
    expect(viewport).toHaveClass("scroll-fade");
    fireEvent.scroll(viewport);
    expect(onScroll).toHaveBeenCalledOnce();
  });

  it("disables both edge masks and their scroll measurements", async () => {
    render(
      <ScrollArea
        fadeEdges={false}
        viewportProps={{ "aria-label": "Unmasked content" }}
      >
        <p>Result</p>
      </ScrollArea>,
    );

    const viewport = screen.getByLabelText("Unmasked content");
    expect(viewport).not.toHaveClass("scroll-fade");
    setScrollGeometry(viewport, {
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 300,
      scrollWidth: 100,
    });
    fireEvent.scroll(viewport);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(viewport).not.toHaveAttribute("data-has-vertical-overflow");
    expect(viewport).not.toHaveAttribute("data-can-scroll-down");
  });

  it("tracks which edges still have content to reveal", async () => {
    render(
      <ScrollArea
        orientation="both"
        viewportClassName="scroll-fade-both"
        viewportProps={{ "aria-label": "Scrollable content" }}
      >
        <div>Large content</div>
      </ScrollArea>,
    );

    const viewport = screen.getByLabelText("Scrollable content");
    setScrollGeometry(viewport, {
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 300,
      scrollWidth: 250,
    });
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 0 });
    Object.defineProperty(viewport, "scrollLeft", { configurable: true, writable: true, value: 0 });
    fireEvent.scroll(viewport);

    await waitFor(() => {
      expect(viewport).toHaveAttribute("data-has-vertical-overflow", "true");
      expect(viewport).toHaveAttribute("data-has-horizontal-overflow", "true");
      expect(viewport).toHaveAttribute("data-can-scroll-up", "false");
      expect(viewport).toHaveAttribute("data-can-scroll-down", "true");
      expect(viewport).toHaveAttribute("data-can-scroll-left", "false");
      expect(viewport).toHaveAttribute("data-can-scroll-right", "true");
    });

    viewport.scrollTop = 200;
    viewport.scrollLeft = 150;
    fireEvent.scroll(viewport);
    await waitFor(() => {
      expect(viewport).toHaveAttribute("data-can-scroll-up", "true");
      expect(viewport).toHaveAttribute("data-can-scroll-down", "false");
      expect(viewport).toHaveAttribute("data-can-scroll-left", "true");
      expect(viewport).toHaveAttribute("data-can-scroll-right", "false");
    });
  });

  it("marks both axes as non-scrollable when all content fits", async () => {
    render(
      <ScrollArea
        orientation="both"
        viewportProps={{ "aria-label": "Fitting content" }}
      >
        <div>Small content</div>
      </ScrollArea>,
    );

    const viewport = screen.getByLabelText("Fitting content");
    setScrollGeometry(viewport, {
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 100,
      scrollWidth: 100,
    });
    fireEvent.scroll(viewport);

    await waitFor(() => {
      expect(viewport).toHaveAttribute("data-has-vertical-overflow", "false");
      expect(viewport).toHaveAttribute("data-has-horizontal-overflow", "false");
    });
  });
});
