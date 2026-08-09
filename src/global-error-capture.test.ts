import { beforeEach, describe, expect, it, vi } from "vitest";

// Keep the file-log mock inert so forwarding from captured entries is a no-op.
vi.mock("@tauri-apps/plugin-log", () => ({
  info: vi.fn().mockResolvedValue(undefined),
  warn: vi.fn().mockResolvedValue(undefined),
  error: vi.fn().mockResolvedValue(undefined),
}));

async function loadCapture() {
  vi.resetModules();
  const store = await import("./app-log-store");
  const capture = await import("./global-error-capture");
  return { store, capture };
}

describe("installGlobalErrorCapture", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("captures uncaught errors, rejections, and console.error/warn without toasts", async () => {
    const { store, capture } = await loadCapture();
    capture.installGlobalErrorCapture();

    window.dispatchEvent(new ErrorEvent("error", { error: new Error("kaboom"), message: "kaboom" }));
    const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
    rejection.reason = new Error("broken promise");
    window.dispatchEvent(rejection);
    console.error("something failed", { code: 42 });
    console.warn("be careful");

    const text = store.formatAppLogs();
    expect(text).toContain("Unexpected error");
    expect(text).toContain("kaboom");
    expect(text).toContain("Unhandled promise rejection");
    expect(text).toContain("broken promise");
    expect(text).toContain("console.error");
    expect(text).toContain("something failed");
    expect(text).toContain("console.warn");
    expect(text).toContain("be careful");
  });

  it("is idempotent — installing twice does not double-report", async () => {
    const { store, capture } = await loadCapture();
    capture.installGlobalErrorCapture();
    capture.installGlobalErrorCapture();

    console.error("only once");
    const matches = store.formatAppLogs().match(/only once/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("ignores non-fatal ResizeObserver delivery notifications", async () => {
    const { store, capture } = await loadCapture();
    capture.installGlobalErrorCapture();
    const notification = new ErrorEvent("error", {
      message: "ResizeObserver loop completed with undelivered notifications.",
      error: new Error("browser delivery stack"),
      cancelable: true,
    });

    window.dispatchEvent(notification);

    expect(notification.defaultPrevented).toBe(true);
    expect(store.formatAppLogs()).not.toContain("browser delivery stack");
    expect(store.formatAppLogs()).not.toContain("ResizeObserver");
  });

  it("does not recurse when the logging path itself throws", async () => {
    const { store, capture } = await loadCapture();
    capture.installGlobalErrorCapture();

    // Force addAppLog to throw mid-report by breaking UUID generation once.
    const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
      throw new Error("uuid broken");
    });
    expect(() => console.error("trigger while broken")).not.toThrow();
    uuid.mockRestore();

    // The failed report was dropped, not looped; logging recovers afterwards.
    console.error("after recovery");
    expect(store.formatAppLogs()).toContain("after recovery");
  });
});
