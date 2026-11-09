import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshCitedEntry } from "./refresh-cited-entry";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => invoke.mockReset());

const entry = { path: "references.bib", key: "merity2016pointer", title: "Pointer Sentinel Mixture Models", bibtex: "@misc{merity2016pointer}", issues: [] };
const published = {
  status: "update", message: "", before: entry.bibtex, after: "@inproceedings{merity2016pointer}",
  changes: [{ field: "ENTRYTYPE", before: "misc", after: "inproceedings" }, { field: "booktitle", before: "", after: "ICLR" }],
};

function answer(result: object) {
  invoke.mockImplementation(async (command: string) => command === "bibliography_audit_scan"
    ? { entries: [{ ...entry, key: "other" }, entry], issues: [] }
    : command === "bibliography_audit_entry" ? result : undefined);
}

describe("refreshCitedEntry", () => {
  it("applies a published version to the cited entry", async () => {
    answer(published);
    await expect(refreshCitedEntry("/p", "references.bib", entry.key)).resolves.toEqual({ kind: "updated" });
    expect(invoke).toHaveBeenCalledWith("bibliography_audit_entry", { projectRoot: "/p", entry });
    expect(invoke).toHaveBeenCalledWith("bibliography_audit_apply", { projectRoot: "/p", path: "references.bib", key: entry.key, before: published.before, after: published.after });
  });

  it("leaves a current entry, a disputed value and an inconclusive check alone", async () => {
    for (const [result, kind] of [
      [{ status: "checked", message: "", before: entry.bibtex, changes: [] }, "current"],
      [{ ...published, changes: [{ field: "publisher", before: "Curran Associates, Inc.", after: "NeurIPS Foundation" }] }, "review"],
      [{ status: "unavailable", message: "", before: entry.bibtex, changes: [] }, "review"],
    ] as const) {
      invoke.mockReset();
      answer(result);
      await expect(refreshCitedEntry("/p", "references.bib", entry.key)).resolves.toEqual({ kind });
      expect(invoke).not.toHaveBeenCalledWith("bibliography_audit_apply", expect.anything());
    }
  });
});
