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

type RepairOptions = Parameters<typeof useCompileRepair>[0];

/** Render the hook with defaults; `rerender` merges option changes over them. */
function renderRepair(options: Partial<RepairOptions> = {}) {
  const onComplete = vi.fn(async () => {});
  const hook = renderHook((changes: Partial<RepairOptions>) => useCompileRepair({
    projectRoot: "/paper", rootDocument: undefined, runtimeMode: "auto", enabled: true,
    save: async () => true, onComplete, ...options, ...changes,
  }), { initialProps: {} });
  return { ...hook, onComplete };
}

/** Answer each compile_repair action; unlisted actions resolve to undefined. */
function mockRepair(actions: Record<string, () => unknown>) {
  vi.mocked(invoke).mockImplementation(async (_command, args) => actions[(args as { action: string }).action]?.());
}

const startCalls = () => vi.mocked(invoke).mock.calls.filter(([, args]) => (args as { action: string }).action === "start");

describe("user-triggered compile repair", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.mocked(invoke).mockReset(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    "The workspace already has an active writer.",
    new Error("The workspace already has an active writer."),
  ])("explains writer conflicts without starting a task and permits an explicit retry: %s", async (error) => {
    vi.mocked(invoke).mockRejectedValueOnce(error);
    const { result, onComplete } = renderRepair({ rootDocument: "main.tex" });
    await act(async () => { await result.current.start([diagnostic]); });
    expect(result.current.state).toEqual({
      status: "failed",
      message: "Repair has not started because another Agent task in this project is running or waiting for your response. Open Agent to finish or stop that task, then try Fix all again.",
    });
    expect(result.current.busy).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    mockRepair({ start: () => ({ threadId: "retry-task" }), status: () => ({ status: "completed" }) });
    await act(async () => { await result.current.start([diagnostic]); });
    expect(result.current.state?.status).toBe("completed");
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["A compile repair is already running.", "Another compile repair is already starting for this project. Wait for it to finish before trying Fix all again."],
    ["Provider authentication failed", "Provider authentication failed"],
  ])("preserves the reason for a rejected start: %s", async (error, message) => {
    vi.mocked(invoke).mockRejectedValueOnce(error);
    const { result } = renderRepair();
    await act(async () => { await result.current.start([diagnostic]); });
    expect(result.current.state?.message).toBe(message);
    expect(result.current.busy).toBe(false);
  });

  it("does not mislabel an existing repair's failure as a rejected start", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ threadId: "repair-1" }).mockResolvedValueOnce({
      status: "failed", message: "The workspace already has an active writer.",
    });
    const { result } = renderRepair();
    await act(async () => { await result.current.start([diagnostic]); });
    expect(result.current.state).toEqual({
      status: "failed", threadId: "repair-1", message: "Error: The workspace already has an active writer.",
    });
  });

  it("saves first, submits all errors and warnings with the selected permissions, then recompiles once", async () => {
    const saved = deferred<boolean>();
    const error = { level: "error", message: "Undefined control sequence", file: "main.tex", line: 42 };
    const diagnostics = [diagnostic, error, { level: "info", message: "Build note" }];
    let status = "awaiting-approval";
    mockRepair({ start: () => ({ threadId: "repair-1" }), status: () => ({ status }) });
    const { result, onComplete } = renderRepair({ rootDocument: "main.tex", runtimeMode: "full-access", save: () => saved.promise });
    let work!: Promise<void>;
    act(() => { work = result.current.start(diagnostics); });
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => { saved.resolve(true); });
    expect(result.current.state?.status).toBe("awaiting-approval");
    expect(onComplete).not.toHaveBeenCalled();
    await act(async () => { await result.current.start(diagnostics); });
    expect(startCalls()).toHaveLength(1);
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
    mockRepair({ start: () => ({ threadId: "repair-1" }), status: () => ({ status: "completed" }) });
    const { result, rerender } = renderRepair({ runtimeMode: "full-access" });
    rerender({ runtimeMode });
    await act(async () => { await result.current.start([{ level: "info", message: "Note" }]); });
    expect(invoke).not.toHaveBeenCalled();
    await act(async () => { await result.current.start([diagnostic]); });
    expect(invoke).toHaveBeenCalledWith("compile_repair", expect.objectContaining({ action: "start", runtimeMode }));
  });

  it("cancels an outgoing project's late start without recompiling the new project", async () => {
    const started = deferred<{ threadId: string }>();
    mockRepair({ start: () => started.promise, status: () => ({ status: "completed" }) });
    const { result, rerender, onComplete } = renderRepair({ projectRoot: "/old", rootDocument: "main.tex" });
    let work!: Promise<void>;
    await act(async () => { work = result.current.start([diagnostic]); });
    rerender({ projectRoot: "/new" });
    await act(async () => { started.resolve({ threadId: "old-task" }); await work; });
    expect(invoke).toHaveBeenCalledWith("compile_repair", { action: "cancel", projectRoot: "/old", threadId: "old-task" });
    expect(onComplete).not.toHaveBeenCalled();
    expect(result.current.state).toBeNull();
  });

  it("keeps the writer busy after a status transport error or cancel acknowledgment until it stops", async () => {
    let polls = 0;
    let stopped = false;
    mockRepair({
      start: () => ({ threadId: "repair-1" }),
      cancel: () => ({ status: "running" }),
      status: () => {
        if (polls++ === 0) throw new Error("connection lost");
        return { status: stopped ? "failed" : "running", message: stopped ? "Cancelled" : undefined };
      },
    });
    const { result, onComplete } = renderRepair({ runtimeMode: "approval-required" });
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
    let stopped = false;
    mockRepair({
      start: () => started.promise,
      cancel: () => ({ status: "running" }),
      status: () => ({ status: stopped ? "failed" : "running" }),
    });
    const { result, onComplete } = renderRepair({ runtimeMode: "full-access" });
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
    const { result, rerender, onComplete } = renderRepair({ runtimeMode: "full-access", enabled: false, save });
    await act(async () => { await result.current.start([diagnostic]); });
    expect(save).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await act(async () => { await result.current.start([diagnostic]); });
    expect(result.current.state?.status).toBe("failed");
    expect(invoke).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });
});
