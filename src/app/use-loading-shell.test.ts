import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLoadingShell } from "./use-loading-shell";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("is late only once an opening has been pending for 150 ms, through the commit that ends it", () => {
  vi.useFakeTimers();
  const view = renderHook(({ pending }) => useLoadingShell(pending), { initialProps: { pending: true } });
  act(() => vi.advanceTimersByTime(149));
  expect(view.result.current).toBe(false);
  act(() => vi.advanceTimersByTime(1));
  expect(view.result.current).toBe(true);

  const seen: boolean[] = [];
  const settled = renderHook(({ pending }) => {
    const late = useLoadingShell(pending);
    seen.push(late);
    return late;
  }, { initialProps: { pending: true } });
  act(() => vi.advanceTimersByTime(150));
  seen.length = 0;
  settled.rerender({ pending: false });
  expect(seen[0]).toBe(true);
  expect(settled.result.current).toBe(false);
});

it("never turns late for an opening that ends sooner", () => {
  vi.useFakeTimers();
  const view = renderHook(({ pending }) => useLoadingShell(pending), { initialProps: { pending: true } });
  act(() => vi.advanceTimersByTime(100));
  view.rerender({ pending: false });
  act(() => vi.advanceTimersByTime(500));
  expect(view.result.current).toBe(false);
});
