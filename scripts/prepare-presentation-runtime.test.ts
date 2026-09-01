import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import {
  prunePresentationRuntime,
  removablePackageDirectories,
} from "./prepare-presentation-runtime.mjs";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0))
    rmSync(workspace, { recursive: true, force: true });
});

describe("presentation runtime pruning", () => {
  it("removes only audited package trees and non-runtime build metadata", () => {
    const workspace = mkdtempSync(
      join(tmpdir(), "lattice-presentation-prune-"),
    );
    workspaces.push(workspace);
    const modules = join(workspace, "node_modules");
    const files = [
      "@open-slide/core/src/app.tsx",
      "@open-slide/core/LICENSE",
      "some-package/src/runtime.ts",
      "some-package/dist/index.js",
      "some-package/dist/index.js.map",
      "some-package/dist/index.d.ts",
      "some-package/dist/types.d.mts",
      "some-package/LICENSE.md",
      ...removablePackageDirectories.map(
        (directory) => `${directory}/fixture.js`,
      ),
    ];
    for (const file of files) {
      mkdirSync(join(modules, file, ".."), { recursive: true });
      writeFileSync(join(modules, file), "fixture\n");
    }

    prunePresentationRuntime(workspace);

    for (const file of [
      "@open-slide/core/src/app.tsx",
      "@open-slide/core/LICENSE",
      "some-package/src/runtime.ts",
      "some-package/dist/index.js",
      "some-package/LICENSE.md",
    ])
      expect(existsSync(join(modules, file))).toBe(true);
    for (const file of [
      "some-package/dist/index.js.map",
      "some-package/dist/index.d.ts",
      "some-package/dist/types.d.mts",
      ...removablePackageDirectories.map(
        (directory) => `${directory}/fixture.js`,
      ),
    ])
      expect(existsSync(join(modules, file))).toBe(false);
  });
});
