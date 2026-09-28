import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableDrawer } from "./resizable-drawer";

const windowApi = vi.hoisted(() => ({
  startDragging: vi.fn(), isFullscreen: vi.fn(async () => false), setFullscreen: vi.fn(async () => undefined),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowApi }));

function renderDrawer(onClose = () => undefined) {
  const view = render(<ResizableDrawer onClose={onClose}>content</ResizableDrawer>);
  return {
    ...view,
    drawer: view.container.querySelector<HTMLElement>(".resizable-drawer")!,
    separator: screen.getByRole("separator", { name: "Resize right panel" }),
  };
}

describe("ResizableDrawer", () => {
  afterEach(cleanup);

  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1200 });
  });

  it("opens at one third of the page and resets after a manual resize", () => {
    const first = renderDrawer();
    expect(first.drawer.style.width).toBe("400px");

    fireEvent.pointerDown(first.separator, { clientX: 740, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 640, pointerId: 1 });
    expect(first.drawer.style.width).toBe("500px");
    expect(first.container.querySelector(".drawer-resize-shield")).not.toBeNull();

    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(document.body).not.toHaveClass("resizing-panels");
    expect(first.container.querySelector(".drawer-resize-shield")).toBeNull();
    expect(localStorage.getItem("lattice.right-drawer-width.v1")).toBeNull();

    first.unmount();
    expect(renderDrawer().drawer.style.width).toBe("400px");
  });

  it("supports keyboard resizing clamped to the workspace, and closes on Escape unless closing is disabled", () => {
    const onClose = vi.fn();
    const { drawer, separator, rerender } = renderDrawer(onClose);

    expect(drawer.style.width).toBe("400px");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(drawer.style.width).toBe("416px");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(drawer.style.width).toBe("400px");

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
    fireEvent(window, new Event("resize"));
    expect(drawer.style.width).toBe("320px");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(drawer.style.width).toBe("320px");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<ResizableDrawer closeDisabled onClose={onClose}>content</ResizableDrawer>);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("drags the window from the titlebar strip instead of dismissing", async () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const { container } = renderDrawer(onClose);
      const strip = container.querySelector<HTMLElement>(".drawer-window-drag-strip")!;

      expect(strip.style.right).toBe("400px");
      fireEvent.mouseDown(strip, { button: 0, buttons: 1 });
      await vi.runAllTimersAsync();
      expect(windowApi.startDragging).toHaveBeenCalledOnce();
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.mouseDown(container.querySelector(".drawer-backdrop")!, { button: 0, buttons: 1 });
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      windowApi.startDragging.mockClear();
    }
  });
});
