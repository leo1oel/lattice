/**
 * Tests exercise behaviour; they do not grep source.
 *
 * A test that reads a repository file as text and asserts a string is in it
 * passes as long as the string survives — a renamed call, a dead branch or a
 * comment all satisfy it — and reviewers kept rejecting such tests. This guard
 * fails when a test file under `src/` or `tools/` reads a file off disk
 * (`readFile`/`readFileSync` from `fs` or `fs/promises`) or imports one with
 * Vite's `?raw` suffix, unless `invariant-tests.json` lists it with what it
 * guards. The entries are deliberate: repo-level contracts with no runtime to
 * drive, or stylesheets and fixtures Vitest would otherwise hand over empty.
 * The list only shrinks — an entry that no longer reads a file fails too.
 *
 * The same list is what `pnpm test:invariants` runs. No import leads from a
 * stylesheet or fixture to the test that reads it, so `vitest related` (and
 * `pnpm gate:changed`, which uses it) cannot find these tests from a change to
 * what they read; this guard is what keeps that list complete.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import invariantTests from "./invariant-tests.json";

const ALLOWED = new Set(Object.keys(invariantTests));

const FS_IMPORT = /\bfrom\s+["'](?:node:)?fs(?:\/promises)?["']|\bimport\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/;
const FS_READ = /\breadFile(?:Sync)?\b/;
const RAW_IMPORT = /["'][^"'\n]*\?raw["']/;

/** Test files under src/ and tools/ that Git tracks or would add. */
function testFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "src", "tools"], { encoding: "utf8" });
  return output.split("\0").filter((path) => /\.test\.tsx?$/.test(path));
}

function readsSourceText(path: string): boolean {
  const source = readFileSync(path, "utf8");
  return (FS_IMPORT.test(source) && FS_READ.test(source)) || RAW_IMPORT.test(source);
}

describe("source-text test guard", () => {
  const readers = testFiles().filter(readsSourceText);

  it("finds no test outside the allowlist reading a source file as text", () => {
    expect(
      readers.filter((path) => !ALLOWED.has(path)),
      "These tests read a repository file as text (fs readFile/readFileSync or a `?raw` import). " +
        "Test the behaviour instead: render it, call it, or drive it. If the file is a deliberate " +
        "repo-level guard, add it to src/platform/invariant-tests.json with what it guards.",
    ).toEqual([]);
  });

  it("keeps no allowlist entry for a test that no longer reads source text", () => {
    expect(
      [...ALLOWED].filter((path) => !readers.includes(path)),
      "Remove these entries from src/platform/invariant-tests.json: the files are gone or no longer read source text.",
    ).toEqual([]);
  });
});
