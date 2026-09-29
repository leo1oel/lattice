/**
 * The visual Markdown editor is Lattice's own clean-room engine
 * (docs/visual-editor-spec.md). The Open Knowledge code the earlier editor was
 * built on was removed with its vendoring scripts and locks; this guard fails
 * if any of it comes back as a file or directory, or as a dependency of any
 * package in the repository, and it keeps every Lattice package on the
 * Apache-2.0 license that removal made possible. Imports are guarded by
 * `no-restricted-imports` in eslint.config.js.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const OPEN_KNOWLEDGE = /open[-_]?knowledge|@inkeep\//i;

/** Every path Git tracks or would add (untracked, not ignored). */
function repositoryPaths(): string[] {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" });
  return output.split("\0").filter(Boolean);
}

type Manifest = Partial<Record<"dependencies" | "devDependencies" | "optionalDependencies" | "peerDependencies", Record<string, string>>> & {
  license?: string;
};

describe("clean-room guard", () => {
  const paths = repositoryPaths();

  it("finds no Open Knowledge file or directory in the repository", () => {
    expect(paths.filter((path) => OPEN_KNOWLEDGE.test(path))).toEqual([]);
  });

  it("finds no Open Knowledge package among any manifest's dependencies", () => {
    const manifests = paths.filter((path) => path === "package.json" || path.endsWith("/package.json"));
    expect(manifests).toContain("package.json");
    const offenders = manifests.flatMap((path) => {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
      const names = [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies, manifest.peerDependencies]
        .flatMap((group) => Object.keys(group ?? {}));
      return names.filter((name) => OPEN_KNOWLEDGE.test(name)).map((name) => `${path}: ${name}`);
    });
    expect(offenders).toEqual([]);
  });

  it("finds every Lattice package that declares a license declaring Apache-2.0", () => {
    // Lattice left GPL-3.0 once the Open Knowledge code was gone; see NOTICE.
    const declared = paths
      .filter((path) => path === "package.json" || path.endsWith("/package.json"))
      .flatMap((path) => {
        const { license } = JSON.parse(readFileSync(path, "utf8")) as Manifest;
        return license === undefined ? [] : [`${path}: ${license}`];
      });
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((entry) => !entry.endsWith(": Apache-2.0"))).toEqual([]);
  });
});
