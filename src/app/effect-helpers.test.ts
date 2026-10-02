import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStableHandlers } from "./effect-helpers";

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
