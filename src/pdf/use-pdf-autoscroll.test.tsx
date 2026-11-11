import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerRecord } from "./pdf-slick";
import { usePdfAutoscroll } from "./use-pdf-autoscroll";

let callbacks: Map<number, FrameRequestCallback>;
let sequence: number;
let time: number;
beforeEach(() => {
  callbacks = new Map();
  sequence = 0;
  time = performance.now();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.set(++sequence, callback);
    return sequence;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
function mount() {
  const root = document.createElement("div");
  document.body.append(root);
  root.scrollTop = 500;
  const ref = { current: { root } as ViewerRecord };
  const hook = renderHook(() => usePdfAutoscroll(ref, 1));
  return { root, ...hook };
}
function frame() {
  time += 16;
  const pending = [...callbacks.values()];
  callbacks.clear();
  act(() => { for (const callback of pending) callback(time); });
}

describe("PDF middle-click autoscroll", () => {
  it("pauses at the origin, speeds up with distance and reverses above it", () => {
    const { root } = mount();
    expect(fireEvent.mouseDown(root, { button: 1, clientY: 100 })).toBe(false);
    frame();
    expect(root.scrollTop).toBe(500);
    fireEvent.mouseMove(document, { clientY: 130 });
    frame();
    const slow = root.scrollTop - 500;
    expect(slow).toBeGreaterThan(0);
    fireEvent.mouseMove(document, { clientY: 200 });
    const before = root.scrollTop;
    frame();
    expect(root.scrollTop - before).toBeGreaterThan(slow);
    fireEvent.mouseMove(document, { clientY: 0 });
    const below = root.scrollTop;
    frame();
    expect(root.scrollTop).toBeLessThan(below);
    fireEvent.mouseMove(document, { clientY: 105 });
    const stopped = root.scrollTop;
    frame();
    expect(root.scrollTop).toBe(stopped);
  });

  it.each(["escape", "click", "blur", "wheel", "unmount"])("stops on %s and cancels its animation", (reason) => {
    const { root, unmount } = mount();
    fireEvent.mouseDown(root, { button: 1, clientY: 100 });
    fireEvent.mouseMove(document, { clientY: 200 });
    frame();
    if (reason === "escape") fireEvent.keyDown(document, { key: "Escape" });
    if (reason === "click") fireEvent.mouseDown(document, { button: 0 });
    if (reason === "blur") fireEvent.blur(window);
    if (reason === "wheel") fireEvent.wheel(root, { deltaY: 100 });
    if (reason === "unmount") unmount();
    const position = root.scrollTop;
    frame();
    expect(root.scrollTop).toBe(position);
    expect(callbacks.size).toBe(0);
    expect(root.classList.contains("pdf-autoscrolling")).toBe(false);
  });

  it.each([0, 1])("claims the start and stop releases without PDF selection (stop button %s)", (button) => {
    const { root } = mount();
    const selection = vi.fn();
    root.addEventListener("mouseup", selection);
    fireEvent.mouseDown(root, { button: 1, clientY: 100 });
    expect(fireEvent.mouseUp(root, { button: 1 })).toBe(false);
    fireEvent.mouseDown(root, { button });
    expect(fireEvent.mouseUp(root, { button })).toBe(false);
    expect(selection).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(0);
  });

  it("leaves ordinary clicks and middle-click links alone", () => {
    const { root } = mount();
    const link = document.createElement("a");
    link.href = "#reference";
    root.append(link);
    expect(fireEvent.mouseDown(root, { button: 0 })).toBe(true);
    expect(fireEvent.mouseDown(link, { button: 1 })).toBe(true);
    frame();
    expect(callbacks.size).toBe(0);
    expect(root.scrollTop).toBe(500);
  });
});
