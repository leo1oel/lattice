import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { beginWindowDrag, titleBarDoubleClick } from "./app-utils";

const windowApi = vi.hoisted(() => ({ startDragging: vi.fn() }));
const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => windowApi }));
vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));

afterEach(() => {
  cleanup();
  windowApi.startDragging.mockClear();
  invoke.mockClear();
});

function renderBar() {
  const { container } = render(
    <header onMouseDown={beginWindowDrag} onDoubleClick={titleBarDoubleClick}>
      <span className="empty">space</span>
      <button type="button">Switch project</button>
    </header>,
  );
  return {
    space: container.querySelector<HTMLElement>(".empty")!,
    button: container.querySelector<HTMLElement>("button")!,
  };
}

describe("title-bar window drag (#1063)", () => {
  it("moves the window on the first move of a press, with no wait", () => {
    vi.useFakeTimers();
    try {
      const { space } = renderBar();
      fireEvent.mouseDown(space, { button: 0, buttons: 1, detail: 1 });
      expect(windowApi.startDragging).not.toHaveBeenCalled();
      // Synchronously on the move: no timer has to run first.
      fireEvent.mouseMove(window, { buttons: 1 });
      expect(windowApi.startDragging).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      // One press is one drag.
      fireEvent.mouseMove(window, { buttons: 1 });
      expect(windowApi.startDragging).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a stationary click and a double-click to zoom alone", () => {
    const { space } = renderBar();
    fireEvent.mouseDown(space, { button: 0, buttons: 1, detail: 1 });
    fireEvent.mouseUp(space, { button: 0, buttons: 0, detail: 1 });
    fireEvent.mouseDown(space, { button: 0, buttons: 1, detail: 2 });
    fireEvent.mouseUp(space, { button: 0, buttons: 0, detail: 2 });
    fireEvent.doubleClick(space, { button: 0, detail: 2 });
    fireEvent.mouseMove(window, { buttons: 0 });
    expect(windowApi.startDragging).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("title_bar_double_click");
  });

  it("does not drag after the press has ended or from a move with the button up", () => {
    const { space } = renderBar();
    fireEvent.mouseDown(space, { button: 0, buttons: 1, detail: 1 });
    fireEvent.mouseUp(window, { button: 0, buttons: 0 });
    fireEvent.mouseMove(window, { buttons: 1 });
    fireEvent.mouseDown(space, { button: 0, buttons: 1, detail: 1 });
    fireEvent.mouseMove(window, { buttons: 0 });
    fireEvent.mouseMove(window, { buttons: 1 });
    expect(windowApi.startDragging).not.toHaveBeenCalled();
  });

  it("keeps a press on a title-bar control for the control", () => {
    const { button } = renderBar();
    fireEvent.mouseDown(button, { button: 0, buttons: 1, detail: 1 });
    fireEvent.mouseMove(window, { buttons: 1 });
    expect(windowApi.startDragging).not.toHaveBeenCalled();
  });
});
