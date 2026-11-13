import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Every repository file `pnpm test:e2e-harness` loads outside the app's own
 * source: the test, perf-bench.mjs and everything it imports, the Vite config
 * the bench build reads and its imports, and the bench page with its imports.
 * The app under `src/` is followed no further than its entry, so a change to
 * an editor component does not cost a production build; that route is what
 * the ci.yml benchmark jobs and the unit suite cover. `pnpm signoff` runs the
 * harness when one of these changed, which is why the list is computed from
 * the imports rather than kept by hand.
 */
export function harnessInputs() {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    if (file.startsWith("src/") || !/\.(?:m?js|ts)$/.test(file)) return;
    const source = readFileSync(path.join(repo, file), "utf8");
    for (const [, spec] of source.matchAll(/(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
      const target = path.relative(repo, path.resolve(repo, path.dirname(file), spec));
      if (existsSync(path.join(repo, target))) visit(target);
    }
  };
  for (const entry of [
    "scripts/perf-bench/smoke.test.mjs",
    "scripts/perf-bench.mjs",
    "vite.config.ts",
    "vitest.config.ts",
    "tools/perf-bench/index.html",
    "tools/perf-bench/bench-page.ts",
    "package.json",
    "pnpm-lock.yaml",
    ".github/actions/setup-pnpm/action.yml",
  ]) visit(entry);
  return [...seen].filter((file) => !file.startsWith("src/") || file === "src/index.css");
}
