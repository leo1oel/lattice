// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PLATFORMS, judge, knownFailures } from "./gpui-e2e-verdict.mjs";

const entries = [
  { step: "known on both", platforms: ["macos", "windows"], reason: "r", followup: "LEO-14" },
  { step: "known on windows", platforms: ["windows"], reason: "r", followup: "LEO-15" },
];
const run = (steps, extra = {}) => ({ passed: false, steps: Object.entries(steps).map(([step, passed]) => ({ step, passed })), ...extra });

describe("gpui-e2e-verdict", () => {
  it("fails only on a step that is not a known failure on this platform", () => {
    const result = run({ "known on both": false, "known on windows": false, fine: true });
    expect(judge(result, entries, "windows")).toMatchObject({ ok: true, known: ["known on both", "known on windows"], fresh: [] });
    expect(judge(result, entries, "macos")).toMatchObject({ ok: false, known: ["known on both"], fresh: ["known on windows"] });
  });

  it("reports a known failure that passed, without failing", () => {
    expect(judge(run({ "known on both": true }), entries, "macos")).toMatchObject({ ok: true, fixed: ["known on both"] });
  });

  it("fails a run that did not finish or wrote nothing", () => {
    expect(judge(run({ fine: true }, { error: "the window closed" }), entries, "macos").ok).toBe(false);
    expect(judge(null, entries, "macos").ok).toBe(false);
  });

  it("gives every checked-in entry a platform, a reason and an owner, once", () => {
    const list = knownFailures();
    expect(list.length).toBeGreaterThan(0);
    for (const entry of list) {
      expect(entry.platforms.length, entry.step).toBeGreaterThan(0);
      expect(entry.platforms.every((platform) => PLATFORMS.includes(platform)), entry.step).toBe(true);
      expect(entry.reason.trim(), entry.step).not.toBe("");
      expect(entry.followup, entry.step).toMatch(/^[A-Z]+-\d+$/);
    }
    expect(new Set(list.map((entry) => entry.step)).size).toBe(list.length);
  });
});
