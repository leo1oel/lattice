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

    for (const line of ["[ERROR] [Build] Build failed", "[WARNING] [PDF] No matching position",
      "[SUCCESS] [Overleaf] Already up to date", "[INFO] [App] Something happened"]) {
      expect(formatAppLogs()).toContain(line);
    }
  });

  it("gives failures something to paste into a bug report", () => {
    const id = notifyError("Overleaf", "Could not sync", { detail: "403 Forbidden" });
    // Filled in by `notify`, not by the caller — an error with no copyable text
    // is half a report, and 170 call sites will not each remember to pass one.
    expect(getAppToastOptions(id)?.copyText).toBe("Could not sync\n403 Forbidden");
    // Copy just repeats the toast here, so the log holds no second copy of it.
    expect(formatAppLogs()).not.toContain("full text");

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

  it.each([
    ["an Error", new Error("Undefined control sequence"), undefined, 1],
    ["a reason that is not an Error", "Undefined control sequence", undefined, 1],
    // A failure an inline error surface already shows must not toast a duplicate.
    ["toast: false", "Undefined control sequence", { toast: false }, 0],
  ] as const)("names the action in a failure and keeps the reason as detail (%s)", (_, reason, options, toasts) => {
    logAction("Build", "Build").fail(reason, options);

    expect(formatAppLogs()).toContain("[ERROR] [Build] Build failed");
    expect(formatAppLogs()).toContain("Undefined control sequence");
    expect(getVisibleAppToastIds()).toHaveLength(toasts);
  });

  it("emits one complete outcome with duration, initial context and accumulated counts", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(100);
    try {
      const trace = logAction("Build", "Structured build", "requested");
      trace.enrich({ diagnostics: 2 });
      trace.enrich({ has_pdf: true });
      clock.mockReturnValue(350);
      trace.finish("success", "Structured build complete");
      trace.finish("cancelled");
      const events = () => vi.mocked(fileLog.info).mock.calls
        .map((call) => JSON.parse(String(call[0])))
        .filter((entry) => entry.context?.operation_id === trace.id && entry.context.phase === "completed");
      await vi.waitFor(() => expect(events()).toHaveLength(1));
      expect(events()[0].context).toMatchObject({
        operation: "Structured build", outcome: "success", duration_ms: 250,
        trigger: "requested", metrics: { diagnostics: 2, has_pdf: true },
      });
      expect(getVisibleAppToastIds()).toHaveLength(0);
    } finally {
      clock.mockRestore();
    }
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

    // The toast shows the first diagnostic; the log has to hold everything the
    // user could paste into a report, or the two disagree about one failure.
    for (const text of ["chapters/intro.tex:42", "Build failed — full text", "l.42 \\badmacro", "(plus 300 more lines)"]) {
      expect(formatAppLogs()).toContain(text);
    }
    // Log-only: the extra text is for reading back, not a second interruption.
    expect(getVisibleAppToastIds()).toHaveLength(1);
  });

  it("keeps every occurrence on disk even when repeats fold into one toast", async () => {
    // A title of its own: the forward queue is asynchronous, so writes from
    // earlier tests can still be in flight and would be counted here.
    const title = "Bibliography rebuild failed";
    for (const detail of ["first", "second", "third"]) notifyError("Papers", title, { detail });

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
    for (const detail of ["first", "second", "third"]) expect(written().join("\n")).toContain(detail);
  });
});
