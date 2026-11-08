import { COUNTS } from "./budgets.mjs";

/** The benchmark's printed table: each scenario's counts per unit of interaction. */
export function formatTable(results) {
  const rows = [["scenario", "unit", ...COUNTS.map((key) => `${key}/unit`), "long tasks", "task ms"]];
  for (const { scenario, result } of results) {
    rows.push([
      scenario.name,
      `${scenario.steps} ${scenario.unit}`,
      ...COUNTS.map((key) => (result[key] === null ? "–" : (result[key] / scenario.steps).toFixed(1))),
      String(result.info.longTasks),
      String(result.info.taskMs ?? "–"),
    ]);
  }
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ")).join("\n");
}
