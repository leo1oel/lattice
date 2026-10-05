// @vitest-environment node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { patchedAt } from "./pdfjs-patch-swap.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDir = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lattice-pdfjs-patch-swap-test-"));
  dirs.push(dir);
  return dir;
};

/** A patch of web/viewer.mjs, from "one two three" to `lines`. */
const patchOf = (...lines) => [
  "diff --git a/web/viewer.mjs b/web/viewer.mjs",
  "--- a/web/viewer.mjs",
  "+++ b/web/viewer.mjs",
  "@@ -1,3 +1,3 @@",
  ...lines,
  "",
].join("\n");

describe("patchedAt", () => {
  it("rebuilds REF's file with its temporary directory inside a git checkout", () => {
    // A TMPDIR in this checkout, as when the driver runs with one.
    const checkout = tempDir();
    execFileSync("git", ["init", "-q", checkout]);
    const tmpRoot = path.join(checkout, ".tmp");
    mkdirSync(tmpRoot);
    const installed = tempDir();
    mkdirSync(path.join(installed, "web"));
    writeFileSync(path.join(installed, "web/viewer.mjs"), "one\nTWO\nthree\n");

    const pdfjs = patchedAt(
      installed,
      patchOf(" one", "-two", "+TWO", " three"),
      patchOf(" one", " two", "-three", "+THREE"),
      tmpRoot,
    );

    expect(Object.fromEntries(pdfjs)).toEqual({ "web/viewer.mjs": "one\ntwo\nTHREE\n" });
  });
});
