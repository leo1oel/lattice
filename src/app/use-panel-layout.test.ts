import { act, cleanup, renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { usePanelLayout } from "./use-panel-layout";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

function setup() {
  const hook = renderHook(() => usePanelLayout(180));
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
  pointer("pointermove", start + 3);
  pointer("pointerup", start + 3, 8);
  expect(result.current.sidebarResizing).toBe(true);
  pointer("pointerup", start + 3);
  expect(result.current.sidebarOpen).toBe(false);
  expect(result.current.sidebarWidth).toBe(start);
  act(() => result.current.setSidebarOpen(true));
  begin();
  pointer("pointermove", start + 37);
  pointer("pointerup", start + 37);
  expect(result.current.sidebarOpen).toBe(true);
  expect(result.current.sidebarWidth).toBe(start + 37);
});

it("previews only beyond the collapse threshold, rescues before release, and restores width on reopen", () => {
  const { result, begin, pointer } = setup();
  begin();
  pointer("pointermove", 124); // Minimum 180 minus the 56px overshoot.
  expect(result.current.sidebarCollapsePreview).toBe(false);
  expect(result.current.sidebarWidth).toBe(180);
  pointer("pointermove", 123);
  expect(result.current.sidebarCollapsePreview).toBe(true);
  expect(result.current.sidebarOpen).toBe(true);
  pointer("pointermove", 231);
  expect(result.current.sidebarCollapsePreview).toBe(false);
  pointer("pointerup", 231);
  expect(result.current.sidebarWidth).toBe(231);
  begin();
  pointer("pointermove", 110);
  pointer("pointerup", 110);
  expect(result.current.sidebarOpen).toBe(false);
  act(() => result.current.setSidebarOpen(true));
  expect(result.current.sidebarWidth).toBe(231);
  expect(result.current.sidebarCollapsePreview).toBe(false);
});

it.each(["pointercancel", "blur"])("cancels a collapse preview on %s without closing", (event) => {
  const { result, begin, pointer } = setup();
  const start = result.current.sidebarWidth;
  begin();
  pointer("pointermove", 100);
  act(() => window.dispatchEvent(event === "blur" ? new Event(event) : new PointerEvent(event, { pointerId: 7 })));
  expect(result.current.sidebarOpen).toBe(true);
  expect(result.current.sidebarWidth).toBe(start);
  expect(result.current.sidebarCollapsePreview).toBe(false);
  expect(document.body).not.toHaveClass("resizing-panels");
});
