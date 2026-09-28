/**
 * Ceilings for the benchmark's gated counts (scripts/perf-bench/budgets.json)
 * and the ratchet that lowers them. Kept apart from the Chrome driver so the
 * rules are unit-tested (budgets.test.mjs).
 */

/** The gated counts. Everything else in a result is informational. */
export const GATED = ["commits", "renders", "hooks", "recalcs", "layouts", "mutations"];

/**
 * Ceilings sit this far above the measurement that set them. Commits, renders,
 * hooks and mutations repeat exactly from run to run; recalculations and
 * layouts move a few percent with frame alignment (two DOM changes landing in
 * one frame share a pass), and the CI runner is not the laptop that set the
 * ceiling. A regression worth catching multiplies a count, so it still fails.
 */
export const HEADROOM = 0.2;
export const HEADROOM_MIN = 5;

export const ceilingFor = (value) => Math.ceil(value + Math.max(HEADROOM_MIN, value * HEADROOM));

/**
 * Compares measurements with the ceilings.
 *
 * mode "check": report counts over their ceiling, and ceilings the counts now
 *   beat by enough to ratchet. Scenarios without ceilings get them.
 * mode "ratchet": lower every ceiling the counts beat; never raise one.
 * mode "update": set every ceiling from these counts, up or down.
 *
 * @param {{ scenarios: Record<string, Record<string, number>> }} budgets
 * @param {{ name: string, result: Record<string, number> }[]} results
 * @param {"check" | "ratchet" | "update"} mode
 */
export function applyBudgets(budgets, results, mode) {
  const next = { ...budgets, scenarios: { ...budgets.scenarios } };
  const failures = [];
  const slack = [];
  let changed = false;
  for (const { name, result } of results) {
    const ceilings = { ...next.scenarios[name] };
    for (const key of GATED) {
      const value = result[key];
      const ceiling = ceilings[key];
      const proposed = ceilingFor(value);
      if (ceiling === undefined || mode === "update") {
        if (ceiling !== proposed) changed = true;
        ceilings[key] = proposed;
      } else if (value > ceiling) {
        failures.push({ scenario: name, key, value, ceiling });
      } else if (proposed < ceiling) {
        if (mode === "ratchet") {
          ceilings[key] = proposed;
          changed = true;
        } else if (proposed < ceiling * 0.8) {
          slack.push({ scenario: name, key, value, ceiling });
        }
      }
    }
    next.scenarios[name] = ceilings;
  }
  return { budgets: next, failures, slack, changed };
}
