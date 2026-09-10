import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { checkSynaraUpgrade } from "./check-synara-upgrade.mjs";

let root, projectRoot, oldSource, newSource, previousRevision;
const git = (cwd, ...args) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const commit = (cwd, message) => git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com",
  "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", message);
const pin = (sourceDirectory, revision) => writeFileSync(
  join(projectRoot, "scripts/synara-runtime.json"), JSON.stringify({ sourceDirectory, revision }),
);
const check = () => checkSynaraUpgrade({ projectRoot, previousRef: "HEAD" });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lattice-upgrade-"));
  projectRoot = join(root, "lattice");
  oldSource = join(root, "old");
  newSource = join(root, "new");
  mkdirSync(join(projectRoot, "scripts"), { recursive: true });
  mkdirSync(oldSource);
  git(oldSource, "init");
  writeFileSync(join(oldSource, "integration.txt"), "Lattice integration\n");
  git(oldSource, "add", ".");
  commit(oldSource, "integration");
  previousRevision = git(oldSource, "rev-parse", "HEAD");
  git(root, "clone", oldSource, newSource);
  commit(newSource, "upgrade");
  git(projectRoot, "init");
  pin("../old", previousRevision);
  git(projectRoot, "add", ".");
  commit(projectRoot, "previous pin");
  pin("../new", git(newSource, "rev-parse", "HEAD"));
  // Creating three real Git repositories can exceed Vitest's 10s hook
  // default while the release gate also runs the web and Rust builds.
}, 60_000);

afterEach(() => rmSync(root, { recursive: true, force: true }));

it("accepts a clean upgrade that includes the previous integration", () => {
  expect(check()).toEqual({ previousRevision, revision: git(newSource, "rev-parse", "HEAD") });
});

it.each(["old", "new"])("rejects untracked regression tests in the %s checkout", (which) => {
  writeFileSync(join(which === "old" ? oldSource : newSource, "regression.test.ts"), "test\n");
  expect(check).toThrow(/untracked changes/);
});

it("rejects tracked local patches left in the previous checkout", () => {
  writeFileSync(join(oldSource, "integration.txt"), "uncommitted fix\n");
  expect(check).toThrow(/uncommitted/);
});

it("rejects a replacement tree that drops the fork history", () => {
  git(newSource, "checkout", "--orphan", "replacement");
  commit(newSource, "clean upstream");
  pin("../new", git(newSource, "rev-parse", "HEAD"));
  expect(check).toThrow(/does not prove preservation/);
});

it("rejects a committed but unpinned fix missing from the upgrade", () => {
  commit(oldSource, "local fix not in the previous pin");
  expect(check).toThrow(/does not prove preservation/);
});

it("rejects a checkout at a different revision from the new pin", () => {
  pin("../new", previousRevision);
  expect(check).toThrow(/does not match/);
});

it("requires the previous checkout rather than silently skipping its audit", () => {
  rmSync(oldSource, { recursive: true, force: true });
  expect(check).toThrow(/checkout is missing/);
});
