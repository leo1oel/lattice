import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableDrawer } from "./resizable-drawer";

describe("ResizableDrawer", () => {
  afterEach(cleanup);

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  });

  it("opens at one third of the page and resets after a manual resize", () => {
    const first = render(
      <ResizableDrawer onClose={() => undefined}>content</ResizableDrawer>,
    );
    const separator = screen.getByRole("separator", { name: "Resize right panel" });
    const drawer = first.container.querySelector<HTMLElement>(".resizable-drawer");

    expect(drawer?.style.width).toBe("400px");

    fireEvent.pointerDown(separator, { clientX: 740, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 640, pointerId: 1 });
    expect(drawer?.style.width).toBe("500px");
    expect(first.container.querySelector(".drawer-resize-shield")).not.toBeNull();

    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(document.body).not.toHaveClass("resizing-panels");
    expect(first.container.querySelector(".drawer-resize-shield")).toBeNull();
    expect(localStorage.getItem("lattice.right-drawer-width.v1")).toBeNull();

    first.unmount();
    const second = render(
      <ResizableDrawer onClose={() => undefined}>content</ResizableDrawer>,
    );
    expect(second.container.querySelector<HTMLElement>(".resizable-drawer")?.style.width).toBe("400px");
  });

  it("supports keyboard resizing and clamps to the available workspace", () => {
    const { container } = render(
      <ResizableDrawer onClose={() => undefined}>content</ResizableDrawer>,
    );
    const separator = screen.getByRole("separator", { name: "Resize right panel" });
    const drawer = container.querySelector<HTMLElement>(".resizable-drawer");

    expect(drawer?.style.width).toBe("400px");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(drawer?.style.width).toBe("416px");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(drawer?.style.width).toBe("400px");

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
    fireEvent(window, new Event("resize"));
    expect(drawer?.style.width).toBe("320px");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(drawer?.style.width).toBe("320px");
  });

  it("closes on Escape unless the current operation disables closing", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <ResizableDrawer onClose={onClose}>content</ResizableDrawer>,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(
      <ResizableDrawer closeDisabled onClose={onClose}>content</ResizableDrawer>,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
