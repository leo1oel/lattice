import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SynaraRuntimeInfo } from "./synara-runtime";
import { useSynaraRuntime } from "./use-synara-runtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const READY_RUNTIME: SynaraRuntimeInfo = {
  state: "ready",
  origin: "http://127.0.0.1:4173",
  authToken: "token",
  message: null,
  startupMs: 120,
  version: "0.7.2",
  revision: "abc123",
};

describe("useSynaraRuntime", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("does not start before a Synara surface is requested", async () => {
    const { result } = renderHook(() => useSynaraRuntime(false));

    expect(result.current.runtime.state).toBe("starting");
    await act(async () => Promise.resolve());
    expect(invoke).not.toHaveBeenCalled();
  });

  it("starts on enable and adopts the supervisor status", async () => {
    vi.mocked(invoke).mockResolvedValue(READY_RUNTIME);
    const { result, rerender } = renderHook(
      ({ enabled }) => useSynaraRuntime(enabled),
      { initialProps: { enabled: false } },
    );

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.runtime).toEqual(READY_RUNTIME));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("synara_ensure_ready");
  });

  it("retries a failed startup only when requested", async () => {
    vi.mocked(invoke)
      .mockRejectedValueOnce(new Error("startup failed"))
      .mockResolvedValueOnce(READY_RUNTIME);
    const { result } = renderHook(() => useSynaraRuntime(true));

    await waitFor(() => expect(result.current.runtime.message).toBe("startup failed"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.runtime).toEqual(READY_RUNTIME));
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
