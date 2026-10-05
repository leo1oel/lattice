// @vitest-environment node
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkPerfEvidence } from "./check-perf-evidence.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = "docs/performance-data/manifest.json";
const WEBKIT_RAW = "docs/performance-data/pdf-window-2026-10-04-webkit.json";

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** A copy of what the check reads, for one test to break. */
function copy() {
  root = mkdtempSync(path.join(os.tmpdir(), "perf-evidence-"));
  for (const item of ["docs/performance.md", "docs/performance-data", "scripts/perf-bench/pdf-window-figures.mjs"]) {
    cpSync(path.join(repo, item), path.join(root, item), { recursive: true });
  }
  return root;
}
const edit = (file, change) => writeFileSync(path.join(root, file), change(readFileSync(path.join(root, file), "utf8")));
const editManifest = (change) => edit(MANIFEST, (text) => {
  const manifest = JSON.parse(text);
  change(manifest);
  return JSON.stringify(manifest);
});
const measured = (manifest) => manifest.tables.find((entry) => entry.kind === "measured");

describe("check-perf-evidence", () => {
  it("passes on the repository as it is", async () => {
    expect(await checkPerfEvidence(repo)).toEqual([]);
  });

  it("fails when a raw dataset is gone", async () => {
    copy();
    rmSync(path.join(root, WEBKIT_RAW));
    expect((await checkPerfEvidence(root)).join("\n")).toContain(`"raw" names ${WEBKIT_RAW}, which does not exist`);
  });

  it("fails when a published median changes without the data", async () => {
    copy();
    edit("docs/performance.md", (text) => text.replace("| Open → first page drawn (ms) | 670 | 306 |", "| Open → first page drawn (ms) | 670 | 296 |"));
    expect((await checkPerfEvidence(root)).join("\n")).toContain("the document says 296, the raw runs give 306");
  });

  it("fails when the data changes under a published median", async () => {
    copy();
    edit(WEBKIT_RAW, (text) => {
      const data = JSON.parse(text);
      for (const run of data.results) if (run.variant === "after") run.openMs += 50;
      return JSON.stringify(data);
    });
    expect((await checkPerfEvidence(root)).join("\n")).toContain("the raw runs give 356");
  });

  it("fails when engine provenance is omitted", async () => {
    copy();
    editManifest((manifest) => { delete measured(manifest).engine; });
    expect((await checkPerfEvidence(root)).join("\n")).toContain(`"engine" is missing`);
  });

  it("fails when a commit is abbreviated", async () => {
    copy();
    editManifest((manifest) => { measured(manifest).after = "6eac4215"; });
    expect((await checkPerfEvidence(root)).join("\n")).toContain(`"after" must be a full 40-character commit SHA`);
  });

  it("fails when the recorded --before-ref disagrees with the manifest", async () => {
    copy();
    editManifest((manifest) => { measured(manifest).before = "0".repeat(40); });
    expect((await checkPerfEvidence(root)).join("\n")).toContain(`"before" is not the --before-ref the runs record (31921114)`);
  });

  it("fails on a new table the manifest does not account for", async () => {
    copy();
    edit("docs/performance.md", (text) => `${text}\n### A new finding\n\n| Scenario | Before | After |\n| --- | --- | --- |\n| Open | 120 | 80 |\n`);
    expect((await checkPerfEvidence(root)).join("\n")).toMatch(/A new finding \| Scenario \| Before \| After\): not in docs\/performance-data\/manifest\.json/);
  });

  it("fails on a manifest entry whose table is gone", async () => {
    copy();
    edit("docs/performance.md", (text) => text.replace("| WebKit, 386 pages | Before | After |", "| WebKit, 386-page PDF | Before | After |"));
    const errors = (await checkPerfEvidence(root)).join("\n");
    expect(errors).toContain(`has no table "WebKit, 386 pages | Before | After"`);
  });
});
