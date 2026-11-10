import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStableHandlers, visibleInterval } from "./effect-helpers";

afterEach(cleanup);

it("keeps each forwarder's identity while calling the handler from the latest render", () => {
  const first = vi.fn((value: number) => value + 1);
  const second = vi.fn((value: number) => value + 2);
  const view = renderHook(({ onValue }) => useStableHandlers({ onValue }), { initialProps: { onValue: first } });
  const forwarders = view.result.current;
  expect(forwarders.onValue(1)).toBe(2);

  view.rerender({ onValue: second });
  expect(view.result.current).toBe(forwarders);
  expect(forwarders.onValue(1)).toBe(3);
  expect(first).toHaveBeenCalledTimes(1);
});

it("rests a visible-only poll while the window is hidden and checks at once when it is back", () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = "visible";
  const descriptor = vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const show = (next: DocumentVisibilityState) => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  try {
    const tick = vi.fn();
    const stop = visibleInterval(tick, 1000);
    vi.advanceTimersByTime(2000);
    expect(tick).toHaveBeenCalledTimes(2);

    show("hidden");
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(2);

    // Back on screen: one catch-up tick now, then the usual period.
    show("visible");
    expect(tick).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(4);

    stop();
    show("hidden");
    show("visible");
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(4);
  } finally {
    descriptor.mockRestore();
    vi.useRealTimers();
  }
});
