import { afterEach, describe, expect, it, vi } from "vitest";
import { CRASH_SAVE_TIMEOUT_MS, crashSaveSettled, registerCrashEdits, saveOnCrash } from "./crash-save";

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.useRealTimers();
});

describe("saveOnCrash", () => {
  it("has nothing to write before a window registers its edits", async () => {
    await expect(saveOnCrash()).resolves.toBe(true);
  });

  it("writes once for a crash that several boundaries see", async () => {
    let finish!: (saved: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
    unregister = registerCrashEdits({ flush: () => true, save });
    const first = saveOnCrash();
    const second = saveOnCrash();
    expect(save).toHaveBeenCalledOnce();
    finish(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });

  it("still writes the published text when the crashed editor's flush throws", async () => {
    const save = vi.fn(async () => true);
    unregister = registerCrashEdits({ flush: () => { throw new Error("editor gone"); }, save });
    await expect(saveOnCrash()).resolves.toBe(true);
    expect(save).toHaveBeenCalledOnce();
  });

  it("stops waiting for a write that never answers, so Restart cannot hang", async () => {
    vi.useFakeTimers();
    unregister = registerCrashEdits({ flush: () => true, save: () => new Promise<boolean>(() => undefined) });
    const saving = saveOnCrash();
    const settled = vi.fn();
    void crashSaveSettled().then(settled);
    await vi.advanceTimersByTimeAsync(CRASH_SAVE_TIMEOUT_MS);
    await expect(saving).resolves.toBe(false);
    expect(settled).toHaveBeenCalled();
  });
});
