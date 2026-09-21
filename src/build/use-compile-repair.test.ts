import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useCompileRepair } from "./use-compile-repair";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const diagnostic = { level: "warning", message: "Undefined reference: fig:example", file: "chapters/results.tex", line: 17 };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe("user-triggered compile repair", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(invoke).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it("saves first, submits all errors and warnings with the selected permissions, then recompiles once", async () => {
    const saved = deferred<boolean>();
    const onComplete = vi.fn(async () => {});
    const error = { level: "error", message: "Undefined control sequence", file: "main.tex", line: 42 };
    const diagnostics = [diagnostic, error, { level: "info", message: "Build note" }];
    let status = "awaiting-approval";
    vi.mocked(invoke).mockImplementation(async (_command, args) => (
      (args as { action: string }).action === "start" ? { threadId: "repair-1" } : { status }
    ));
    const { result } = renderHook(() => useCompileRepair({ projectRoot: "/paper", rootDocument: "main.tex", runtimeMode: "full-access", enabled: true, save: () => saved.promise, onComplete }));
    let work!: Promise<void>;
    act(() => { work = result.current.start(diagnostics); });
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => { saved.resolve(true); });
    expect(result.current.state?.status).toBe("awaiting-approval");
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => { await result.current.start(diagnostics); });
    expect(vi.mocked(invoke).mock.calls.filter(([, args]) => (args as { action: string }).action === "start")).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith("compile_repair", {
      action: "start", projectRoot: "/paper", rootDocument: "main.tex",
      diagnostics: [diagnostic, error], runtimeMode: "full-access",
    });
    status = "completed";
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); await work; });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(result.current.state?.status).toBe("completed");
    expect(result.current.busy).toBe(false);
  });

  it.each(["approval-required", "auto", "full-access"] as const)("uses the latest panel mode: %s", async (runtimeMode) => {
    vi.mocked(invoke).mockImplementation(async (_command, args) => (
      (args as { action: string }).action === "start" ? { threadId: "repair-1" } : { status: "completed" }
    ));
    const { result, rerender } = renderHook(({ mode }) => useCompileRepair({
      projectRoot: "/paper", rootDocument: undefined, runtimeMode: mode, enabled: true,
      save: async () => true, onComplete: async () => {},
    }), { initialProps: { mode: "full-access" as "approval-required" | "auto" | "full-access" } });
    rerender({ mode: runtimeMode });
    await act(async () => { await result.current.start([{ level: "info", message: "Note" }]); });
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => { await result.current.start([diagnostic]); });
    expect(invoke).toHaveBeenCalledWith("compile_repair", expect.objectContaining({ action: "start", runtimeMode }));
  });

  it("cancels an outgoing project's late start without recompiling the new project", async () => {
    const started = deferred<{ threadId: string }>();
    const onComplete = vi.fn(async () => {});
    vi.mocked(invoke).mockImplementation(async (_command, args) => (
      (args as { action: string }).action === "start" ? started.promise : { status: "completed" }
    ));
    const { result, rerender } = renderHook(({ root }) => useCompileRepair({ projectRoot: root, rootDocument: "main.tex", runtimeMode: "auto", enabled: true, save: async () => true, onComplete }), { initialProps: { root: "/old" } });
    let work!: Promise<void>;
    await act(async () => { work = result.current.start([diagnostic]); });
    rerender({ root: "/new" });
    await act(async () => { started.resolve({ threadId: "old-task" }); await work; });
    expect(invoke).toHaveBeenCalledWith("compile_repair", { action: "cancel", projectRoot: "/old", threadId: "old-task" });
    expect(onComplete).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });

  it("keeps the writer busy after a status transport error or cancel acknowledgment until it stops", async () => {
    const onComplete = vi.fn(async () => {});
    let polls = 0;
    let stopped = false;
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const action = (args as { action: string }).action;
      if (action === "start") return { threadId: "repair-1" };
      if (action === "cancel") return { status: "running" };
      if (polls++ === 0) throw new Error("connection lost");
      return { status: stopped ? "failed" : "running", message: stopped ? "Cancelled" : undefined };
    });
    const { result } = renderHook(() => useCompileRepair({ projectRoot: "/paper", rootDocument: undefined, runtimeMode: "approval-required", enabled: true, save: async () => true, onComplete }));
    let work!: Promise<void>;
    await act(async () => { work = result.current.start([diagnostic]); });
    expect(result.current.busy).toBe(true);
    expect(result.current.state?.message).toContain("connection lost");
    await act(async () => { await result.current.cancel(); });
    expect(result.current.busy).toBe(true);
    stopped = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); await work; });
    expect(result.current.busy).toBe(false);
    expect(result.current.state?.status).toBe("failed");
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("keeps a cancelled in-flight start locked until its returned task is stopped", async () => {
    const started = deferred<{ threadId: string }>();
    const onComplete = vi.fn(async () => {});
    let stopped = false;
    vi.mocked(invoke).mockImplementation(async (_command, args) => {
      const action = (args as { action: string }).action;
      if (action === "start") return started.promise;
      if (action === "cancel") return { status: "running" };
      return { status: stopped ? "failed" : "running" };
    });
    const { result } = renderHook(() => useCompileRepair({ projectRoot: "/paper", rootDocument: undefined, runtimeMode: "full-access", enabled: true, save: async () => true, onComplete }));
    let work!: Promise<void>;
    await act(async () => { work = result.current.start([diagnostic]); });
    await act(async () => { await result.current.cancel(); });
    expect(result.current.busy).toBe(true);
    await act(async () => { started.resolve({ threadId: "late-task" }); });
    expect(invoke).toHaveBeenCalledWith("compile_repair", { action: "cancel", projectRoot: "/paper", threadId: "late-task" });
    expect(result.current.busy).toBe(true);
    stopped = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); await work; });
    expect(result.current.busy).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("does not start in a read-only project or after save failure", async () => {
    const save = vi.fn(async () => false);
    const onComplete = vi.fn(async () => {});
    const { result, rerender } = renderHook(({ enabled }) => useCompileRepair({ projectRoot: "/paper", rootDocument: undefined, runtimeMode: "full-access", enabled, save, onComplete }), { initialProps: { enabled: false } });
    await act(async () => { await result.current.start([diagnostic]); });
    expect(save).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await act(async () => { await result.current.start([diagnostic]); });
    expect(result.current.state?.status).toBe("failed");
    expect(invoke).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
