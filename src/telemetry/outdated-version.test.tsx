import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { version as RUNNING } from "../../package.json";
import { CompileDiagnosticsPanel } from "../build/compile-diagnostics-panel";
import { reportProblem } from "../app/report-problem";
import { activateAppLocale } from "../i18n";
import { addAppLog, clearAppLogs } from "./app-log-store";
import { UpdaterProvider, useUpdater } from "./app-updater";
import { getKnownUpdate, isNewerVersion, publishKnownUpdate } from "./outdated-version";
import { OutdatedVersionHint } from "./outdated-version-hint";
import { ToastStack } from "./toast-stack";

const tauri = vi.hoisted(() => ({ check: vi.fn(), invoke: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: tauri.check }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class { onmessage = () => {}; },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: tauri.openUrl }));
vi.mock("./updates-itself", () => ({ updatesItself: () => true }));
vi.mock("./interface-sounds", () => ({ playInterfaceSound: vi.fn(), configureInterfaceSounds: vi.fn() }));

const LATEST = "99.0.0";
const hint = () => screen.queryByText(`You’re on v${RUNNING}; v${LATEST} is available and may already fix this.`);
/** Toasts are `aria-hidden` until focused; see toast-stack.test.tsx. */
const button = (name: string) => screen.getByRole("button", { name, hidden: true });
const known = (updateNow = vi.fn(async () => {})) => publishKnownUpdate({ running: RUNNING, latest: LATEST, phase: "available", updateNow });

beforeEach(() => {
  cleanup();
  clearAppLogs();
  publishKnownUpdate(null);
  tauri.check.mockReset();
  tauri.invoke.mockReset();
  tauri.openUrl.mockReset();
});
afterEach(cleanup);

describe("isNewerVersion", () => {
  it.each([
    ["0.16.10", "0.16.9", true],
    ["v0.17.0", "0.16.10", true],
    ["1.0", "0.99.99", true],
    ["0.16.9", "0.16.10", false],
    ["0.16.10", "0.16.10", false],
    ["0.16.10", "0.16.10.0", false],
    ["0.17.0-beta.1", "0.16.10", true],
    ["abc", "0.16.10", false],
    ["0.17.0", "3f2c1a9", false],
  ])("%s is newer than %s: %s", (candidate, current, expected) => {
    expect(isNewerVersion(candidate, current)).toBe(expected);
  });

  it("keeps no report of a release that is not newer than the running one", () => {
    publishKnownUpdate({ running: RUNNING, latest: RUNNING, phase: "available", updateNow: async () => {} });
    expect(getKnownUpdate()).toBeNull();
  });
});

describe("the outdated-version line on failures", () => {
  it("says nothing while Lattice is current, then offers the updater's own Update now", () => {
    const updateNow = vi.fn(async () => {});
    render(<OutdatedVersionHint />);
    expect(hint()).toBeNull();
    act(() => known(updateNow));
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    expect(updateNow).toHaveBeenCalledTimes(1);
    act(() => publishKnownUpdate({ running: RUNNING, latest: LATEST, phase: "ready", updateNow }));
    expect(screen.getByRole("button", { name: "Restart to update" })).toBeEnabled();
    act(() => publishKnownUpdate({ running: RUNNING, latest: LATEST, phase: "downloading", updateNow }));
    expect(screen.getByRole("button", { name: "Updating…" })).toBeDisabled();
  });

  it("reads in Chinese", async () => {
    await activateAppLocale("zh-CN");
    try {
      known();
      render(<OutdatedVersionHint />);
      expect(screen.getByRole("button", { name: "立即更新" })).toBeInTheDocument();
      expect(hint()).toBeNull();
    } finally {
      cleanup();
      await activateAppLocale("en");
    }
  });

  it("shows under a failed build only", () => {
    known();
    const props = {
      diagnostics: [], log: "Build output", expanded: false,
      onExpandedChange: vi.fn(), onSelect: vi.fn(), onInstallDependency: vi.fn(), onDismiss: vi.fn(),
    };
    const { rerender } = render(<CompileDiagnosticsPanel {...props} success={false} />);
    expect(hint()).toBeInTheDocument();
    rerender(<CompileDiagnosticsPanel {...props} success diagnostics={[{ level: "warning", message: "Overfull \\hbox", file: "main.tex", line: 3 }]} />);
    expect(hint()).toBeNull();
  });

  it("rides on the newest error toast once, never on a warning or an opted-out toast", async () => {
    known();
    render(<ToastStack />);
    act(() => {
      addAppLog({ level: "error", source: "Overleaf", title: "Sync failed" });
      addAppLog({ level: "warning", source: "Build", title: "Slow build" });
      addAppLog({ level: "error", source: "Build", title: "Package install failed" });
    });
    await waitFor(() => expect(hint()).toBeInTheDocument());
    const cards = [...document.querySelectorAll<HTMLElement>("[data-app-toast]")];
    const withHint = cards.filter((card) => within(card).queryByText(/may already fix this/, { ignore: "" }));
    expect(withHint.map((card) => card.textContent)).toEqual([expect.stringContaining("Package install failed")]);

    act(() => {
      clearAppLogs();
      addAppLog({ level: "error", source: "App updater", title: "Lattice update failed", toastOptions: { updateHint: false } });
    });
    await waitFor(() => expect(hint()).toBeNull());
  });

  it("is what the updater found: kept after the offer is put away, whose Update now checks again", async () => {
    tauri.check.mockResolvedValue({ version: LATEST, currentVersion: RUNNING, rid: 1 });
    const updater = renderHook(() => useUpdater(), {
      wrapper: ({ children }) => <UpdaterProvider autoCheck={false}>{children}<ToastStack /></UpdaterProvider>,
    }).result;
    await act(async () => { await updater.current.check(true); });
    expect(getKnownUpdate()).toMatchObject({ running: RUNNING, latest: LATEST, phase: "available" });
    act(() => updater.current.dismiss());
    expect(getKnownUpdate()).toMatchObject({ latest: LATEST, phase: "idle" });

    await act(async () => { await getKnownUpdate()!.updateNow(); });
    expect(tauri.check).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByText(`New version ${LATEST}`)).toBeInTheDocument());
    // The offer is held again, so the next Update now installs it.
    tauri.invoke.mockResolvedValue("busy");
    await act(async () => { await getKnownUpdate()!.updateNow(); });
    expect(tauri.invoke).toHaveBeenCalledWith("claim_update_install", { version: LATEST });
  });
});

describe("Report a Problem on an old release", () => {
  it("says a newer release exists before opening the issue page, and still files it on request", async () => {
    const updateNow = vi.fn(async () => {});
    known(updateNow);
    render(<ToastStack />);
    tauri.invoke.mockResolvedValue({ osVersion: "15.1", arch: "aarch64" });
    await act(async () => { await reportProblem(); });
    expect(tauri.openUrl).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(`You’re on v${RUNNING}; v${LATEST} is available`)).toBeInTheDocument());

    fireEvent.click(button("Report anyway"));
    await waitFor(() => expect(tauri.openUrl).toHaveBeenCalledTimes(1));
    expect(tauri.openUrl.mock.calls[0]?.[0]).toContain(`lattice-version=${RUNNING}`);
    expect(updateNow).not.toHaveBeenCalled();
  });

  it("opens the issue page straight away on the latest release", async () => {
    tauri.invoke.mockResolvedValue({ osVersion: "15.1", arch: "aarch64" });
    await reportProblem();
    expect(tauri.openUrl).toHaveBeenCalledTimes(1);
  });
});
