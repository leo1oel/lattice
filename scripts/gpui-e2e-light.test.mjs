import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classify, quarantined, readBaseline, shouldRetry } from "./gpui-e2e-light.mjs";

const scenario = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../gpui/crates/lattice-gpui/src/scenario");

function scenarioSources(dir = scenario) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? scenarioSources(path.join(dir, entry.name)) : entry.name.endsWith(".rs") ? [readFileSync(path.join(dir, entry.name), "utf8")] : []));
}

describe("gpui-e2e-light", () => {
  it("retries only when every failing step is quarantined", () => {
    const quarantine = ["flaky"];
    expect(shouldRetry([], quarantine)).toBe(false);
    expect(shouldRetry(["flaky"], quarantine)).toBe(true);
    expect(shouldRetry(["flaky", "real"], quarantine)).toBe(false);
  });

  it("counts a failure main shares as pre-existing", () => {
    const baseline = { record: { e2e: { failing: ["⌘, opens Settings, on the page it was left on"] } } };
    expect(classify(["⌘, opens Settings, on the page it was left on", "new"], baseline)).toEqual({ own: ["new"], preExisting: ["⌘, opens Settings, on the page it was left on"] });
    expect(classify(["new"], null)).toEqual({ own: ["new"], preExisting: [] });
  });

  it("reads the merge base's baseline, else the latest", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "baseline-"));
    try {
      expect(readBaseline("abc", dir)).toBeNull();
      writeFileSync(path.join(dir, "latest.json"), JSON.stringify({ sha: "def" }));
      expect(readBaseline("abc", dir)).toMatchObject({ exact: false, record: { sha: "def" } });
      writeFileSync(path.join(dir, "known-failures@abc.json"), JSON.stringify({ sha: "abc" }));
      expect(readBaseline("abc", dir)).toMatchObject({ exact: true, record: { sha: "abc" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("quarantines steps the scenario still has", () => {
    // Names are written whole in the source, less a "PDF: " the PDF steps add.
    const sources = scenarioSources().join("\n");
    for (const step of quarantined()) expect(sources, step).toContain(step.replace(/^PDF: /, "").slice(0, 40));
  });
});
