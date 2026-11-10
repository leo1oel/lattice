import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateAppLocale } from "../i18n";
import type { TexPackageUpdatesReport } from "../build/tex-package-updates";
import { clearAppLogs, getAppLogEntry, getAppToastOptions, getVisibleAppToastIds } from "../telemetry/app-log-store";
import { BACKGROUND_CHECK_DELAY_MS, type TexPackageUpdates } from "./use-tex-package-updates";
import { readReminderRecord, REMINDER_SNOOZE_MS, useTexUpdateReminder } from "./use-tex-update-reminder";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));

const HOUR_MS = 60 * 60 * 1000;
const PACKAGES = [
  { name: "lineno", installed: "5.7", available: "5.9" },
  { name: "hyperref", installed: "7.01", available: "7.02" },
];
const outdated = (managed: boolean): TexPackageUpdatesReport => ({ managed, packages: PACKAGES });

function fakeUpdates(report: TexPackageUpdatesReport | null, run: TexPackageUpdates["run"] = null): TexPackageUpdates {
  return { report, checking: false, run, check: vi.fn(() => Promise.resolve(report)), update: vi.fn(() => Promise.resolve()) };
}

function toasts() {
  return getVisibleAppToastIds().map((id) => ({ ...getAppLogEntry(id)!, options: getAppToastOptions(id)! }));
}
const reminders = () => toasts().filter((toast) => toast.title === "Your TeX packages are out of date");

/** One launch: the hook mounts, and the daily check answers after its delay. */
async function launch(updates: TexPackageUpdates, building = false) {
  const hook = renderHook((props: { updates: TexPackageUpdates; building: boolean }) => useTexUpdateReminder(props.updates, props.building), {
    initialProps: { updates, building },
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(BACKGROUND_CHECK_DELAY_MS); });
  return hook;
}

/** Quit, and come back `hours` later. */
function relaunchAfter(hook: { unmount: () => void }, hours: number) {
  hook.unmount();
  clearAppLogs();
  vi.setSystemTime(Date.now() + hours * HOUR_MS);
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  clearAppLogs();
});
afterEach(() => { vi.useRealTimers(); });

describe("the TeX update reminder", () => {
  it("offers the one-click update for the BasicTeX Lattice manages", async () => {
    const updates = fakeUpdates(outdated(true));
    await launch(updates);
    const [reminder] = reminders();
    expect(reminder.detail).toBe("Updates available (2). Updating asks for administrator approval and can take a few minutes.");
    expect(reminder.options.timeoutMs).toBe(0);
    expect(reminder.options.primaryAction?.label).toBe("Update TeX packages");
    expect(reminder.options.secondaryAction?.label).toBe("Later");
    await reminder.options.primaryAction?.onClick();
    expect(updates.update).toHaveBeenCalledTimes(1);
  });

  it("gives the command for a TeX the writer installed", async () => {
    await launch(fakeUpdates(outdated(false)));
    const [reminder] = reminders();
    expect(reminder.detail).toBe("Updates available (2). In Terminal: sudo tlmgr update --self --all");
    expect(reminder.options.copyText).toBe("sudo tlmgr update --self --all");
    expect(reminder.options.primaryAction?.label).toBe("Later");
  });

  it("says nothing when packages are current or the repository could not be asked", async () => {
    const current = await launch(fakeUpdates({ managed: true, packages: [] }));
    expect(reminders()).toHaveLength(0);
    relaunchAfter(current, 25);
    await launch(fakeUpdates({ managed: true, packages: [], error: "offline" }));
    expect(reminders()).toHaveLength(0);
  });

  it("waits for a running build to end", async () => {
    const updates = fakeUpdates(outdated(true));
    const hook = await launch(updates, true);
    expect(reminders()).toHaveLength(0);
    hook.rerender({ updates, building: false });
    expect(reminders()).toHaveLength(1);
  });

  it("reminds at most once a day", async () => {
    const first = await launch(fakeUpdates(outdated(true)));
    expect(reminders()).toHaveLength(1);
    // Dismissed, then a check the same day (Settings cleared the check's own clock).
    relaunchAfter(first, 2);
    localStorage.removeItem("lattice.tex-package-check.v1");
    const sameDay = await launch(fakeUpdates(outdated(true)));
    expect(reminders()).toHaveLength(0);
    relaunchAfter(sameDay, 24);
    await launch(fakeUpdates(outdated(true)));
    expect(reminders()).toHaveLength(1);
  });

  it("keeps away for a few days after Later", async () => {
    const first = await launch(fakeUpdates(outdated(true)));
    const before = Date.now();
    void reminders()[0].options.secondaryAction?.onClick();
    expect(readReminderRecord().snoozedUntil).toBe(before + REMINDER_SNOOZE_MS);
    let hook = first;
    for (const _day of [1, 2]) {
      relaunchAfter(hook, 25);
      hook = await launch(fakeUpdates(outdated(true)));
      expect(reminders()).toHaveLength(0);
    }
    relaunchAfter(hook, 25);
    await launch(fakeUpdates(outdated(true)));
    expect(reminders()).toHaveLength(1);
  });

  it("goes away once an update starts elsewhere, and is not shown when one already left nothing", async () => {
    const updates = fakeUpdates(outdated(true));
    const hook = await launch(updates);
    hook.rerender({ updates: { ...updates, run: { progress: { stage: "authorizing", progress: 0 }, running: true, error: null } }, building: false });
    expect(reminders()).toHaveLength(0);

    relaunchAfter(hook, 25);
    const stale = fakeUpdates(outdated(true));
    const building = await launch(stale, true);
    building.rerender({ updates: { ...stale, report: { managed: true, packages: [] } }, building: false });
    expect(reminders()).toHaveLength(0);
  });

  it("reports the progress and result of an update started from it", async () => {
    const updates = fakeUpdates(outdated(true));
    const hook = await launch(updates);
    await act(async () => { await reminders()[0].options.primaryAction?.onClick(); });
    const running = (stage: "authorizing" | "updating-packages", progress: number) =>
      ({ progress: { stage, progress }, running: true, error: null });
    hook.rerender({ updates: { ...updates, run: running("authorizing", 0) }, building: false });
    expect(toasts().map((toast) => toast.title)).toEqual(["Waiting for administrator approval…"]);
    hook.rerender({ updates: { ...updates, run: running("updating-packages", 0.4) }, building: false });
    expect(toasts().map((toast) => [toast.title, toast.options.progress])).toEqual([["Updating LaTeX packages…", 0.4]]);
    hook.rerender({ updates: { ...updates, run: running("updating-packages", 0.7) }, building: false });
    expect(toasts()[0].options.progress).toBe(0.7);
    hook.rerender({
      updates: { ...updates, report: { managed: true, packages: [] }, run: { progress: { stage: "complete", progress: 1 }, running: false, error: null } },
      building: false,
    });
    expect(toasts().map((toast) => toast.title)).toEqual(["TeX packages updated. Build again to use them."]);
  });

  it("reads in Chinese", async () => {
    await activateAppLocale("zh-CN");
    try {
      await launch(fakeUpdates(outdated(true)));
      const [reminder] = toasts();
      expect(reminder.title).toBe("TeX 组件已过时");
      expect(reminder.options.primaryAction?.label).toBe("更新 TeX 组件");
      expect(reminder.options.secondaryAction?.label).toBe("稍后");
    } finally {
      await activateAppLocale("en");
    }
  });
});
