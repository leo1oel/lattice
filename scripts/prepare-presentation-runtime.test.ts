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

function runtime(): string {
  const workspace = mkdtempSync(join(tmpdir(), "lattice-presentation-prune-"));
  workspaces.push(workspace);
  return workspace;
}

function write(root: string, file: string, content = "fixture\n") {
  mkdirSync(join(root, file, ".."), { recursive: true });
  writeFileSync(join(root, file), content);
}

/** A package manifest at `directory` (relative to `root`). */
function manifest(root: string, directory: string, fields: Record<string, unknown>) {
  write(root, join(directory, "package.json"), JSON.stringify(fields));
}

describe("presentation runtime pruning", () => {
  it("removes only audited package trees and non-runtime build metadata", () => {
    const workspace = runtime();
    const modules = join(workspace, "node_modules");
    const packages = ["@open-slide/core", "some-package", "emoji-picker-react", "@base-ui/react", "react-router", "react-dom"];
    manifest(workspace, "", { dependencies: Object.fromEntries(packages.map((name) => [name, "1.0.0"])) });
    for (const name of packages) manifest(workspace, `node_modules/${name}`, { name });
    const kept = [
      "@open-slide/core/src/app.tsx",
      "@open-slide/core/LICENSE",
      "some-package/src/runtime.ts",
      "some-package/dist/index.js",
      "some-package/LICENSE.md",
      "emoji-picker-react/dist/data/emojis-fr.js",
      "emoji-picker-react/dist/data/emojis-uncompiled.ts",
      "@base-ui/react/button/index.mjs",
      "react-router/dist/development/index.mjs",
      "react-dom/server.browser.js",
      "react-dom/cjs/react-dom-server.browser.development.js",
      "react-dom/cjs/react-dom-server-legacy.browser.production.js",
    ];
    const removed = [
      "some-package/dist/index.js.map",
      "some-package/dist/index.d.ts",
      "some-package/dist/types.d.mts",
      "emoji-picker-react/dist/data/emojis-fr.json",
      "emoji-picker-react/dist/data/emojis-fr.ts",
      "@base-ui/react/button/index.js",
      "react-router/dist/production/index.mjs",
      "react-dom/server.node.js",
      "react-dom/static.edge.js",
      "react-dom/cjs/react-dom-server.bun.production.js",
      "react-dom/cjs/react-dom-server-legacy.node.development.js",
      ...removablePackageDirectories.map(
        (directory) => `${directory}/fixture.js`,
      ),
    ];
    for (const file of [...kept, ...removed]) write(modules, file);

    prunePresentationRuntime(workspace);

    for (const file of kept) expect(existsSync(join(modules, file))).toBe(true);
    for (const file of removed) expect(existsSync(join(modules, file))).toBe(false);
  });

  it("keeps only the packages the runtime's dependencies reach", () => {
    const workspace = runtime();
    const modules = join(workspace, "node_modules");
    manifest(workspace, "", {
      dependencies: { "@open-slide/core": "2.0.0", vite: "8.0.0" },
      devDependencies: { esbuild: "0.28.0" },
    });
    manifest(workspace, "node_modules/@open-slide/core", {
      name: "@open-slide/core",
      dependencies: { shadcn: "4.0.0", "@tailwindcss/node": "4.0.0", picomatch: "4.0.0" },
    });
    manifest(workspace, "node_modules/vite", {
      name: "vite",
      dependencies: { lightningcss: "1.33.0", rolldown: "1.0.0" },
      optionalDependencies: { fsevents: "2.0.0" },
      peerDependencies: { esbuild: "*" },
      peerDependenciesMeta: { esbuild: { optional: true } },
    });
    manifest(workspace, "node_modules/vite/node_modules/lightningcss", { name: "lightningcss" });
    manifest(workspace, "node_modules/rolldown", {
      name: "rolldown",
      // Only this host's binding is installed.
      optionalDependencies: { "@rolldown/binding-darwin-arm64": "1.0.0", "@rolldown/binding-linux-x64-gnu": "1.0.0" },
    });
    manifest(workspace, "node_modules/@rolldown/binding-darwin-arm64", { name: "@rolldown/binding-darwin-arm64" });
    manifest(workspace, "node_modules/fsevents", { name: "fsevents" });
    manifest(workspace, "node_modules/@tailwindcss/node", {
      name: "@tailwindcss/node",
      dependencies: { lightningcss: "1.32.0" },
    });
    manifest(workspace, "node_modules/lightningcss", { name: "lightningcss" });
    // A nested copy shadows the hoisted one for its dependent only.
    manifest(workspace, "node_modules/@open-slide/core/node_modules/picomatch", { name: "picomatch" });
    manifest(workspace, "node_modules/picomatch", { name: "picomatch" });
    manifest(workspace, "node_modules/shadcn", { name: "shadcn", dependencies: { "ts-morph": "1.0.0" } });
    write(modules, "shadcn/LICENSE.md");
    write(modules, "shadcn/dist/tailwind.css");
    write(modules, "shadcn/dist/index.js");
    write(modules, "shadcn/dist/registry/index.js");
    manifest(workspace, "node_modules/shadcn/node_modules/commander", { name: "commander" });
    manifest(workspace, "node_modules/ts-morph", { name: "ts-morph" });
    manifest(workspace, "node_modules/esbuild", { name: "esbuild" });
    write(modules, ".bin/vite");

    prunePresentationRuntime(workspace);

    const exists = (path: string) => existsSync(join(modules, path));
    for (const path of [
      "@open-slide/core/package.json",
      "@open-slide/core/node_modules/picomatch/package.json",
      "vite/package.json",
      "rolldown/package.json",
      "@rolldown/binding-darwin-arm64/package.json",
      "fsevents/package.json",
      "@tailwindcss/node/package.json",
      "lightningcss/package.json",
      "shadcn/package.json",
      "shadcn/LICENSE.md",
      "shadcn/dist/tailwind.css",
    ]) expect(exists(path), path).toBe(true);
    for (const path of [
      "picomatch",
      "vite/node_modules/lightningcss",
      "shadcn/dist/index.js",
      "shadcn/dist/registry",
      "shadcn/node_modules",
      "ts-morph",
      "esbuild",
      ".bin",
    ]) expect(exists(path), path).toBe(false);
  });
});
