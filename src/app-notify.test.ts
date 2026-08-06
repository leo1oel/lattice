import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fileLog from "@tauri-apps/plugin-log";
import { clearAppLogs, formatAppLogs, getAppToastOptions, getVisibleAppToastIds } from "./app-log-store";
import { logAction, notifyError, notifyInfo, notifySuccess, notifyWarning } from "./app-notify";

describe("app-notify", () => {
  beforeEach(() => {
    clearAppLogs();
  });

  // The point of routing everything through this module: a notification the
  // user saw but that left no trace was why support reports could not be
  // traced back to what the app actually did.
  it("records every notification it raises, at its own level", () => {
    notifyError("Build", "Build failed");
    notifyWarning("PDF", "No matching position");
    notifySuccess("Overleaf", "Already up to date");
    notifyInfo("App", "Something happened");

    const log = formatAppLogs();
    expect(log).toContain("[ERROR] [Build] Build failed");
    expect(log).toContain("[WARNING] [PDF] No matching position");
    expect(log).toContain("[SUCCESS] [Overleaf] Already up to date");
    expect(log).toContain("[INFO] [App] Something happened");
  });

  it("gives failures something to paste into a bug report", () => {
    const id = notifyError("Overleaf", "Could not sync", { detail: "403 Forbidden" });
    // Filled in by `notify`, not by the caller — an error with no copyable text
    // is half a report, and 170 call sites will not each remember to pass one.
    expect(getAppToastOptions(id)?.copyText).toBe("Could not sync\n403 Forbidden");

    const plain = notifySuccess("Overleaf", "Synced");
    expect(getAppToastOptions(plain)?.copyText).toBeUndefined();
  });

  it("ties an action's start, notes, and outcome together with one id", () => {
    const trace = logAction("Overleaf", "Sync", "requested");
    trace.note("pulled 2 files");
    trace.ok("Overleaf: pulled 2, pushed 0.");

    const log = formatAppLogs();
    const ids = [...log.matchAll(/#([0-9a-f]{6})/g)].map((match) => match[1]);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect(log).toContain("▶ Sync");
    expect(log).toContain("pulled 2 files");
    expect(log).toContain("Overleaf: pulled 2, pushed 0.");
  });

  it("names the action in a failure and keeps the reason as detail", () => {
    logAction("Build", "Build").fail(new Error("Undefined control sequence"));

    const log = formatAppLogs();
    expect(log).toContain("[ERROR] [Build] Build failed");
    expect(log).toContain("Undefined control sequence");
  });

  it("logs breadcrumbs without raising a toast for them", () => {
    const trace = logAction("Build", "Build");
    trace.note("Build succeeded in 1.2s");

    // The start line and the breadcrumb are log-only: an action that worked
    // should leave a trace without interrupting anyone.
    expect(formatAppLogs()).toContain("Build succeeded in 1.2s");
    expect(getVisibleAppToastIds()).toHaveLength(0);

    trace.fail("boom");
    expect(getVisibleAppToastIds()).toHaveLength(1);
  });

  it("logs whatever the Copy button offers, not just the line on screen", () => {
    const fullLog = "! Undefined control sequence.\nl.42 \\badmacro\n(plus 300 more lines)";
    notifyError("Build", "Build failed", { detail: "chapters/intro.tex:42", copyText: fullLog });

    const log = formatAppLogs();
    // The toast shows the first diagnostic; the log has to hold everything the
    // user could paste into a report, or the two disagree about one failure.
    expect(log).toContain("chapters/intro.tex:42");
    expect(log).toContain("Build failed — full text");
    expect(log).toContain("l.42 \\badmacro");
    expect(log).toContain("(plus 300 more lines)");
    // Log-only: the extra text is for reading back, not a second interruption.
    expect(getVisibleAppToastIds()).toHaveLength(1);
  });

  it("does not log a second copy when Copy just repeats the toast", () => {
    notifyError("Papers", "Import failed", { detail: "network unreachable" });
    expect(formatAppLogs()).not.toContain("full text");
  });

  it("survives a reason that is not an Error", () => {
    logAction("Papers", "Import").fail("plain string reason");
    expect(formatAppLogs()).toContain("plain string reason");
  });

  it("keeps every occurrence on disk even when repeats fold into one toast", async () => {
    // A title of its own: the forward queue is asynchronous, so writes from
    // earlier tests can still be in flight and would be counted here.
    const title = "Bibliography rebuild failed";
    notifyError("Papers", title, { detail: "first" });
    notifyError("Papers", title, { detail: "second" });
    notifyError("Papers", title, { detail: "third" });

    // One entry in the in-app list, showing the newest — that is the display
    // rule, so three identical failures cannot fill the whole toast stack…
    const log = formatAppLogs();
    expect(log.match(new RegExp(`\\[ERROR\\] \\[Papers\\] ${title}`, "g"))).toHaveLength(1);
    expect(log).toContain("third");
    expect(log).not.toContain("first");

    // …but all three reach the disk log, which is what a bug report is read
    // from, so nothing that happened is actually lost.
    const written = () => vi.mocked(fileLog.error).mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes(title));
    await vi.waitFor(() => expect(written()).toHaveLength(3));
    expect(written().join("\n")).toContain("first");
    expect(written().join("\n")).toContain("second");
    expect(written().join("\n")).toContain("third");
  });
});
