#!/usr/bin/env node
/**
 * `pnpm test:invariants`: the tests that read a stylesheet, fixture or config
 * off disk, or run a script that does (src/platform/invariant-tests.json). No
 * import leads from what they read to them, so `vitest related` never selects
 * them for a change to it; a CSS edit that breaks one used to surface only in
 * CI. All but the React Compiler guard (about 10 s) take well under a second,
 * so they run together every time. Extra arguments go to Vitest.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const invariantTests = () => Object.keys(JSON.parse(readFileSync(path.join(repo, "src/platform/invariant-tests.json"), "utf8")));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { status, signal } = spawnSync("pnpm", ["exec", "vitest", "run", ...invariantTests(), ...process.argv.slice(2)], { cwd: repo, stdio: "inherit" });
  process.exit(status ?? (signal ? 1 : 0));
}
