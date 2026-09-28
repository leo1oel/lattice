import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    const kept = [
      "@open-slide/core/src/app.tsx",
      "@open-slide/core/LICENSE",
      "some-package/src/runtime.ts",
      "some-package/dist/index.js",
      "some-package/LICENSE.md",
      "emoji-picker-react/dist/data/emojis-fr.js",
      "emoji-picker-react/dist/data/emojis-uncompiled.ts",
    ];
    const removed = [
      "some-package/dist/index.js.map",
      "some-package/dist/index.d.ts",
      "some-package/dist/types.d.mts",
      "emoji-picker-react/dist/data/emojis-fr.json",
      "emoji-picker-react/dist/data/emojis-fr.ts",
      ...removablePackageDirectories.map(
        (directory) => `${directory}/fixture.js`,
      ),
    ];
    for (const file of [...kept, ...removed]) {
      mkdirSync(join(modules, file, ".."), { recursive: true });
      writeFileSync(join(modules, file), "fixture\n");
    }

    prunePresentationRuntime(workspace);

    for (const file of kept) expect(existsSync(join(modules, file))).toBe(true);
    for (const file of removed) expect(existsSync(join(modules, file))).toBe(false);
  });
});
