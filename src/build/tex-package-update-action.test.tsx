import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateAppLocale } from "../i18n";
import { useDailyTexPackageCheck, useTexPackageUpdates, BACKGROUND_CHECK_DELAY_MS } from "../app/use-tex-package-updates";
import { CompileDiagnosticsPanel } from "./compile-diagnostics-panel";
import type { TexPackageUpdatesReport } from "./tex-package-updates";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null;
  },
}));

// What `outdated_lineno.rs` reports when the log shows lineno 5.7 on LaTeX 2025-06 or later.
const LINENO_NOTICE = {
  level: "warning",
  message: "Line numbers may be drawn over the text: your TeX has lineno 5.7, which has a known bug. Update TeX packages to fix it.",
  code: "lineno-outdated",
};
const panelProps = {
  log: "Build output", success: true, expanded: true,
  onExpandedChange: vi.fn(), onSelect: vi.fn(), onInstallDependency: vi.fn(), onDismiss: vi.fn(),
};

afterEach(cleanup);
beforeEach(() => {
  tauri.invoke.mockReset();
  localStorage.clear();
});

describe("the outdated lineno notice", () => {
  function Panel() {
    const updates = useTexPackageUpdates();
    return <CompileDiagnosticsPanel {...panelProps} diagnostics={[LINENO_NOTICE]} texPackageUpdates={updates} />;
  }

  it("runs the TeX doctor's package update from the build's problems", async () => {
    let finish!: () => void;
    tauri.invoke.mockImplementation((command: string) => command === "start_tex_package_update"
      ? new Promise<void>((resolve) => { finish = resolve; })
      : Promise.resolve({ managed: true, packages: [] }));
    render(<Panel />);
    expect(screen.getByText(LINENO_NOTICE.message)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Update TeX packages" }));
    expect(tauri.invoke).toHaveBeenCalledWith("start_tex_package_update", expect.anything());
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for administrator approval… 0%");
    await act(async () => { finish(); });
    expect(screen.getByRole("status")).toHaveTextContent("TeX packages updated. Build again to use them.");
  });

  it("says why an update failed and offers it again", async () => {
    tauri.invoke.mockRejectedValue("Lattice only updates the BasicTeX it installs. In Terminal: sudo tlmgr update --self --all");
    render(<Panel />);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Update TeX packages" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Lattice only updates the BasicTeX it installs. In Terminal: sudo tlmgr update --self --all");
    expect(screen.getByRole("button", { name: "Update TeX packages" })).toBeEnabled();
  });

  it("reads in Chinese", async () => {
    await activateAppLocale("zh-CN");
    try {
      render(<Panel />);
      expect(screen.getByText("行号可能会压在正文上：你的 TeX 中的 lineno 是 5.7 版，它有一个已知问题。更新 TeX 组件即可修复。")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "更新 TeX 组件" })).toBeInTheDocument();
    } finally {
      cleanup();
      await activateAppLocale("en");
    }
  });
});

describe("the daily background package check", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const check = (report: TexPackageUpdatesReport | null) => vi.fn(() => Promise.resolve(report));

  it("checks once after launch, and not again the same day", async () => {
    const first = check({ managed: true, packages: [{ name: "lineno", installed: "5.7", available: "5.9" }] });
    const launch = renderHook(() => useDailyTexPackageCheck(first));
    expect(first).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_CHECK_DELAY_MS); });
    expect(first).toHaveBeenCalledTimes(1);
    launch.unmount();

    const again = check({ managed: true, packages: [] });
    renderHook(() => useDailyTexPackageCheck(again));
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_CHECK_DELAY_MS); });
    expect(again).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    const nextDay = check({ managed: true, packages: [] });
    renderHook(() => useDailyTexPackageCheck(nextDay));
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_CHECK_DELAY_MS); });
    expect(nextDay).toHaveBeenCalledTimes(1);
  });

  it("tries again on the next launch when the repository did not answer", async () => {
    const offline = check({ managed: true, packages: [], error: "offline" });
    const launch = renderHook(() => useDailyTexPackageCheck(offline));
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_CHECK_DELAY_MS); });
    launch.unmount();
    const next = check({ managed: true, packages: [] });
    renderHook(() => useDailyTexPackageCheck(next));
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_CHECK_DELAY_MS); });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("closed before the delay, checks nothing", async () => {
    const early = check({ managed: true, packages: [] });
    renderHook(() => useDailyTexPackageCheck(early)).unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_CHECK_DELAY_MS); });
    expect(early).not.toHaveBeenCalled();
  });
});
