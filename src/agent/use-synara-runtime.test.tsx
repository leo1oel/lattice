import { act, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearAppLogs, getAppLogEntry, getAppToastOptions, getVisibleAppToastIds } from "../telemetry/app-log-store";
import type { SynaraRuntimeInfo } from "./synara-runtime";
import { useSynaraRuntime } from "./use-synara-runtime";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const tauriEvents = vi.hoisted(() => new Map<string, Set<(event: { payload: unknown }) => void>>());
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    const handlers = tauriEvents.get(name) ?? new Set();
    handlers.add(handler);
    tauriEvents.set(name, handlers);
    return () => handlers.delete(handler);
  }),
}));

function emit(name: string, payload: unknown = null) {
  act(() => tauriEvents.get(name)?.forEach((handler) => handler({ payload })));
}

const restartOffer = () => getVisibleAppToastIds()
  .map((id) => ({ entry: getAppLogEntry(id), options: getAppToastOptions(id) }))
  .find(({ entry }) => entry?.title === "The system proxy changed");

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
    tauriEvents.clear();
    clearAppLogs();
  });

  it("does not start before a Synara surface is requested, then starts and adopts the supervisor status", async () => {
    vi.mocked(invoke).mockResolvedValue(READY_RUNTIME);
    const { result, rerender } = renderHook(
      ({ enabled }) => useSynaraRuntime(enabled),
      { initialProps: { enabled: false } },
    );

    expect(result.current.runtime.state).toBe("starting");
    await act(async () => Promise.resolve());
    expect(invoke).not.toHaveBeenCalled();
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

  // P2: the agent's environment is fixed when it starts, so a proxy turned
  // on afterwards (Clash, Surge) must be offered as a restart, not ignored
  // until Lattice quits.
  it("offers a restart when the system proxy moves away from what the agent started with", async () => {
    vi.mocked(invoke).mockResolvedValue(READY_RUNTIME);
    renderHook(() => useSynaraRuntime(true));
    await waitFor(() => expect(tauriEvents.get("synara-environment-changed")?.size).toBe(1));

    emit("synara-environment-changed", { stale: true });
    const offer = restartOffer();
    expect(offer?.options?.primaryAction?.label).toBe("Restart agent");
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await act(async () => { await offer?.options?.primaryAction?.onClick(); });
    expect(invoke).toHaveBeenLastCalledWith("synara_restart");

    // Switched back before anyone restarted: nothing left to offer.
    emit("synara-environment-changed", { stale: true });
    expect(restartOffer()).toBeDefined();
    emit("synara-environment-changed", { stale: false });
    expect(restartOffer()).toBeUndefined();
  });

  it("starts the new agent service after any window restarts it", async () => {
    const restarted: SynaraRuntimeInfo = { ...READY_RUNTIME, authToken: "new-token" };
    vi.mocked(invoke).mockResolvedValueOnce(READY_RUNTIME).mockResolvedValueOnce(restarted);
    const { result } = renderHook(() => useSynaraRuntime(true));
    await waitFor(() => expect(result.current.runtime).toEqual(READY_RUNTIME));
    await waitFor(() => expect(tauriEvents.get("synara-runtime-restarted")?.size).toBe(1));

    emit("synara-environment-changed", { stale: true });
    emit("synara-runtime-restarted");
    expect(restartOffer()).toBeUndefined();
    await waitFor(() => expect(result.current.runtime).toEqual(restarted));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("ignores restarts while this window has not used the agent", async () => {
    renderHook(() => useSynaraRuntime(false));
    await act(async () => Promise.resolve());
    expect(tauriEvents.get("synara-runtime-restarted")?.size ?? 0).toBe(0);
  });
});
