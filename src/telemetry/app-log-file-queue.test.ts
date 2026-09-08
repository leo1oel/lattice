import { afterEach, describe, expect, it, vi } from "vitest";
import { AppLogFileQueue } from "./app-log-file-queue";

afterEach(() => { vi.useRealTimers(); });

describe("bounded log delivery", () => {
  it("retries identical records a finite number of times and recovers on later events", async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockRejectedValue(new Error("disk unavailable"));
    const losses = vi.fn((counts) => JSON.stringify(counts));
    const queue = new AppLogFileQueue(write, losses);
    queue.enqueue("original-id-and-time", 2);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write.mock.calls.map(([line]) => line)).toEqual(Array(3).fill("original-id-and-time"));
    expect(losses).toHaveBeenLastCalledWith({ overflow: 0, failed: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(write).toHaveBeenCalledTimes(3);
    write.mockResolvedValue(undefined);
    queue.enqueue("recovered", 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(write.mock.calls.slice(3).map(([line]) => line)).toEqual(["recovered", '{"overflow":0,"failed":1}']);
  });

  it("bounds backlog during a stalled IPC and preferentially retains errors", async () => {
    let resolve!: () => void;
    const stalled = new Promise<void>((done) => { resolve = done; });
    const write = vi.fn().mockReturnValueOnce(stalled).mockResolvedValue(undefined);
    const losses = vi.fn((counts) => JSON.stringify(counts));
    const queue = new AppLogFileQueue(write, losses);
    queue.enqueue("in-flight", 0);
    for (let i = 0; i < 300; i++) queue.enqueue(`info-${i}`, 0);
    queue.enqueue("critical-error", 2);
    expect(write).toHaveBeenCalledTimes(1);
    expect(losses).toHaveBeenLastCalledWith({ overflow: 46, failed: 0 });
    resolve();
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("critical-error", 2));
    expect(write.mock.calls.some(([line]) => line === "info-0")).toBe(false);
    // 256 retained entries, plus one cumulative loss summary.
    expect(write).toHaveBeenCalledTimes(257);
  });

  it("also bounds UTF-8 bytes and rejects oversized records", async () => {
    const write = vi.fn(async () => undefined);
    const losses = vi.fn((counts) => JSON.stringify(counts));
    const queue = new AppLogFileQueue(write, losses);
    queue.enqueue("汉".repeat(200_000), 2);
    expect(write).not.toHaveBeenCalled();
    expect(losses).toHaveBeenLastCalledWith({ overflow: 1, failed: 0 });
    queue.enqueue("next", 0);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
  });

  it("does not recursively generate loss records when their delivery fails", async () => {
    const write = vi.fn(async (line: string) => { if (line.startsWith("{")) throw new Error("failed summary"); });
    const losses = vi.fn((counts) => JSON.stringify(counts));
    const queue = new AppLogFileQueue(write, losses);
    queue.enqueue("x".repeat(600_000), 0);
    queue.enqueue("next", 0);
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(losses).toHaveBeenLastCalledWith({ overflow: 1, failed: 0 });
  });
});
