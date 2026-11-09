import { invoke } from "@tauri-apps/api/core";
import { fixGroup } from "./audit-groups";
import type { AuditEntry, AuditResult } from "./bibliography-audit";

/** What refreshing one cited entry did: rewrote it, found it current, or left a choice for Check references. */
export type RefreshOutcome = { kind: "updated" } | { kind: "current" } | { kind: "review" };

/**
 * Re-adding a paper that is already cited leaves its entry alone; this puts
 * that entry through the same check Add papers now runs on a new record, and
 * applies the result unless it would replace a value the writer stated
 * (a disputed fix, which waits in Check references like any other).
 */
export async function refreshCitedEntry(projectRoot: string, bibliography: string, key: string): Promise<RefreshOutcome> {
  const scan = await invoke<{ entries: AuditEntry[] }>("bibliography_audit_scan", { projectRoot });
  const entry = scan.entries.find((item) => !item.inline && item.path === bibliography && item.key === key);
  if (!entry) return { kind: "review" };
  const result = await invoke<AuditResult>("bibliography_audit_entry", { projectRoot, entry });
  if (result.status === "checked") return { kind: "current" };
  if (result.status !== "update" || !result.after || result.candidate || fixGroup(result.changes) === "disputed") return { kind: "review" };
  await invoke("bibliography_audit_apply", { projectRoot, path: entry.path, key: entry.key, before: result.before, after: result.after });
  return { kind: "updated" };
}
