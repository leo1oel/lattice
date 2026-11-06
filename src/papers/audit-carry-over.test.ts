import { expect, it } from "vitest";
import { auditKey, auditReport, carryOver } from "./audit-carry-over";
import type { AuditEntry, AuditResult } from "./bibliography-audit";

const entry = (key: string, bibtex: string, fingerprint?: string): AuditEntry => ({
  path: "references.bib", key, title: key, bibtex, issues: [], ...(fingerprint ? { fingerprint } : {}),
});
const verified = (before: string): AuditResult => ({ status: "checked", message: "No update found.", before, changes: [] });

it("keeps every result whose entry says the same thing, and only those", () => {
  const before = [
    entry("same", "@article{same,title={Same}}", "f-same"),
    entry("tidied", "@article{tidied,title={T},year={2017}}", "f-tidied"),
    entry("edited", "@article{edited,title={Old}}", "f-old"),
    entry("removed", "@article{removed,title={Gone}}", "f-gone"),
  ];
  const results = Object.fromEntries(before.map((item, index) => [index, verified(item.bibtex)]));
  const saved = new Map(auditReport(before, results, new Set([1]), new Set([1])));
  expect(saved.get(auditKey(before[0]))).toMatchObject({ snapshot: before[0].bibtex, fingerprint: "f-same" });

  const after = [
    before[0],
    // A whole-file reformat: new text, same content.
    entry("tidied", "@article{tidied,\n  year          = {2017},\n  title         = {T},\n}", "f-tidied"),
    entry("edited", "@article{edited,title={New}}", "f-new"),
    entry("added", "@article{added,title={New paper}}", "f-added"),
  ];
  const changed = (item: AuditEntry): AuditResult => ({ status: "conflict", message: "changed", before: item.bibtex, changes: [] });
  const carried = carryOver(after, saved, changed);
  expect(carried.results[0]).toEqual(results[0]);
  // Rebased onto the current text, which Apply's snapshot check compares.
  expect(carried.results[1]).toEqual({ ...results[1], before: after[1].bibtex });
  expect([...carried.applied, ...carried.kept]).toEqual([1, 1]);
  expect(carried.results[2]).toMatchObject({ status: "conflict" });
  expect(carried.results[3]).toBeUndefined();
});

it("compares the text alone for a report or a scan without fingerprints", () => {
  const old = entry("legacy", "@article{legacy,title={L}}");
  const saved = new Map(auditReport([old], { 0: verified(old.bibtex) }, new Set(), new Set()));
  expect(carryOver([old], saved).results[0]).toEqual(verified(old.bibtex));
  expect(carryOver([entry("legacy", "@article{legacy, title={L}}", "f")], saved).results[0]).toBeUndefined();
});
