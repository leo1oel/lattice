import { describe, expect, it } from "vitest";
import { applyBudgets, bestOf, ceilingFor, COUNTS, gatedCounts } from "./budgets.mjs";

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

  it("keeps the run with the fewest gated counts, whatever its report-only counts", () => {
    const noisy = { ...counts(1), commits: 12, recalcs: 120 };
    const quiet = { ...counts(1), commits: 9, recalcs: 200 };
    expect(bestOf("pdf-scroll", [noisy, quiet])).toBe(quiet);
    expect(bestOf("pdf-scroll", [quiet, noisy])).toBe(quiet);
    const scrollNoise = { ...counts(1), mutations: 500 };
    const fewerHooks = { ...counts(1), hooks: 0, mutations: 900 };
    expect(bestOf("pdf-scroll", [scrollNoise, fewerHooks])).toBe(fewerHooks);
    expect(bestOf("typing", [scrollNoise, fewerHooks])).toBe(scrollNoise);
  });

  it("drops ceilings left on counts that are now report-only", () => {
    const budgets = { scenarios: { typing: { ...ceilings(120), recalcs: 5, layouts: 5 } } };
    const { budgets: next, failures, changed } = applyBudgets(budgets, [{ name: "typing", result: counts(100) }], "check");
    expect(failures).toEqual([]);
    expect(changed).toBe(true);
    expect(next.scenarios.typing).toEqual(ceilings(120));
  });
});
