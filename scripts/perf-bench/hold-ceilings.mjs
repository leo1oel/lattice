import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyBudgets, machineAllowance } from "./budgets.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Holds a benchmark run's counts to the ceilings in budgetsFile (budgets.mjs
 * has the rules): checks them, or with --ratchet or --update rewrites the
 * file, prints what has room to ratchet and what is over, and sets exit code 1
 * for an overage under --check. With --machine-allowance, a count this
 * machine measures above the CI runner may exceed its ceiling by the recorded
 * ratio (machine-allowances.json).
 */
export function holdToCeilings(results, options, budgetsFile) {
  const mode = options.update ? "update" : options.ratchet ? "ratchet" : "check";
  const host = os.hostname().replace(/\.local$/, "");
  const allowance = options.machineAllowance
    ? machineAllowance(JSON.parse(readFileSync(path.join(repo, "scripts/perf-bench/machine-allowances.json"), "utf8")), host, options.engine)
    : {};
  for (const [scenario, counts] of Object.entries(allowance)) {
    for (const [key, factor] of Object.entries(counts)) console.log(`Machine allowance for ${host}: ${scenario} ${key} may read ${factor.toFixed(3)}× its ceiling.`);
  }
  const { budgets, failures, slack, changed } = applyBudgets(
    JSON.parse(readFileSync(budgetsFile, "utf8")),
    results.map(({ scenario, result }) => ({ name: scenario.name, result })),
    mode,
    options.engine,
    allowance,
  );
  if (changed && !options.dev && !options.only && !options.shard) {
    writeFileSync(budgetsFile, `${JSON.stringify(budgets, null, 2)}\n`);
    console.log(`\nWrote ${path.relative(repo, budgetsFile)}.`);
  } else if (changed) {
    console.log("\nCeilings are only written from a full production run (no --dev, --only or --shard).");
  }
  if (slack.length) {
    console.log(`\nRoom to ratchet (pnpm perf:bench --ratchet lowers these ceilings):`);
    for (const { scenario, key, value, ceiling } of slack) console.log(`  ${scenario} ${key}: ${value}, ceiling ${ceiling}`);
  }
  if (failures.length) {
    console.log("\nOver budget:");
    for (const { scenario, key, value, ceiling, limit } of failures) console.log(`  ${scenario} ${key}: ${value} exceeds ceiling ${ceiling}${limit ? ` (${limit} with this machine's allowance)` : ""}`);
    console.log("\nFind the cause with `pnpm perf:bench --dev --only <scenario> --json out.json`: each run lists the");
    console.log("components that rendered and the state hooks that started each update. Fix it, or, if the extra");
    console.log(`work is intended, raise the ceiling in ${path.relative(repo, budgetsFile)} and say why in the pull request.`);
    if (options.check) process.exitCode = 1;
  }
}
