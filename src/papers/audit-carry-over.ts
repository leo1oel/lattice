/**
 * Which of Check references' saved results still describe a reference after
 * a rescan. Each entry is judged alone: an edit to one entry, or to the
 * manuscript, leaves every other result standing.
 */
import type { AuditEntry, AuditResult } from "./bibliography-audit";
import type { AuditReport, SavedAudit } from "./bibliography-audit-storage";

/** Results follow an entry across rescans by its file and citation key. */
export const auditKey = (entry: AuditEntry) => `${entry.path}\0${entry.key}`;

export function auditReport(entries: AuditEntry[], results: Record<number, AuditResult>, applied: Set<number>, kept: Set<number>): AuditReport {
  return entries.flatMap((entry, index) => results[index]
    ? [[auditKey(entry), {
      snapshot: entry.bibtex,
      ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}),
      result: results[index],
      applied: applied.has(index),
      ...(kept.has(index) ? { kept: true } : {}),
    }]]
    : []);
}

/**
 * Carries prior results over to a fresh scan while an entry says the same
 * thing: the same BibTeX, or the same content written differently (the scan's
 * `fingerprint`), as when a tool reformats the whole file. A reformatted
 * entry's result is rebased onto its current text, which applying a fix
 * checks against. `changed` decides what an edited entry shows instead.
 */
export function carryOver(entries: AuditEntry[], prior: Map<string, SavedAudit>, changed?: (entry: AuditEntry, saved: SavedAudit) => AuditResult) {
  const results: Record<number, AuditResult> = {};
  const applied = new Set<number>();
  const kept = new Set<number>();
  entries.forEach((entry, index) => {
    const saved = prior.get(auditKey(entry));
    if (saved && (saved.snapshot === entry.bibtex || (!!entry.fingerprint && saved.fingerprint === entry.fingerprint))) {
      results[index] = saved.snapshot === entry.bibtex ? saved.result : { ...saved.result, before: entry.bibtex };
      if (saved.applied) applied.add(index);
      if (saved.kept) kept.add(index);
    } else if (saved && changed) {
      results[index] = changed(entry, saved);
    }
  });
  return { results, applied, kept };
}
