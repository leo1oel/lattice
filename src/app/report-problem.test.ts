import { afterEach, describe, expect, it, vi } from "vitest";
import { addAppLog, clearAppLogs } from "../telemetry/app-log-store";
import { createAppLogExport } from "../telemetry/app-log-export";
import { newIssueUrl, reportProblem } from "./report-problem";

const tauri = vi.hoisted(() => ({ invoke: vi.fn(), openUrl: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: tauri.openUrl }));

afterEach(() => {
  tauri.invoke.mockReset();
  tauri.openUrl.mockReset();
  clearAppLogs();
});

describe("Help ▸ Report a Problem…", () => {
  it("prefills only the Lattice version, the macOS version and the architecture", () => {
    const url = new URL(newIssueUrl({ osVersion: "15.1", arch: "aarch64" }, "0.16.1"));
    expect(url.origin + url.pathname).toBe("https://github.com/leo1oel/lattice/issues/new");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      template: "bug_report.yml",
      "lattice-version": "0.16.1",
      "macos-version": "macOS 15.1 (aarch64)",
    });
  });

  it("saves the redacted export Settings › Logs makes, then opens the issue without any log text", async () => {
    addAppLog({ level: "error", source: "Build", title: "Build failed", detail: "Undefined control sequence in /Users/me/secret-paper.tex", toast: false });
    tauri.invoke.mockResolvedValue({ osVersion: "15.1", arch: "aarch64" });
    await reportProblem();

    const [command, args] = tauri.invoke.mock.calls[0] as [string, { contents: string }];
    expect(command).toBe("save_problem_report");
    const saved = JSON.parse(args.contents) as ReturnType<typeof createAppLogExport>;
    expect(saved.includes_raw_diagnostic).toBe(false);
    expect(args.contents).not.toContain("secret-paper");
    const url = tauri.openUrl.mock.calls[0]?.[0] as string;
    expect(url).not.toMatch(/Build|secret|Undefined/);
    expect(url).toContain("macos-version=macOS+15.1+%28aarch64%29");
  });

  it("opens nothing when the log could not be saved, and says why", async () => {
    tauri.invoke.mockRejectedValue(new Error("Could not create the report folder: permission denied"));
    await reportProblem();
    expect(tauri.openUrl).not.toHaveBeenCalled();
  });
});
