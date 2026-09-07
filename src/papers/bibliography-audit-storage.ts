import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n";
import type { AuditResult } from "./bibliography-audit";

export type SavedAudit = { snapshot: string; result: AuditResult; applied: boolean };
export type AuditReport = [string, SavedAudit][];
const pendingWrites = new Map<string, Promise<void>>();

function validRecord(record: unknown): record is [string, SavedAudit] {
  if (!Array.isArray(record) || record.length !== 2) return false;
  const [key, value] = record;
  return typeof key === "string"
    && typeof value?.snapshot === "string" && typeof value.applied === "boolean"
    && typeof value.result?.before === "string" && typeof value.result.message === "string"
    && ["checked", "update", "unavailable", "skipped", "conflict"].includes(value.result.status)
    && (value.result.after === undefined || typeof value.result.after === "string")
    && (value.result.checkedAt === undefined || (typeof value.result.checkedAt === "string" && Number.isFinite(Date.parse(value.result.checkedAt))))
    && Array.isArray(value.result.changes) && value.result.changes.every((change: AuditResult["changes"][number]) =>
      typeof change?.field === "string" && typeof change.before === "string" && typeof change.after === "string")
    && (value.result.sources === undefined || (Array.isArray(value.result.sources) && value.result.sources.every((source: NonNullable<AuditResult["sources"]>[number]) =>
      typeof source?.source === "string" && typeof source.outcome === "string")));
}

// Serialize writes across dialog unmounts too: a late save must never replace
// a newer check or an accepted proposal. Different projects remain independent.
export function saveAuditReport(projectRoot: string, report: AuditReport): Promise<void> {
  const write = (pendingWrites.get(projectRoot) ?? Promise.resolve()).catch(() => {}).then(() =>
    invoke<void>("bibliography_audit_report_save", { projectRoot, report }));
  pendingWrites.set(projectRoot, write);
  const clear = () => { if (pendingWrites.get(projectRoot) === write) pendingWrites.delete(projectRoot); };
  void write.then(clear, clear);
  return write;
}

export async function loadAuditReport(projectRoot: string): Promise<Map<string, SavedAudit>> {
  await pendingWrites.get(projectRoot)?.catch(() => {});
  const report = await invoke<unknown>("bibliography_audit_report_load", { projectRoot });
  if (report !== null) {
    if (!Array.isArray(report) || !report.every(validRecord)) throw new Error(i18n._(msg`Invalid saved bibliography audit report.`));
    return new Map(report);
  }

  // Import the old WebView report only when no native report exists. Keep the
  // original as a recovery copy; a failed native write must not lose it.
  let legacy: AuditReport = [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`lattice.bibliography-audit.v1:${projectRoot}`) ?? "[]");
    if (Array.isArray(value)) legacy = value.filter(validRecord);
  } catch { /* Old browser storage may be unavailable or malformed. */ }
  if (legacy.length) await saveAuditReport(projectRoot, legacy);
  return new Map(legacy);
}
