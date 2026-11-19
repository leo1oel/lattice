import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { applyBudgets, bestOf, ceilingFor, COUNTS, gatedCounts, machineAllowance } from "./budgets.mjs";

const counts = (value) => Object.fromEntries(COUNTS.map((key) => [key, value]));
const ceilings = (value, scenario = "typing") => Object.fromEntries(gatedCounts(scenario).map((key) => [key, value]));

describe("perf bench budgets", () => {
  it("gives new scenarios a ceiling with headroom", () => {
    const { budgets, failures, changed } = applyBudgets({ scenarios: {} }, [{ name: "typing", result: counts(100) }], "check");
    expect(failures).toEqual([]);
    expect(changed).toBe(true);
    expect(budgets.scenarios.typing).toEqual(ceilings(ceilingFor(100)));
    expect(ceilingFor(100)).toBe(120);
    expect(ceilingFor(2)).toBe(7);
  });

  it("fails a count over its ceiling in check and ratchet mode alike", () => {
    const budgets = { scenarios: { typing: ceilings(120) } };
    const result = { ...counts(100), renders: 121 };
    for (const mode of ["check", "ratchet"]) {
      const outcome = applyBudgets(budgets, [{ name: "typing", result }], mode);
      expect(outcome.failures).toEqual([{ scenario: "typing", key: "renders", value: 121, ceiling: 120 }]);
      expect(outcome.budgets.scenarios.typing.renders).toBe(120);
    }
  });

  it("ratchets ceilings down but never up", () => {
    const budgets = { scenarios: { typing: { ...ceilings(120), commits: 10 } } };
    const { budgets: next, changed } = applyBudgets(budgets, [{ name: "typing", result: { ...counts(50), commits: 9 } }], "ratchet");
    expect(changed).toBe(true);
    expect(next.scenarios.typing.renders).toBe(ceilingFor(50));
    expect(next.scenarios.typing.commits).toBe(10);
    expect(budgets.scenarios.typing.renders).toBe(120);
  });

  it("only reports slack in check mode", () => {
    const budgets = { scenarios: { typing: ceilings(120) } };
    const outcome = applyBudgets(budgets, [{ name: "typing", result: counts(50) }], "check");
    expect(outcome.changed).toBe(false);
    expect(outcome.slack).toHaveLength(gatedCounts("typing").length);
    expect(outcome.budgets.scenarios.typing).toEqual(ceilings(120));
  });

  it("update sets every ceiling from the run, raising included", () => {
    const { budgets } = applyBudgets({ scenarios: { typing: ceilings(10) } }, [{ name: "typing", result: counts(100) }], "update");
    expect(budgets.scenarios.typing).toEqual(ceilings(ceilingFor(100)));
  });

  it("gates React and DOM counts but only reports frame-timing-dependent ones", () => {
    expect(gatedCounts("typing")).toEqual(["commits", "renders", "hooks", "mutations"]);
    expect(gatedCounts("pdf-scroll")).toEqual(["commits", "renders", "hooks"]);
    expect(gatedCounts("markdown-visual-typing")).toEqual(["commits", "mutations"]);
    expect(gatedCounts("latex-typing")).toEqual(["renders", "hooks", "mutations"]);
    expect(gatedCounts("markdown-preview-scroll")).toEqual([]);

    const budgets = { scenarios: { typing: ceilings(10), "pdf-scroll": ceilings(10, "pdf-scroll") } };
    const results = [
      { name: "typing", result: { ...counts(1), recalcs: 500, layouts: 500 } },
      { name: "pdf-scroll", result: { ...counts(1), recalcs: 500, layouts: 500, mutations: 500 } },
    ];
    for (const mode of ["check", "ratchet", "update"]) {
      const outcome = applyBudgets(budgets, results, mode);
      expect(outcome.failures).toEqual([]);
      expect(Object.keys(outcome.budgets.scenarios.typing)).toEqual(gatedCounts("typing"));
      expect(Object.keys(outcome.budgets.scenarios["pdf-scroll"])).toEqual(gatedCounts("pdf-scroll"));
    }
    const ungated = applyBudgets({ scenarios: { "markdown-preview-scroll": {} } }, [{ name: "markdown-preview-scroll", result: counts(10_000) }], "check");
    expect(ungated).toMatchObject({ failures: [], changed: false, budgets: { scenarios: { "markdown-preview-scroll": {} } } });
    const over = applyBudgets(budgets, [{ name: "pdf-scroll", result: { ...counts(1), hooks: 11 } }], "check");
    expect(over.failures).toEqual([{ scenario: "pdf-scroll", key: "hooks", value: 11, ceiling: 10 }]);
  });

  it("gates startup's updates instead of its commits, which follow how React batched them", () => {
    expect(gatedCounts("startup")).toEqual(["updates", "renders", "hooks"]);
    expect(gatedCounts("startup", "webkit")).toEqual(["updates", "renders", "hooks"]);
    expect(gatedCounts("typing")).not.toContain("updates");

    // CI on 2026-11-08: 27 startup commits against a ceiling of 26 on pull
    // requests that did not touch startup; main's own runs read 25–29.
    const budgets = { scenarios: { startup: { commits: 26, updates: 168, renders: 2024, hooks: 12910 } } };
    const result = { ...counts(1), commits: 27, updates: 140, renders: 1650, hooks: 12034 };
    const outcome = applyBudgets(budgets, [{ name: "startup", result }], "check");
    expect(outcome.failures).toEqual([]);
    expect(outcome.budgets.scenarios.startup).toEqual({ updates: 168, renders: 2024, hooks: 12910 });
    const more = applyBudgets(budgets, [{ name: "startup", result: { ...result, updates: 169 } }], "check");
    expect(more.failures).toEqual([{ scenario: "startup", key: "updates", value: 169, ceiling: 168 }]);
  });

  it("only reports WebKit's tab-drag commits and hooks, which follow the frames a drag spans there", () => {
    expect(gatedCounts("tab-drag")).toEqual(["commits", "renders", "hooks"]);
    expect(gatedCounts("tab-drag", "webkit")).toEqual(["renders"]);
    expect(gatedCounts("typing", "webkit")).toEqual(gatedCounts("typing"));

    // CI run 41224484791's WebKit job: 70 commits against a ceiling of 69.
    const budgets = { scenarios: { "tab-drag": { commits: 69, renders: 2171, hooks: 15422 } } };
    const result = { ...counts(1), commits: 70, renders: 1964, hooks: 15665 };
    const webkit = applyBudgets(budgets, [{ name: "tab-drag", result }], "check", "webkit");
    expect(webkit.failures).toEqual([]);
    expect(webkit.budgets.scenarios["tab-drag"]).toEqual({ renders: 2171 });
    const chromium = applyBudgets(budgets, [{ name: "tab-drag", result }], "check", "chromium");
    expect(chromium.failures.map(({ key }) => key)).toEqual(["commits", "hooks"]);
    // The run kept is the one with fewer renders, not the one with fewer commits.
    const fewerCommits = { ...counts(1), commits: 52, renders: 2000 };
    const fewerRenders = { ...counts(1), commits: 68, renders: 1990 };
    expect(bestOf("tab-drag", [fewerCommits, fewerRenders], "webkit")).toEqual(fewerRenders);
  });

  it("keeps the run with the fewest gated counts, whatever its report-only counts", () => {
    const noisy = { ...counts(1), commits: 12, recalcs: 120 };
    const quiet = { ...counts(1), commits: 9, recalcs: 200 };
    expect(bestOf("pdf-scroll", [noisy, quiet])).toEqual(quiet);
    expect(bestOf("pdf-scroll", [quiet, noisy])).toEqual(quiet);
    const scrollNoise = { ...counts(1), mutations: 500 };
    const fewerHooks = { ...counts(1), hooks: 0, mutations: 900 };
    expect(bestOf("pdf-scroll", [scrollNoise, fewerHooks])).toEqual(fewerHooks);
    expect(bestOf("typing", [scrollNoise, fewerHooks])).toEqual({ ...scrollNoise, hooks: 0 });
  });

  it("gates each count at its fewest across runs, not the kept run's", () => {
    // Hooks and mutations move by tens between runs and commits by one, so the
    // run with the smallest total need not be the one with the fewest commits.
    const fewerCommits = { ...counts(1), commits: 27, hooks: 12_227, mutations: 2_134, recalcs: 180 };
    const fewerHooks = { ...counts(1), commits: 28, hooks: 12_211, mutations: 2_114, recalcs: 170 };
    const result = bestOf("file-switch", [fewerCommits, fewerHooks]);
    expect(result).toMatchObject({ commits: 27, hooks: 12_211, mutations: 2_114 });
    // Report-only counts and details stay the kept run's.
    expect(result.recalcs).toBe(170);
  });

  it("drops ceilings left on counts that are now report-only", () => {
    const budgets = { scenarios: { typing: { ...ceilings(120), recalcs: 5, layouts: 5 } } };
    const { budgets: next, failures, changed } = applyBudgets(budgets, [{ name: "typing", result: counts(100) }], "check");
    expect(failures).toEqual([]);
    expect(changed).toBe(true);
    expect(next.scenarios.typing).toEqual(ceilings(120));
  });

  it("lets a machine's allowance stretch only its count, leaving the ceilings CI's", () => {
    const allowances = { machines: { mini: { webkit: { startup: { hooks: { github: 13612, local: 14361 } } } } } };
    const allowance = machineAllowance(allowances, "mini", "webkit");
    expect(allowance.startup.hooks).toBeCloseTo(1.055, 3);
    expect(machineAllowance(allowances, "mini", "chromium")).toEqual({});
    expect(machineAllowance(allowances, "elsewhere", "webkit")).toEqual({});

    const budgets = { scenarios: { startup: { updates: 168, renders: 2102, hooks: 13798 } } };
    const result = (hooks) => [{ name: "startup", result: { ...counts(100), hooks } }];
    const strict = applyBudgets(budgets, result(14361), "check", "webkit");
    expect(strict.failures).toEqual([{ scenario: "startup", key: "hooks", value: 14361, ceiling: 13798 }]);
    const allowed = applyBudgets(budgets, result(14361), "check", "webkit", allowance);
    expect(allowed.failures).toEqual([]);
    expect(allowed.budgets.scenarios.startup.hooks).toBe(13798);
    // A regression still fails, reported against the stretched limit.
    const over = applyBudgets(budgets, result(15000), "check", "webkit", allowance);
    expect(over.failures).toEqual([{ scenario: "startup", key: "hooks", value: 15000, ceiling: 13798, limit: 14558 }]);
    // Other counts get no allowance.
    const renders = applyBudgets(budgets, [{ name: "startup", result: { ...counts(100), renders: 2103, hooks: 1 } }], "check", "webkit", allowance);
    expect(renders.failures.map(({ key }) => key)).toEqual(["renders"]);
  });

  it("records each allowance as a same-commit pair the machine measured higher", () => {
    const file = JSON.parse(readFileSync(path.join(import.meta.dirname, "machine-allowances.json"), "utf8"));
    for (const [host, entry] of Object.entries(file.machines)) {
      expect(entry.machine, host).toEqual(expect.any(String));
      for (const engine of ["chromium", "webkit"]) {
        for (const [scenario, counts] of Object.entries(entry[engine] ?? {})) {
          for (const [key, { github, local, evidence }] of Object.entries(counts)) {
            expect(gatedCounts(scenario, engine), `${host} ${scenario}`).toContain(key);
            expect(local, `${host} ${scenario} ${key}`).toBeGreaterThan(github);
            expect(local / github, `${host} ${scenario} ${key}`).toBeLessThan(1.2);
            expect(evidence).toMatch(/run \d+/);
          }
        }
      }
    }
  });
});
