import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { lazy, Suspense, useState, useTransition, type ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLoadingShell } from "./use-loading-shell";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("never shows for an opening that ends within 150 ms", () => {
  const view = renderHook(({ pending }) => useLoadingShell(pending, true), { initialProps: { pending: true } });
  act(() => vi.advanceTimersByTime(149));
  expect(view.result.current).toBe(false);
  view.rerender({ pending: false });
  act(() => vi.advanceTimersByTime(1000));
  expect(view.result.current).toBe(false);
});

it("shows at 150 ms and stays 300 ms when the opening ends just after", () => {
  const view = renderHook(({ pending }) => useLoadingShell(pending, true), { initialProps: { pending: true } });
  act(() => vi.advanceTimersByTime(150));
  expect(view.result.current).toBe(true);
  act(() => vi.advanceTimersByTime(10));
  view.rerender({ pending: false });
  act(() => vi.advanceTimersByTime(289));
  expect(view.result.current).toBe(true);
  act(() => vi.advanceTimersByTime(1));
  expect(view.result.current).toBe(false);
});

it("leaves with an opening that outlasts its minimum time", () => {
  const view = renderHook(({ pending }) => useLoadingShell(pending, true), { initialProps: { pending: true } });
  act(() => vi.advanceTimersByTime(800));
  expect(view.result.current).toBe(true);
  view.rerender({ pending: false });
  act(() => vi.advanceTimersByTime(0));
  expect(view.result.current).toBe(false);
});

it("leaves at once when its tool is no longer wanted, and does not come back with it", () => {
  const view = renderHook(({ pending, wanted }) => useLoadingShell(pending, wanted), {
    initialProps: { pending: true, wanted: true },
  });
  act(() => vi.advanceTimersByTime(200));
  expect(view.result.current).toBe(true);
  view.rerender({ pending: true, wanted: false });
  expect(view.result.current).toBe(false);
  view.rerender({ pending: false, wanted: false });
  act(() => vi.advanceTimersByTime(0));
  view.rerender({ pending: false, wanted: true });
  expect(view.result.current).toBe(false);
});

// A tool whose chunk is held for 160 ms, just past the shell's delay: the
// shell appears at 150 ms and lies over the arrived tool until 450 ms.
it("does not flash over a tool whose chunk arrives at 160 ms", async () => {
  const Tool = lazy(() => new Promise<{ default: () => ReactElement }>((resolve) => {
    setTimeout(() => resolve({ default: () => <p>tool</p> }), 160);
  }));
  function Opener() {
    const [open, setOpen] = useState(false);
    const [opening, startOpening] = useTransition();
    const shell = useLoadingShell(opening, true);
    return (
      <>
        <button type="button" onClick={() => startOpening(() => setOpen(true))}>open</button>
        {shell && <p>shell</p>}
        <Suspense fallback={null}>{open && <Tool />}</Suspense>
      </>
    );
  }
  render(<Opener />);
  fireEvent.click(screen.getByText("open"));
  await act(() => vi.advanceTimersByTimeAsync(149));
  expect(screen.queryByText("shell")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByText("shell")).not.toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(20));
  expect(screen.queryByText("tool")).not.toBeNull();
  expect(screen.queryByText("shell")).not.toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(279));
  expect(screen.queryByText("shell")).not.toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(screen.queryByText("shell")).toBeNull();
  expect(screen.queryByText("tool")).not.toBeNull();
});
