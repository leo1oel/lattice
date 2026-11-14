import { describe, expect, it } from "vitest";
import { baselineDir, parseE2e, parseGate } from "./gpui-main-baseline.mjs";

describe("gpui-main-baseline", () => {
  it("reads the gate's stage lines", () => {
    const output = [
      "gate:changed: 0 changed file(s) against abc (abc123456)",
      "  lint       ok          12.3 s  (oxlint with the warning cap)",
      "  knip       FAILED       8.0 s  (unused files, exports and dependencies)",
      "    | Unused exports (2)",
      "  vitest     TIMED OUT after 900 s  901.0 s  (related tests)",
      "  i18n       skipped  (no source or catalog changed)",
      "gate:changed: 2 stage(s) failed",
    ].join("\n");
    expect(parseGate(output).map((stage) => [stage.name, stage.verdict])).toEqual([
      ["lint", "ok"],
      ["knip", "failed"],
      ["vitest", "failed"],
      ["i18n", "skipped"],
    ]);
  });

  it("names the failing e2e steps", () => {
    const result = { passed: false, steps: [{ step: "a", passed: true }, { step: "⌘, opens Settings", passed: false }] };
    expect(parseE2e(result)).toEqual({ passed: false, total: 2, failing: ["⌘, opens Settings"] });
    expect(parseE2e({ error: "boom" })).toMatchObject({ passed: false, error: "boom" });
    expect(parseE2e(null)).toMatchObject({ passed: false, error: "no result was written" });
  });

  it("writes under the shared build directory", () => {
    expect(baselineDir({ LATTICE_GPUI_BUILD_DIR: "/x" })).toBe("/x/main-baseline");
  });
});
