import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWindowMinimumSize, type LiveValue } from "./use-native-window";
import { APP_WINDOW_MIN_HEIGHT } from "./window-layout";

const nativeWindow = vi.hoisted(() => ({
  setMinSize: vi.fn(async (_size: { width: number; height: number }) => {}),
  onMoved: vi.fn(async () => () => {}),
  // A 1440 pt Retina screen: AppKit reports its visible area in device pixels.
  currentMonitor: vi.fn(async () => ({ scaleFactor: 2, workArea: { size: { width: 2880, height: 1800 } } })),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => nativeWindow, currentMonitor: nativeWindow.currentMonitor }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => vi.clearAllMocks());

/** A layout minimum that can change after the hook subscribes. */
function liveMinimum(initial: number): LiveValue<number> & { set(value: number): void } {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set(next) {
      value = next;
      listeners.forEach((listener) => listener());
    },
  };
}

const lastMinimum = () => {
  const size = nativeWindow.setMinSize.mock.calls.at(-1)?.[0];
  return size && { width: size.width, height: size.height };
};

describe("useWindowMinimumSize", () => {
  it("follows the layout's minimum at interface zoom 1.0", async () => {
    const layout = liveMinimum(1100);
    renderHook(() => useWindowMinimumSize(1, layout));
    await waitFor(() => expect(lastMinimum()).toEqual({ width: 1100, height: APP_WINDOW_MIN_HEIGHT }));
    layout.set(1180);
    await waitFor(() => expect(lastMinimum()).toEqual({ width: 1180, height: APP_WINDOW_MIN_HEIGHT }));
  });

  it("clamps the zoomed minimum at interface zoom 1.35 to the screen's visible width", async () => {
    renderHook(() => useWindowMinimumSize(1.35, liveMinimum(1100)));
    await waitFor(() => expect(lastMinimum()).toEqual({ width: 1440, height: APP_WINDOW_MIN_HEIGHT }));
  });
});
