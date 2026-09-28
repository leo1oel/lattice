import { createRef, type ComponentProps } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ScrollArea } from "./scroll-area";

type ScrollGeometry = { clientHeight: number; clientWidth: number; scrollHeight: number; scrollWidth: number };

/** jsdom has no layout, so declare the viewport's extent. */
function setScrollGeometry(element: HTMLElement, geometry: ScrollGeometry = {} as ScrollGeometry) {
  for (const [name, value] of Object.entries(geometry)) {
    Object.defineProperty(element, name, { configurable: true, value });
  }
}

function renderViewport(
  label: string,
  props: Omit<ComponentProps<typeof ScrollArea>, "viewportProps">,
  geometry?: ScrollGeometry,
) {
  render(<ScrollArea {...props} viewportProps={{ "aria-label": label }}><p>Result</p></ScrollArea>);
  const viewport = screen.getByLabelText(label);
  setScrollGeometry(viewport, geometry);
  return viewport;
}

describe("ScrollArea", () => {
  it("registers every custom property Base UI writes per scroll as non-inherited", async () => {
    // Unregistered custom properties inherit: in WebKit, where Base UI skips
    // this registration, each scroll event restyled the whole scrolled
    // document. Capture what Base UI actually writes so a rename upstream
    // cannot silently bring that back.
    const registered: PropertyDefinition[] = [];
    vi.stubGlobal("CSS", { ...globalThis.CSS, registerProperty: (definition: PropertyDefinition) => registered.push(definition) });
    vi.resetModules();
    const { ScrollArea: FreshScrollArea } = await import("./scroll-area");
    vi.unstubAllGlobals();
    expect(registered.every((definition) => definition.inherits === false)).toBe(true);

    render(
      <FreshScrollArea orientation="both" viewportProps={{ "aria-label": "Document" }}>
        <p>Long document</p>
      </FreshScrollArea>,
    );
    const viewport = screen.getByLabelText("Document");
    setScrollGeometry(viewport, { clientHeight: 100, clientWidth: 100, scrollHeight: 400, scrollWidth: 400 });
    // Only what lands on the viewport — the ancestor of the whole document —
    // during a scroll matters here.
    const written = new Set<string>();
    const setProperty = viewport.style.setProperty.bind(viewport.style);
    const spy = vi.spyOn(viewport.style, "setProperty").mockImplementation((name, ...rest) => {
      if (name.startsWith("--")) written.add(name);
      setProperty(name, ...rest);
    });
    try {
      fireEvent.scroll(viewport);
    } finally {
      spy.mockRestore();
    }
    expect(written.size).toBeGreaterThan(0);
    expect([...written].filter((name) => !registered.some((definition) => definition.name === name))).toEqual([]);
  });

  it("exposes the real viewport and forwards viewport props", () => {
    const viewportRef = createRef<HTMLDivElement>();
    const onScroll = vi.fn();
    render(
      <ScrollArea viewportRef={viewportRef} viewportProps={{ "aria-label": "Results", onScroll }}>
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
    const viewport = renderViewport("Unmasked content", { fadeEdges: false }, {
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 300,
      scrollWidth: 100,
    });
    expect(viewport).not.toHaveClass("scroll-fade");
    fireEvent.scroll(viewport);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(viewport).not.toHaveAttribute("data-has-vertical-overflow");
    expect(viewport).not.toHaveAttribute("data-can-scroll-down");
  });

  it("tracks which edges still have content to reveal", async () => {
    const viewport = renderViewport("Scrollable content", { orientation: "both" }, {
      clientHeight: 100,
      clientWidth: 100,
      scrollHeight: 300,
      scrollWidth: 250,
    });
    expect(viewport).toHaveClass("scroll-fade-both");
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
    const viewport = renderViewport("Fitting content", { orientation: "both" }, {
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
