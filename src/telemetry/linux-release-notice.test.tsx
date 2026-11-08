import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { addAppLog } from "./app-log-store";
import { useLinuxReleaseNotice } from "./linux-release-notice";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./app-log-store", () => ({ addAppLog: vi.fn() }));
vi.mock("./updates-itself", () => ({ updatesItself: () => false }));

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => cleanup());

it("checks on startup, offers the release without installing, and does not repeat it", async () => {
  vi.mocked(invoke).mockResolvedValue("0.16.0");
  renderHook(() => useLinuxReleaseNotice(20, true));
  await waitFor(() => expect(addAppLog).toHaveBeenCalledOnce());
  expect(invoke).toHaveBeenCalledWith("check_linux_release");
  expect(addAppLog).toHaveBeenCalledWith(expect.objectContaining({
    title: "New version 0.16.0",
    toastOptions: expect.objectContaining({ timeoutMs: 0, primaryAction: expect.objectContaining({ label: "GitHub Releases" }) }),
  }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); });
  expect(vi.mocked(invoke).mock.calls.length).toBeGreaterThan(1);
  expect(addAppLog).toHaveBeenCalledOnce();
  const entry = vi.mocked(addAppLog).mock.calls[0][0];
  entry.toastOptions?.primaryAction?.onClick?.();
  await waitFor(() => expect(openUrl).toHaveBeenCalledWith("https://github.com/leo1oel/lattice/releases/latest"));
  expect(vi.mocked(invoke).mock.calls.every(([command]) => command === "check_linux_release")).toBe(true);
});

it("stays silent offline and retries, then offers the next valid release", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("not a version").mockResolvedValue("0.16.1");
  renderHook(() => useLinuxReleaseNotice(20, true));
  await waitFor(() => expect(addAppLog).toHaveBeenCalledOnce());
  expect(addAppLog).toHaveBeenCalledWith(expect.objectContaining({ title: "New version 0.16.1" }));
});

it("does not report a late response after unmounting", async () => {
  let finish: (value: string) => void = () => {};
  vi.mocked(invoke).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = renderHook(() => useLinuxReleaseNotice(60000, true));
  view.unmount();
  await act(async () => { finish("0.16.0"); });
  expect(addAppLog).not.toHaveBeenCalled();
});
