import { msg } from "@lingui/core/macro";
import { invoke } from "@tauri-apps/api/core";
import { i18n } from "../i18n";
import type { AuditResult } from "./bibliography-audit";

export type SavedAudit = { snapshot: string; result: AuditResult; applied: boolean };
export type AuditReport = [string, SavedAudit][];
const pendingWrites = new Map<string, Promise<void>>();

const arrayOf = <T>(value: unknown, valid: (item: T) => boolean) => Array.isArray(value) && value.every((item) => valid(item));
const validChange = (change: AuditResult["changes"][number]) =>
  typeof change?.field === "string" && typeof change.before === "string" && typeof change.after === "string";

function validRecord(record: unknown): record is [string, SavedAudit] {
  if (!Array.isArray(record) || record.length !== 2) return false;
  const [key, value] = record;
  const result = value?.result;
  return typeof key === "string"
    && typeof value?.snapshot === "string" && typeof value.applied === "boolean"
    && typeof result?.before === "string" && typeof result.message === "string"
    && ["checked", "update", "unavailable", "skipped", "conflict"].includes(result.status)
    && (result.after === undefined || typeof result.after === "string")
    && (result.checkedAt === undefined || (typeof result.checkedAt === "string" && Number.isFinite(Date.parse(result.checkedAt))))
    && arrayOf(result.changes, validChange)
    && (result.candidate === undefined || (
      typeof result.candidate === "object" && result.candidate !== null
      && typeof result.candidate.bibtex === "string"
      && arrayOf(result.candidate.reasons, (reason: unknown) => typeof reason === "string")
      && arrayOf(result.candidate.changes, validChange)))
    && (result.sources === undefined || arrayOf(result.sources, (source: NonNullable<AuditResult["sources"]>[number]) =>
      typeof source?.source === "string" && typeof source.outcome === "string"));
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

  // Legacy WebView reports predate the stricter identity checks. Keep their
  // storage untouched, but require a fresh check instead of restoring proposals.
  return new Map();
}
