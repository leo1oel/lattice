import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyUpdateFailure, describeInstallFailure, installFailureToast, releasePageUrl, retryTransient } from "./update-recovery";

const opener = vi.hoisted(() => ({ openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => opener);

afterEach(() => {
  vi.useRealTimers();
  opener.openUrl.mockReset();
});

// The wordings tauri-plugin-updater 2.10 and reqwest produce.
const DOWNLOAD_504 = "Download request failed with status: 504 Gateway Timeout";
const CHECK_NON_SUCCESS = "Could not fetch a valid release JSON from the remote";

describe("which update failures are retried", () => {
  it.each([
    [DOWNLOAD_504, "server", 504, true],
    ["Download request failed with status: 502 Bad Gateway", "server", 502, true],
    ["Download request failed with status: 503 Service Unavailable", "server", 503, true],
    // The check folds every non-success status into this, without the status.
    [CHECK_NON_SUCCESS, "server", undefined, true],
    ["error sending request for url (https://github.com/…/latest.json): operation timed out", "network", undefined, true],
    ["error decoding response body: connection reset by peer", "network", undefined, true],
    ["Download request failed with status: 404 Not Found", "not-found", 404, false],
    ["Download request failed with status: 403 Forbidden", "other", 403, false],
    ["signature verification failed: the signature does not match", "signature", undefined, false],
    // A bad signature stays final even when the text also names a timeout.
    ["minisign: invalid signature after timeout", "signature", undefined, false],
    ["disk full", "other", undefined, false],
  ] as const)("%s → %s", (message, kind, status, transient) => {
    expect(classifyUpdateFailure(new Error(message))).toEqual({ kind, transient, ...status ? { status } : {} });
  });
});

describe("retryTransient", () => {
  const signal = () => new AbortController().signal;

  it("tries three times in all, then gives up with the last failure", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error(DOWNLOAD_504));
    const onRetry = vi.fn();
    await expect(retryTransient(new Error(DOWNLOAD_504), attempt, { signal: signal(), delaysMs: [0, 0], onRetry })).rejects.toThrow(DOWNLOAD_504);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls).toEqual([[2], [3]]);
  });

  it("returns the first success", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(new Error(DOWNLOAD_504)).mockResolvedValueOnce("ok");
    await expect(retryTransient(new Error(DOWNLOAD_504), attempt, { signal: signal(), delaysMs: [0, 0] })).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a 404", "Download request failed with status: 404 Not Found"],
    ["a bad signature", "signature verification failed"],
  ])("never tries %s again", async (_, message) => {
    const attempt = vi.fn();
    await expect(retryTransient(new Error(message), attempt, { signal: signal(), delaysMs: [0, 0] })).rejects.toThrow(message);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("stops after a transient failure is followed by a final one", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("Download request failed with status: 404 Not Found"));
    await expect(retryTransient(new Error(DOWNLOAD_504), attempt, { signal: signal(), delaysMs: [0, 0] })).rejects.toThrow("404");
    expect(attempt).toHaveBeenCalledOnce();
  });

  it("is cancelled mid-wait, without another attempt", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const attempt = vi.fn();
    const retrying = retryTransient(new Error(DOWNLOAD_504), attempt, { signal: controller.signal });
    const outcome = expect(retrying).rejects.toThrow(DOWNLOAD_504);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await outcome;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("waits longer before each attempt", async () => {
    vi.useFakeTimers();
    const attempt = vi.fn().mockRejectedValue(new Error(DOWNLOAD_504));
    const retrying = retryTransient(new Error(DOWNLOAD_504), attempt, { signal: signal() }).catch(() => "gave up");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5_999);
    expect(attempt).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    await expect(retrying).resolves.toBe("gave up");
  });
});

describe("the failed install's toast", () => {
  it("says what happened and what to do", () => {
    expect(describeInstallFailure(new Error(DOWNLOAD_504), "0.16.1")).toBe(
      "GitHub’s download server timed out (504). Try again, or download Lattice 0.16.1 from the releases page.",
    );
    expect(describeInstallFailure(new Error("disk full."), "0.16.1")).toBe(
      "disk full. Try again, or download Lattice 0.16.1 from the releases page.",
    );
  });

  it("offers Try again and the releases page", () => {
    const retry = vi.fn();
    const { options } = installFailureToast(new Error(DOWNLOAD_504), "0.16.1", retry);
    expect(options.timeoutMs).toBe(0);
    options.primaryAction?.onClick();
    expect(retry).toHaveBeenCalledOnce();
    options.secondaryAction?.onClick();
    expect(opener.openUrl).toHaveBeenCalledWith(releasePageUrl("0.16.1"));
    expect(releasePageUrl("0.16.1")).toBe("https://github.com/leo1oel/lattice/releases/tag/v0.16.1");
  });

  it.each([["a 404", "Download request failed with status: 404 Not Found"], ["a bad signature", "signature verification failed"]])(
    "leaves out Try again after %s, which fetching again cannot fix",
    (_, message) => {
      const { options } = installFailureToast(new Error(message), "0.16.1", vi.fn());
      expect(options.primaryAction).toBeUndefined();
      expect(options.secondaryAction?.label).toBe("Open releases page");
    },
  );
});
