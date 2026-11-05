import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invokeCalls, mockInvoke } from "../platform/tauri-test-mocks";
import { useOverleafLogin } from "./use-overleaf-login";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => vi.useRealTimers());
beforeEach(() => vi.clearAllMocks());

const session = { connected: true, email: "researcher@example.edu", name: "Researcher", host: "https://www.overleaf.com" };

it("continues pending login polls and delivers the connected session to the current callback", async () => {
  vi.useFakeTimers();
  let polls = 0;
  mockInvoke({
    overleaf_begin_login: undefined,
    overleaf_poll_login: () => ++polls < 3 ? { status: "pending", session: null } : { status: "connected", session },
  });
  const first = vi.fn();
  const current = vi.fn();
  const { result, rerender } = renderHook(({ onConnected }) => useOverleafLogin(onConnected), { initialProps: { onConnected: first } });
  await act(async () => { result.current.begin(); });
  expect(result.current.pending).toBe(true);
  expect(polls).toBe(1);
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(polls).toBe(2);
  rerender({ onConnected: current });
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(current).toHaveBeenCalledExactlyOnceWith(session);
  expect(first).not.toHaveBeenCalled();
  expect(result.current.pending).toBe(false);
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(polls).toBe(3);
});

it("does not poll again after cancellation or unmount", async () => {
  vi.useFakeTimers();
  mockInvoke({ overleaf_begin_login: undefined, overleaf_poll_login: { status: "pending", session: null } });
  const connected = vi.fn();
  const { result, unmount } = renderHook(() => useOverleafLogin(connected));
  await act(async () => { result.current.begin(); });
  expect(invokeCalls("overleaf_poll_login")).toHaveLength(1);
  act(() => result.current.cancel());
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(invokeCalls("overleaf_poll_login")).toHaveLength(1);
  expect(result.current.pending).toBe(false);
  await act(async () => { result.current.begin(); });
  expect(invokeCalls("overleaf_poll_login")).toHaveLength(2);
  unmount();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(invokeCalls("overleaf_poll_login")).toHaveLength(2);
  expect(connected).not.toHaveBeenCalled();
});

it.each(["cancel", "unmount"])("ignores a connected response that arrives after %s", async (transition) => {
  vi.useFakeTimers();
  let resolveLate = (_value: unknown) => {};
  const response = new Promise((resolve) => { resolveLate = resolve; });
  mockInvoke({ overleaf_begin_login: undefined, overleaf_poll_login: () => response });
  const connected = vi.fn();
  const { result, unmount } = renderHook(() => useOverleafLogin(connected));
  await act(async () => { result.current.begin(); });
  expect(result.current.pending).toBe(true);
  if (transition === "cancel") act(() => result.current.cancel());
  else unmount();
  await act(async () => { resolveLate({ status: "connected", session }); await response; });
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(connected).not.toHaveBeenCalled();
  expect(invokeCalls("overleaf_poll_login")).toHaveLength(1);
});
