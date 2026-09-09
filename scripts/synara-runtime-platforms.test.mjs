import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { pruneEsbuildPlatforms } from "./synara-runtime-platforms.mjs";

it.each(["darwin-arm64", "linux-x64"])("keeps only %s esbuild binaries in both dependency trees", (platform) => {
  const root = mkdtempSync(join(tmpdir(), "lattice-platform-prune-"));
  try {
    const scopes = ["node_modules/@esbuild", "node_modules/@earendil-works/pi-coding-agent/node_modules/@esbuild"];
    for (const scope of scopes) {
      for (const target of ["darwin-arm64", "linux-x64", "win32-x64"]) {
        const bin = join(root, scope, target, "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, "esbuild"), "binary");
      }
    }
    mkdirSync(join(root, "node_modules/esbuild"), { recursive: true });
    writeFileSync(join(root, "node_modules/esbuild/main.js"), "API");
    expect(pruneEsbuildPlatforms(root, platform)).toBe(24);
    for (const scope of scopes) {
      for (const target of ["darwin-arm64", "linux-x64", "win32-x64"]) {
        expect(existsSync(join(root, scope, target, "bin/esbuild"))).toBe(target === platform);
      }
    }
    expect(existsSync(join(root, "node_modules/esbuild/main.js"))).toBe(true);
    expect(pruneEsbuildPlatforms(root, platform)).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
