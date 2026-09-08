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
  window.dispatchEvent(new Event("pagehide"));
  await Promise.resolve();
}

describe("app-log-store file forwarding", () => {
  beforeEach(() => {
    window.dispatchEvent(new Event("pagehide"));
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

    expect(JSON.parse(fileLog.info.mock.calls[0][0])).toMatchObject({
      schema_version: 1, event: "app.notification", service: "lattice.frontend",
      source: "A", title: "first", version: expect.any(String), session_id: expect.any(String),
    });
    expect(JSON.parse(fileLog.error.mock.calls[0][0])).toMatchObject({ source: "B", title: "second", detail: "boom" });
    expect(JSON.parse(fileLog.warn.mock.calls[0][0])).toMatchObject({ source: "C", title: "third" });
    expect(fileLog.info.mock.invocationCallOrder[0]).toBeLessThan(fileLog.error.mock.invocationCallOrder[0]);
    expect(fileLog.error.mock.invocationCallOrder[0]).toBeLessThan(fileLog.warn.mock.invocationCallOrder[0]);
  });

  it("redacts common credentials on creation, update, export and disk forwarding", async () => {
    const { addAppLog, updateAppLog, formatAppLogs } = await loadStore();
    const detail = 'Authorization: Bearer bearer-secret\nCookie: sid=cookie-secret\nhttps://example.test?api_key=query-secret&ticket=ticket-secret\n/binary/downloads/path-secret\n{"password":"json-secret"}';
    const entry = addAppLog({ level: "error", source: "Sync", title: "Failed", detail, toast: false });
    updateAppLog(entry.id, { detail, context: { operation_id: "operation", operation: "Sync", phase: "completed", trigger: "token=context-secret" } });
    await flushForwarding();
    const persisted = window.localStorage.getItem("lattice.app-log.v1")!;
    for (const output of [persisted, formatAppLogs(), ...fileLog.error.mock.calls.map((call) => call[0])]) {
      for (const secret of ["bearer-secret", "cookie-secret", "query-secret", "ticket-secret", "path-secret", "json-secret", "context-secret"]) {
        expect(output).not.toContain(secret);
      }
      expect(output).toContain("[redacted]");
    }
    expect(fileLog.error.mock.calls[0][0]).not.toContain("\n");
  });

  it("recovers after a transient failure without a console capture loop", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fileLog.info.mockRejectedValueOnce(new Error("plugin missing"));
    const { addAppLog } = await loadStore();

    addAppLog({ level: "info", source: "A", title: "one", toast: false });
    await vi.waitFor(() => expect(fileLog.info).toHaveBeenCalledTimes(2));
    addAppLog({ level: "info", source: "A", title: "two", toast: false });
    await flushForwarding();

    expect(fileLog.info).toHaveBeenCalledTimes(3);
    expect(fileLog.info.mock.calls[0][0]).toBe(fileLog.info.mock.calls[1][0]);
    expect(consoleError).not.toHaveBeenCalled();
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

  it("coalesces snapshot writes and flushes the latest history on pagehide", async () => {
    const { addAppLog } = await loadStore();
    const setItem = vi.spyOn(window.localStorage, "setItem");
    try {
      for (let i = 0; i < 8; i++) addAppLog({ level: "info", source: "App", title: `event-${i}`, toast: false });
      expect(setItem).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(setItem).toHaveBeenCalledTimes(1));
      expect(JSON.parse(window.localStorage.getItem("lattice.app-log.v1")!)).toHaveLength(8);
      addAppLog({ level: "info", source: "App", title: "last", toast: false });
      window.dispatchEvent(new Event("pagehide"));
      expect(setItem).toHaveBeenCalledTimes(2);
      expect(JSON.parse(window.localStorage.getItem("lattice.app-log.v1")!)[0].title).toBe("last");
    } finally { setItem.mockRestore(); }
  });

  it("retains valid persisted history beside malformed legacy entries", async () => {
    window.localStorage.setItem("lattice.app-log.v1", JSON.stringify([null, { title: 12 }, {
      id: "legacy", timestamp: "2026-01-01", level: "info", source: "App", title: "Kept", detail: "", context: { operation_id: 42 },
    }]));
    const { formatAppLogs } = await loadStore();
    expect(formatAppLogs()).toContain("Kept");
    expect(formatAppLogs()).not.toContain("operation_id");
  });
});
