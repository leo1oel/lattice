import { beforeEach, describe, expect, it, vi } from "vitest";

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

  it("captures uncaught errors, rejections, and console.error/warn without toasts, once even if installed twice", async () => {
    const { store, capture } = await loadCapture();
    capture.installGlobalErrorCapture();
    capture.installGlobalErrorCapture();

    window.dispatchEvent(new ErrorEvent("error", { error: new Error("kaboom"), message: "kaboom" }));
    const rejection = new Event("unhandledrejection") as Event & { reason: unknown };
    rejection.reason = new Error("broken promise");
    window.dispatchEvent(rejection);
    console.error("something failed", { code: 42 });
    console.warn("be careful");

    const text = store.formatAppLogs();
    for (const fragment of ["Unexpected error", "kaboom", "Unhandled promise rejection", "broken promise",
      "console.error", "something failed", "console.warn", "be careful"]) {
      expect(text).toContain(fragment);
    }
    expect(text.match(/something failed/g)).toHaveLength(1);
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
    const uuid = vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("uuid broken"); });
    expect(() => console.error("trigger while broken")).not.toThrow();
    uuid.mockRestore();

    // The failed report was dropped, not looped; logging recovers afterwards.
    console.error("after recovery");
    expect(store.formatAppLogs()).toContain("after recovery");
  });
});
