import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FluidHoverSurface } from "./fluid-hover-surface";

// jsdom has no layout. Deliberately unequal rows catch stale index/size reuse
// when a filtered collection replaces a currently hovered item.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(160);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.textContent === "Second" ? 45 : 27;
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function move(element: Element, pointerType = "mouse") {
  const event = new MouseEvent("pointermove", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(element, event);
}

describe("FluidHoverSurface", () => {
  it("moves one measured fill without taking focus or forwarding whitespace clicks", async () => {
    const onClick = vi.fn();
    const { container } = render(<div className="fluid-hover-surface">
      <FluidHoverSurface />
      <button role="option" onClick={onClick}>First</button>
      <button role="option" onClick={onClick}>Second</button>
    </div>);
    const first = screen.getByRole("option", { name: "First" });
    const second = screen.getByRole("option", { name: "Second" });
    first.focus();
    move(first);
    await waitFor(() => expect(container.querySelector('[data-slot="fluid-hover-highlight"]')).not.toBeNull());
    const fill = container.querySelector('[data-slot="fluid-hover-highlight"]');
    move(second);
    expect(second).toHaveAttribute("data-fluid-hover-active");
    expect(first).not.toHaveAttribute("data-fluid-hover-active");
    expect(first).toHaveFocus();
    expect(container.querySelector('[data-slot="fluid-hover-highlight"]')).toBe(fill);
    await waitFor(() => expect(fill).toHaveStyle({ height: "45px", width: "160px" }));
    fireEvent.click(container.firstElementChild!);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(second);
    expect(onClick).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(second).not.toHaveAttribute("data-fluid-hover-active");
  });

  it("starts a new fill across a separator instead of sliding through another section", async () => {
    const { container } = render(<div className="fluid-hover-surface">
      <FluidHoverSurface />
      <button role="menuitem">First</button>
      <div role="separator" />
      <button role="menuitem">Second</button>
    </div>);
    move(screen.getByRole("menuitem", { name: "First" }));
    await waitFor(() => expect(container.querySelector('[data-slot="fluid-hover-highlight"]')).not.toBeNull());
    const original = container.querySelector('[data-slot="fluid-hover-highlight"]');
    move(screen.getByRole("menuitem", { name: "Second" }));
    await waitFor(() => {
      const fills = container.querySelectorAll('[data-slot="fluid-hover-highlight"]');
      expect(fills).toHaveLength(1);
      expect(fills[0]).not.toBe(original);
    });
  });

  it("ignores touch, disabled and destructive rows, and clears on scroll", async () => {
    const { container } = render(<div className="fluid-hover-surface">
      <FluidHoverSurface />
      <button role="menuitem">First</button>
      <button role="menuitem" disabled>Unavailable</button>
      <button role="menuitem" data-variant="destructive">Delete</button>
    </div>);
    const first = screen.getByRole("menuitem", { name: "First" });
    move(first, "touch");
    expect(first).not.toHaveAttribute("data-fluid-hover-active");
    move(first);
    await waitFor(() => expect(first).toHaveAttribute("data-fluid-hover-active"));
    move(screen.getByRole("menuitem", { name: "Unavailable" }));
    expect(container.querySelector("[data-fluid-hover-active]")).toBeNull();
    move(screen.getByRole("menuitem", { name: "Delete" }));
    expect(container.querySelector("[data-fluid-hover-active]")).toBeNull();
    move(first);
    fireEvent.scroll(container.firstElementChild!);
    expect(first).not.toHaveAttribute("data-fluid-hover-active");
  });

  it("re-registers filtered items under StrictMode and isolates nested surfaces", async () => {
    function List({ filtered = false }) {
      return <StrictMode><div className="fluid-hover-surface">
        <FluidHoverSurface />
        {!filtered && <button role="option">First</button>}
        <button role="option">Second</button>
        <div className="fluid-hover-surface"><FluidHoverSurface /><button role="option">Nested</button></div>
      </div></StrictMode>;
    }
    const { container, rerender } = render(<List />);
    move(screen.getByRole("option", { name: "First" }));
    await waitFor(() => expect(container.querySelector('[data-slot="fluid-hover-highlight"]')).not.toBeNull());
    rerender(<List filtered />);
    await act(async () => { await Promise.resolve(); });
    expect(container.querySelector("[data-fluid-hover-active]")).toBeNull();
    move(screen.getByRole("option", { name: "Second" }));
    expect(container.firstElementChild).toHaveAttribute("data-fluid-hover-active-index", "0");
    move(screen.getByRole("option", { name: "Nested" }));
    expect(container.firstElementChild).not.toHaveAttribute("data-fluid-hover-active-index");
    expect(screen.getByRole("option", { name: "Nested" })).toHaveAttribute("data-fluid-hover-active");
  });
});
