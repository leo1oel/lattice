import { describe, expect, it } from "vitest";
import { applyBudgets, ceilingFor, GATED } from "./budgets.mjs";

const counts = (value) => Object.fromEntries(GATED.map((key) => [key, value]));

describe("perf bench budgets", () => {
  it("gives new scenarios a ceiling with headroom", () => {
    const { budgets, failures, changed } = applyBudgets({ scenarios: {} }, [{ name: "typing", result: counts(100) }], "check");
    expect(failures).toEqual([]);
    expect(changed).toBe(true);
    expect(budgets.scenarios.typing.renders).toBe(ceilingFor(100));
    expect(ceilingFor(100)).toBe(120);
    expect(ceilingFor(2)).toBe(7);
  });

  it("fails a count over its ceiling in check and ratchet mode alike", () => {
    const budgets = { scenarios: { typing: counts(120) } };
    const result = { ...counts(100), renders: 121 };
    for (const mode of ["check", "ratchet"]) {
      const outcome = applyBudgets(budgets, [{ name: "typing", result }], mode);
      expect(outcome.failures).toEqual([{ scenario: "typing", key: "renders", value: 121, ceiling: 120 }]);
      expect(outcome.budgets.scenarios.typing.renders).toBe(120);
    }
  });

  it("ratchets ceilings down but never up", () => {
    const budgets = { scenarios: { typing: { ...counts(120), commits: 10 } } };
    const { budgets: next, changed } = applyBudgets(budgets, [{ name: "typing", result: { ...counts(50), commits: 9 } }], "ratchet");
    expect(changed).toBe(true);
    expect(next.scenarios.typing.renders).toBe(ceilingFor(50));
    expect(next.scenarios.typing.commits).toBe(10);
    expect(budgets.scenarios.typing.renders).toBe(120);
  });

  it("only reports slack in check mode", () => {
    const budgets = { scenarios: { typing: counts(120) } };
    const outcome = applyBudgets(budgets, [{ name: "typing", result: counts(50) }], "check");
    expect(outcome.changed).toBe(false);
    expect(outcome.slack).toHaveLength(GATED.length);
    expect(outcome.budgets.scenarios.typing).toEqual(counts(120));
  });

  it("update sets every ceiling from the run, raising included", () => {
    const { budgets } = applyBudgets({ scenarios: { typing: counts(10) } }, [{ name: "typing", result: counts(100) }], "update");
    expect(budgets.scenarios.typing).toEqual(counts(ceilingFor(100)));
  });
});
