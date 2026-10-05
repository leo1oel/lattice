// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const workflow = parse(readFileSync(path.join(repo, ".github/workflows/bench-harness.yml"), "utf8"));

/**
 * Every repository file `pnpm test:e2e-harness` loads outside the app's own
 * source: the test, perf-bench.mjs and everything it imports, the Vite config
 * the bench build reads and its imports, and the bench page with its imports.
 * The app under `src/` is followed no further than its entry, so a change to
 * an editor component does not cost a production build here; that route is
 * what the ci.yml benchmark jobs and the unit suite cover.
 */
function harnessInputs() {
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
    ".github/workflows/bench-harness.yml",
  ]) visit(entry);
  return [...seen].filter((file) => !file.startsWith("src/") || file === "src/index.css");
}

// The filters use only two shapes, an exact path or `dir/**`, so this is the
// whole of GitHub's matching that applies to them.
function matches(pattern, file) {
  return pattern.endsWith("/**") ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
}

describe("bench-harness workflow path filters", () => {
  const push = workflow.on.push.paths;
  const pullRequest = workflow.on.pull_request.paths;

  it("are the same for pushes and pull requests", () => {
    expect(pullRequest).toEqual(push);
  });

  it("use only exact paths and directory globs", () => {
    for (const pattern of push) expect(pattern).toMatch(/^[^*]+(?:\/\*\*)?$/);
  });

  it.each(harnessInputs())("cover %s", (file) => {
    expect(push.some((pattern) => matches(pattern, file)), `${file} is a harness input missing from bench-harness.yml`).toBe(true);
  });
});
