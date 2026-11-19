// @vitest-environment node
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PLATFORMS, judge, knownFailures, rerunModules, settle } from "./gpui-e2e-verdict.mjs";

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

  it("reruns the modules of the new failures, the smoke flow for a step outside one", () => {
    const result = { steps: [
      { step: "a", passed: false, module: "tree" },
      { step: "b", passed: false, module: "tree" },
      { step: "c", passed: false, module: null },
      { step: "known on both", passed: false, module: "pdf" },
      { step: "d", passed: true, module: "find" },
    ] };
    expect(rerunModules(result, ["a", "b", "c"])).toEqual(["tree", "smoke"]);
  });

  it("calls a new failure that passed on the rerun flaky, and one that failed again new", () => {
    const verdict = judge(run({ a: false, b: false, fine: true }), entries, "macos");
    const settled = settle(verdict, run({ a: true, b: false }));
    expect(settled).toMatchObject({ ok: false, fresh: ["b"], flaky: ["a"] });
    expect(settle(verdict, run({ a: true, b: true }))).toMatchObject({ ok: true, fresh: [], flaky: ["a", "b"] });
    expect(settle(verdict, null)).toMatchObject({ ok: false, fresh: ["a", "b"], flaky: [] });
  });

  it.skipIf(process.platform === "win32")("passes a run whose only new failure passes when the app runs its module again", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "verdict-"));
    try {
      const fixture = path.join(dir, "fixture");
      mkdirSync(fixture);
      writeFileSync(path.join(fixture, "main.tex"), "x");
      const app = path.join(dir, "app");
      // Writes a passing result for whatever --only names, and records the call.
      writeFileSync(app, `#!/bin/sh\necho "$@" > "${dir}/args"\nwhile [ "$1" != "--out" ]; do shift; done\nprintf '{"passed":true,"steps":[{"step":"flaky one","passed":true}]}' > "$2"\n`);
      chmodSync(app, 0o755);
      const result = path.join(dir, "result.json");
      writeFileSync(result, JSON.stringify(run({ "flaky one": false, fine: true }, { steps: [{ step: "flaky one", passed: false, module: "tree" }, { step: "fine", passed: true, module: null }] })));
      const verdict = spawnSync(process.execPath, [path.join(import.meta.dirname, "gpui-e2e-verdict.mjs"), "--platform", "macos", "--rerun-app", app, "--fixture", fixture, result], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
      expect(verdict.stdout).toContain("0 new failure(s), 1 flaky");
      expect(verdict.stdout).toContain("::warning title=Flaky e2e step (macos)::flaky one");
      expect(verdict.status).toBe(0);
      expect(spawnSync("cat", [path.join(dir, "args")], { encoding: "utf8" }).stdout).toMatch(/--scenario e2e --only tree --out /);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
