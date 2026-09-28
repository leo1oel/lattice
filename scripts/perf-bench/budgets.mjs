/**
 * Ceilings for the benchmark's gated counts (scripts/perf-bench/budgets.json)
 * and the ratchet that lowers them. Kept apart from the Chrome driver so the
 * rules are unit-tested (budgets.test.mjs).
 */

/** Every count the benchmark measures and reports. */
export const COUNTS = ["commits", "renders", "hooks", "recalcs", "layouts", "mutations"];

/**
 * Counts that depend on frame timing, so the same build measures them
 * differently from run to run and more so on a busy machine. They are measured
 * and reported, never gated: a flaky gate is worse than none.
 *
 * Chromium's recalculation and layout counts depend on how DOM changes fall
 * into frames everywhere (two changes landing in one frame share a pass; the
 * scroll scenarios measured 120–207 recalculations across runs of one build).
 * The rest are per scenario:
 * - scroll mutations: a Lattice scrollbar fades out 180 ms after the last
 *   scroll event, and how many of 40 notches that falls between depends on
 *   the machine;
 * - `markdown-visual-typing` renders and hooks: 24 keystrokes publish in one or
 *   two batches depending on timing, and each batch re-renders the editor
 *   chrome (634–1,243 renders across runs);
 * - `code-highlight` mutations: 2,510–2,957 across runs.
 */
export const REPORT_ONLY = ["recalcs", "layouts"];
export const REPORT_ONLY_BY_SCENARIO = {
  "markdown-visual-typing": ["renders", "hooks"],
  "code-highlight": ["mutations"],
  "pdf-scroll": ["mutations"],
  "source-scroll": ["mutations"],
  "markdown-preview-scroll": ["mutations"],
};

/** The counts a scenario's ceilings gate; they repeat from run to run. */
export const gatedCounts = (scenario) => {
  const reportOnly = [...REPORT_ONLY, ...(REPORT_ONLY_BY_SCENARIO[scenario] ?? [])];
  return COUNTS.filter((key) => !reportOnly.includes(key));
};

/**
 * Ceilings sit this far above the measurement that set them. The gated counts
 * repeat from run to run or move by a handful (a commit or two when an async
 * load lands before or after a step), and the CI runner is not the laptop that
 * set the ceiling. A regression worth catching multiplies a count, so it still
 * fails.
 */
export const HEADROOM = 0.2;
export const HEADROOM_MIN = 5;

export const ceilingFor = (value) => Math.ceil(value + Math.max(HEADROOM_MIN, value * HEADROOM));

/**
 * Compares measurements with the ceilings.
 *
 * Only a scenario's gatedCounts have ceilings.
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
    const gated = gatedCounts(name);
    // Report-only counts have no ceiling; drop any left from before they were.
    const ceilings = Object.fromEntries(Object.entries(next.scenarios[name] ?? {}).filter(([key]) => gated.includes(key)));
    if (Object.keys(ceilings).length !== Object.keys(next.scenarios[name] ?? {}).length) changed = true;
    for (const key of gated) {
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
