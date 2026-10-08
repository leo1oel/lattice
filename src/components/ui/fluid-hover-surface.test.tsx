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

// Each call is a real move: the surface ignores a pointermove that repeats the
// last coordinates, which is what a list scrolling under a resting pointer sends.
let pointerX = 0;
function move(element: Element, pointerType = "mouse", clientX = ++pointerX) {
  const event = new MouseEvent("pointermove", { bubbles: true, clientX });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(element, event);
}

describe("FluidHoverSurface", () => {
  it("preserves sidebar selection and clears recycled tree rows and drag gestures", async () => {
    render(<div className="fluid-hover-surface">
      <FluidHoverSurface selector="button" preserveSelection />
      <button aria-current="page">Selected</button>
      <button data-item-path="old.tex">File</button>
    </div>);
    const selected = screen.getByText("Selected");
    const file = screen.getByText("File");
    move(selected);
    expect(selected).not.toHaveAttribute("data-fluid-hover-active");
    move(file);
    expect(file).toHaveAttribute("data-fluid-hover-active");
    await act(async () => { file.setAttribute("data-item-path", "new.tex"); });
    expect(file).not.toHaveAttribute("data-fluid-hover-active");
    move(file);
    const drag = new MouseEvent("pointermove", { bubbles: true, buttons: 1, clientX: ++pointerX });
    Object.defineProperty(drag, "pointerType", { value: "mouse" });
    fireEvent(file, drag);
    expect(file).not.toHaveAttribute("data-fluid-hover-active");
  });

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
    // Nothing is current after the key: the fill goes, the primitive's focus stays.
    fireEvent.keyDown(document, { key: "ArrowDown" });
    await waitFor(() => expect(second).not.toHaveAttribute("data-fluid-hover-active"));
  });

  it("starts a new fill across a separator, ignores touch, disabled and destructive rows, clears on scroll", async () => {
    const { container } = render(<div className="fluid-hover-surface">
      <FluidHoverSurface />
      <button role="menuitem">First</button>
      <div role="separator" />
      <button role="menuitem">Second</button>
      <button role="menuitem" disabled>Unavailable</button>
      <button role="menuitem" data-variant="destructive">Delete</button>
    </div>);
    const first = screen.getByRole("menuitem", { name: "First" });
    move(first, "touch");
    expect(first).not.toHaveAttribute("data-fluid-hover-active");
    move(first);
    expect(first).toHaveAttribute("data-fluid-hover-active");
    // The fill mounts after measurement, a render later than the active attribute.
    await waitFor(() => expect(container.querySelector('[data-slot="fluid-hover-highlight"]')).not.toBeNull());
    const original = container.querySelector('[data-slot="fluid-hover-highlight"]');
    // Crossing the separator starts a new fill instead of sliding through another section.
    move(screen.getByRole("menuitem", { name: "Second" }));
    await waitFor(() => {
      const fills = container.querySelectorAll('[data-slot="fluid-hover-highlight"]');
      expect(fills).toHaveLength(1);
      expect(fills[0]).not.toBe(original);
    });
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

  it("keeps inert exit pictures out of the hover collection", async () => {
    const { container } = render(<div className="fluid-hover-surface">
      <FluidHoverSurface />
      <button role="option">First</button>
      <div inert><button role="option">Exiting</button></div>
    </div>);
    const picture = screen.getByText("Exiting");
    expect(picture).not.toHaveAttribute("data-fluid-hover-item");
    move(screen.getByText("First"));
    expect(container.firstElementChild).toHaveAttribute("data-fluid-hover-active-index", "0");
    await act(async () => { picture.parentElement!.removeAttribute("inert"); });
    expect(picture).toHaveAttribute("data-fluid-hover-item");
    move(picture);
    expect(container.firstElementChild).toHaveAttribute("data-fluid-hover-active-index", "1");
  });

  it("slides the same fill to the row the keyboard makes current, until the pointer really moves", async () => {
    function Menu({ current }: { current: string | null }) {
      return <div className="fluid-hover-surface">
        <FluidHoverSurface />
        {["First", "Second", "Third"].map((label) => (
          <button key={label} role="menuitem" data-highlighted={label === current ? "" : undefined}>{label}</button>
        ))}
      </div>;
    }
    const { container, rerender } = render(<Menu current={null} />);
    const [first, second, third] = screen.getAllByRole("menuitem");
    move(first);
    await waitFor(() => expect(container.querySelector('[data-slot="fluid-hover-highlight"]')).not.toBeNull());
    const fill = container.querySelector('[data-slot="fluid-hover-highlight"]');
    // Radix moves `data-highlighted` in its own key handler, after the surface heard the key.
    fireEvent.keyDown(document, { key: "ArrowDown" });
    rerender(<Menu current="Second" />);
    await act(async () => { await Promise.resolve(); });
    expect(second).toHaveAttribute("data-fluid-hover-active");
    expect(first).not.toHaveAttribute("data-fluid-hover-active");
    expect(container.querySelector('[data-slot="fluid-hover-highlight"]')).toBe(fill);
    // The list scrolling under a resting pointer neither moves nor drops it.
    move(first, "mouse", pointerX);
    fireEvent.scroll(container.firstElementChild!);
    expect(second).toHaveAttribute("data-fluid-hover-active");
    fireEvent.keyDown(document, { key: "ArrowDown" });
    rerender(<Menu current="Third" />);
    await act(async () => { await Promise.resolve(); });
    expect(third).toHaveAttribute("data-fluid-hover-active");
    // A real move hands it back to the pointer.
    move(first);
    expect(first).toHaveAttribute("data-fluid-hover-active");
    expect(third).not.toHaveAttribute("data-fluid-hover-active");
  });

  it("opens on a picker's current row and follows the selector it is given", async () => {
    function Picker({ active }: { active: number }) {
      return <div className="fluid-hover-surface" role="listbox">
        <FluidHoverSurface follow='[aria-selected="true"]' />
        {["First", "Second"].map((label, index) => (
          <button key={label} role="option" aria-selected={index === active}>{label}</button>
        ))}
      </div>;
    }
    const { rerender } = render(<Picker active={0} />);
    const [first, second] = screen.getAllByRole("option");
    expect(first).toHaveAttribute("data-fluid-hover-active");
    fireEvent.keyDown(document, { key: "ArrowDown" });
    rerender(<Picker active={1} />);
    await act(async () => { await Promise.resolve(); });
    expect(second).toHaveAttribute("data-fluid-hover-active");
    expect(first).not.toHaveAttribute("data-fluid-hover-active");
  });
});
