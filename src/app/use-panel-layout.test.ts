import { act, cleanup, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadSidebarWidth } from "../settings/app-settings";
import { usePanelLayout } from "./use-panel-layout";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function setup() {
  const hook = renderHook(({ minimum }) => usePanelLayout(minimum), { initialProps: { minimum: 180 } });
  const target = document.createElement("div");
  const begin = (button = 0) => act(() => hook.result.current.beginSidebarResize({
    button, clientX: hook.result.current.sidebarWidth, pointerId: 7,
    currentTarget: target, preventDefault() {},
  } as unknown as ReactPointerEvent<HTMLDivElement>));
  const pointer = (type: string, clientX = 0, pointerId = 7) => act(() => {
    window.dispatchEvent(new PointerEvent(type, { clientX, pointerId }));
  });
  return { ...hook, begin, pointer };
}

it("distinguishes click jitter, real resizing, and unrelated pointer releases", () => {
  const { result, begin, pointer } = setup();
  const start = result.current.sidebarWidth;
  begin(2);
  expect(result.current.sidebarResizing).toBe(false);
  begin();
  pointer("pointermove", start + 1);
  pointer("pointerup", start + 1, 8);
  expect(result.current.sidebarResizing).toBe(true);
  pointer("pointerup", start + 1);
  expect(result.current.sidebarOpen).toBe(false);
  expect(result.current.sidebarWidth).toBe(start);
  act(() => result.current.setSidebarOpen(true));
  begin();
  pointer("pointermove", start - 2.5);
  pointer("pointerup", start - 2.5);
  expect(result.current.sidebarOpen).toBe(true);
  expect(result.current.sidebarWidth).toBe(start - 2.5);
  begin();
  pointer("pointermove", start + 37);
  pointer("pointerup", start + 37);
  expect(result.current.sidebarOpen).toBe(true);
  expect(result.current.sidebarWidth).toBe(start + 37);
});

it("previews only beyond the collapse threshold, rescues before release, and restores width on reopen", () => {
  const { result, begin, pointer } = setup();
  begin();
  pointer("pointermove", 84); // Minimum 180 minus the 96px overshoot.
  expect(result.current.sidebarCollapsePreview).toBe(false);
  expect(result.current.sidebarWidth).toBe(180);
  pointer("pointermove", 83);
  expect(result.current.sidebarCollapsePreview).toBe(true);
  expect(result.current.sidebarOpen).toBe(true);
  pointer("pointermove", 100); // Reversing a little must not flicker open.
  expect(result.current.sidebarCollapsePreview).toBe(true);
  pointer("pointermove", 132);
  expect(result.current.sidebarCollapsePreview).toBe(false);
  expect(result.current.sidebarRestoring).toBe(true);
  act(() => result.current.finishSidebarRestore());
  expect(result.current.sidebarRestoring).toBe(false);
  pointer("pointermove", 231);
  expect(result.current.sidebarCollapsePreview).toBe(false);
  pointer("pointerup", 231);
  expect(result.current.sidebarWidth).toBe(231);
  begin();
  pointer("pointermove", 80);
  pointer("pointerup", 80);
  expect(result.current.sidebarOpen).toBe(false);
  act(() => result.current.setSidebarOpen(true));
  expect(result.current.sidebarWidth).toBe(231);
  expect(result.current.sidebarCollapsePreview).toBe(false);
});

it.each(["pointercancel", "blur"])("cancels a collapse preview on %s without closing", (event) => {
  const { result, begin, pointer } = setup();
  const start = result.current.sidebarWidth;
  begin();
  pointer("pointermove", 80);
  act(() => window.dispatchEvent(event === "blur" ? new Event(event) : new PointerEvent(event, { pointerId: 7 })));
  expect(result.current.sidebarOpen).toBe(true);
  expect(result.current.sidebarWidth).toBe(start);
  expect(result.current.sidebarCollapsePreview).toBe(false);
  expect(document.body).not.toHaveClass("resizing-panels");
});

it("rubber-bands below the minimum without persisting the visual width", () => {
  const { result, begin, pointer } = setup();
  begin();
  pointer("pointermove", 240);
  expect(result.current.sidebarDragWidth).toBe(240);
  pointer("pointermove", 120);
  expect(result.current.sidebarWidth).toBe(180);
  expect(result.current.sidebarDragWidth).toBeGreaterThan(150);
  expect(result.current.sidebarDragWidth).toBeLessThan(180);
  expect(result.current.sidebarCollapsePreview).toBe(false);
  pointer("pointerup", 120);
  expect(result.current.sidebarOpen).toBe(true);
  expect(result.current.sidebarDragWidth).toBeNull();
  expect(result.current.sidebarWidth).toBe(180);
  expect(loadSidebarWidth()).toBe(180);
});

it("bounds the upper overshoot and clears it on cancellation", () => {
  const { result, begin, pointer } = setup();
  begin();
  pointer("pointermove", window.innerWidth + 1000);
  const maximum = window.innerWidth - 600;
  expect(result.current.sidebarWidth).toBe(maximum);
  expect(result.current.sidebarDragWidth).toBeGreaterThan(maximum);
  expect(result.current.sidebarDragWidth).toBeLessThanOrEqual(maximum + 48);
  pointer("pointercancel");
  expect(result.current.sidebarDragWidth).toBeNull();
  expect(result.current.sidebarOpen).toBe(true);
});

it("uses a new minimum for sizing without moving the active gesture's collapse threshold", () => {
  const { result, begin, pointer, rerender } = setup();
  begin();
  rerender({ minimum: 400 });
  pointer("pointermove", 290);
  expect(result.current.sidebarWidth).toBe(400);
  expect(result.current.sidebarCollapsePreview).toBe(false);
  pointer("pointerup", 290);
  expect(result.current.sidebarOpen).toBe(true);
});
