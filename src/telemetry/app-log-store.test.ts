import { beforeEach, describe, expect, it, vi } from "vitest";

// One shared mock object across module resets: the store imports the plugin
// dynamically on first forward, after `vi.resetModules()` has run.
const fileLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-log", () => fileLog);

async function loadStore() {
  vi.resetModules();
  return await import("./app-log-store");
}

async function flushForwarding() {
  // The forward queue chains a dynamic import + the plugin call per entry;
  // a few macrotask turns let it settle.
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("app-log-store file forwarding", () => {
  beforeEach(() => {
    window.localStorage.clear();
    fileLog.info.mockReset().mockResolvedValue(undefined);
    fileLog.warn.mockReset().mockResolvedValue(undefined);
    fileLog.error.mockReset().mockResolvedValue(undefined);
  });

  it("forwards entries to the file log in order, mapping levels", async () => {
    const { addAppLog } = await loadStore();
    addAppLog({ level: "info", source: "A", title: "first", toast: false });
    addAppLog({ level: "error", source: "B", title: "second", detail: "boom", toast: false });
    addAppLog({ level: "warning", source: "C", title: "third", toast: false });
    await flushForwarding();

    expect(fileLog.info.mock.calls.map((call) => call[0])).toEqual(["[A] first"]);
    expect(fileLog.error.mock.calls.map((call) => call[0])).toEqual(["[B] second\nboom"]);
    expect(fileLog.warn.mock.calls.map((call) => call[0])).toEqual(["[C] third"]);
  });

  it("disables forwarding after a failure instead of looping", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fileLog.info.mockRejectedValueOnce(new Error("plugin missing"));
    const { addAppLog } = await loadStore();

    addAppLog({ level: "info", source: "A", title: "one", toast: false });
    await flushForwarding();
    addAppLog({ level: "info", source: "A", title: "two", toast: false });
    await flushForwarding();

    expect(fileLog.info).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0][0]).toMatch(/file logging unavailable/i);
    consoleError.mockRestore();
  });

  it("caps detail length to protect storage and the file", async () => {
    const { addAppLog } = await loadStore();
    const entry = addAppLog({
      level: "info",
      source: "A",
      title: "long",
      detail: "x".repeat(10_000),
      toast: false,
    });
    expect(entry.detail).toHaveLength(4_000);
    await flushForwarding();
    expect(fileLog.info.mock.calls[0][0]).toContain("x".repeat(4_000));
    expect(fileLog.info.mock.calls[0][0]).not.toContain("x".repeat(4_001));
  });

  it("warns exactly once when localStorage persistence fails", async () => {
    const setItem = vi
      .spyOn(window.localStorage, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
    const { addAppLog, formatAppLogs } = await loadStore();

    addAppLog({ level: "info", source: "A", title: "one", toast: false });
    addAppLog({ level: "info", source: "A", title: "two", toast: false });
    await flushForwarding();

    const text = formatAppLogs();
    expect(text.match(/Log history can't be saved/g)).toHaveLength(1);
    // Entries still reach the file even while persistence is broken.
    expect(fileLog.info).toHaveBeenCalled();
    setItem.mockRestore();
  });
});
