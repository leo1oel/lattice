import { describe, expect, it } from "vitest";
import { check, normalizeDoi, toBibtex } from "./check.mjs";

const entry = (key, type, fields, line = 1) => ({ key, type, fields, line });

describe("bib-check", () => {
  it("finds keys repeated across files, case-insensitively", () => {
    const items = check([
      { path: "a.bib", entries: [entry("smith20", "misc", {}, 3)] },
      { path: "b.bib", entries: [entry("Smith20", "misc", {}, 7)] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ file: "b.bib", line: 7, severity: "error", code: "duplicate-key" });
    expect(items[0].message).toContain("a.bib (line 3)");
    expect(items[0].fixes[0]).toEqual({ type: "reveal", file: "b.bib", line: 7, title: "Show" });
  });

  it("finds the same DOI under two keys, however it is written", () => {
    const items = check([
      {
        path: "refs.bib",
        entries: [entry("a", "misc", { doi: "10.1/X" }), entry("b", "misc", { doi: "https://doi.org/10.1/x" }, 5)],
      },
    ]);
    expect(items.map((d) => d.code)).toEqual(["doi-format", "duplicate-doi", "doi-format"]);
  });

  it("offers a confirmed replacement that normalizes a DOI", () => {
    const e = entry("a", "article", { author: "A", title: "T", journal: "J", year: "2020", doi: "doi: 10.5/AbC" });
    const [diagnostic] = check([{ path: "refs.bib", entries: [e] }]);
    const fix = diagnostic.fixes.find((f) => f.type === "replaceBibEntry");
    expect(fix).toMatchObject({ key: "a", file: "refs.bib" });
    expect(fix.bibtex).toContain("doi = {10.5/abc}");
    expect(fix.bibtex.startsWith("@article{a,")).toBe(true);
  });

  it("knows each type's required fields, with alternatives", () => {
    const items = check([
      { path: "r.bib", entries: [entry("b", "book", { editor: "E", title: "T", publisher: "P", year: "2001" }), entry("t", "phdthesis", { author: "A", title: "T", year: "2001" })] },
    ]);
    expect(items.map((d) => d.message)).toEqual(["“t” (@phdthesis) has no school."]);
  });

  it("reports a file that does not parse and skips its entries", () => {
    const items = check([{ path: "bad.bib", entries: [], error: "Line 4: an entry is never closed." }]);
    expect(items).toEqual([{ id: "parse:bad.bib", file: "bad.bib", severity: "error", code: "parse-error", message: "Line 4: an entry is never closed.", fixes: [] }]);
  });

  it("normalizes DOIs and writes entries back", () => {
    expect(normalizeDoi(" https://dx.doi.org/10.1000/ABC ")).toBe("10.1000/abc");
    expect(toBibtex(entry("k", "misc", { title: "T" }))).toBe("@misc{k,\n  title = {T}\n}");
  });
});
