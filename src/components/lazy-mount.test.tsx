import { act, cleanup, render, screen } from "@testing-library/react";
import { lazy, useReducer } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LazyMountOnce } from "./lazy-mount";

/** A screen that keeps a count across closing, as Find keeps its query. */
function Counter({ open }: { open: boolean }) {
  const [count, increment] = useReducer((value: number) => value + 1, 0);
  if (!open) return null;
  return <button type="button" onClick={increment}>{`count ${count}`}</button>;
}

afterEach(cleanup);

describe("LazyMountOnce", () => {
  it("loads nothing until its first opening, then keeps the screen's state across closing", async () => {
    const load = vi.fn(async () => ({ default: Counter }));
    const LazyCounter = lazy(load);
    const view = (open: boolean) => <LazyMountOnce when={open}><LazyCounter open={open} /></LazyMountOnce>;

    const { rerender } = render(view(false));
    rerender(view(false));
    expect(load).not.toHaveBeenCalled();

    rerender(view(true));
    const button = await screen.findByRole("button", { name: "count 0" });
    act(() => button.click());
    expect(screen.getByRole("button", { name: "count 1" })).toBeInTheDocument();

    rerender(view(false));
    expect(screen.queryByRole("button")).toBeNull();
    rerender(view(true));
    expect(screen.getByRole("button", { name: "count 1" })).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
  });
});
