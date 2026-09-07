import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { activateAppLocale } from "../i18n";
import { loadAuditReport, saveAuditReport, type AuditReport } from "./bibliography-audit-storage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const report: AuditReport = [["refs.bib\0paper", {
  snapshot: "@article{paper}", applied: true,
  result: { status: "checked", message: "Checked", before: "@article{paper}", changes: [], checkedAt: "2026-09-06T16:37:27.014Z" },
}]];
let disk: Map<string, AuditReport>;
beforeEach(() => {
  localStorage.clear(); disk = new Map();
  vi.mocked(invoke).mockReset().mockImplementation(async (command, args) => {
    const { projectRoot, report } = args as { projectRoot: string; report: AuditReport };
    if (command === "bibliography_audit_report_load") return disk.get(projectRoot) ?? null;
    if (command === "bibliography_audit_report_save") { disk.set(projectRoot, report); return; }
    throw new Error(`Unexpected remote check: ${command}`);
  });
});

it("migrates old results once and restores them after WebView storage is cleared", async () => {
  localStorage.setItem("lattice.bibliography-audit.v1:/project", JSON.stringify(report));
  expect(await loadAuditReport("/project")).toEqual(new Map(report));
  expect(disk.get("/project")).toEqual(report);
  localStorage.clear();
  vi.mocked(invoke).mockClear();
  expect(await loadAuditReport("/project")).toEqual(new Map(report));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("bibliography_audit_report_load", { projectRoot: "/project" });
});

it("uses native reports instead of stale legacy data and isolates projects", async () => {
  await saveAuditReport("/project", report);
  localStorage.setItem("lattice.bibliography-audit.v1:/project", "[]");
  expect(await loadAuditReport("/project")).toEqual(new Map(report));
  expect(await loadAuditReport("/other")).toEqual(new Map());
  await saveAuditReport("/project", []);
  localStorage.setItem("lattice.bibliography-audit.v1:/project", JSON.stringify(report));
  expect(await loadAuditReport("/project")).toEqual(new Map());
});

it("retains legacy records if migration fails and reports the failure", async () => {
  localStorage.setItem("lattice.bibliography-audit.v1:/project", JSON.stringify(report));
  vi.mocked(invoke).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Disk full"));
  await expect(loadAuditReport("/project")).rejects.toThrow("Disk full");
  expect(JSON.parse(localStorage.getItem("lattice.bibliography-audit.v1:/project")!)).toEqual(report);
});

it("rejects malformed native data without overwriting it", async () => {
  vi.mocked(invoke).mockResolvedValue({ broken: true });
  await expect(loadAuditReport("/project")).rejects.toThrow("Invalid saved");
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("uses the active app locale for invalid-report errors", async () => {
  await activateAppLocale("zh-CN");
  try {
    vi.mocked(invoke).mockResolvedValue({ broken: true });
    await expect(loadAuditReport("/project")).rejects.toThrow("已保存的参考文献审查报告格式无效。");
  } finally {
    await activateAppLocale("en");
  }
});

it("tolerates malformed legacy browser storage", async () => {
  localStorage.setItem("lattice.bibliography-audit.v1:/project", "broken JSON");
  expect(await loadAuditReport("/project")).toEqual(new Map());
});

it("orders pending writes and waits for them before restoring", async () => {
  let finish!: () => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const first = saveAuditReport("/project", report);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
  const second = saveAuditReport("/project", []);
  const restored = loadAuditReport("/project");
  expect(invoke).toHaveBeenCalledTimes(1);
  finish();
  await Promise.all([first, second]);
  expect(await restored).toEqual(new Map());
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
    "bibliography_audit_report_save", "bibliography_audit_report_save", "bibliography_audit_report_load",
  ]);
});
