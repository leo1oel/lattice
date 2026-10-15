import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isForeignBinary, pruneNodeModules } from "./runtime-prune.mjs";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function install(files: Record<string, string | Buffer>) {
  const workspace = mkdtempSync(join(tmpdir(), "lattice-runtime-prune-"));
  workspaces.push(workspace);
  const modules = join(workspace, "node_modules");
  for (const [file, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(modules, file)), { recursive: true });
    writeFileSync(join(modules, file), contents);
  }
  return modules;
}

const machO = (cpu: number) => {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpu, 4);
  return header;
};
const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);

describe("runtime pruning", () => {
  it("removes the listed categories and keeps runtime code, licenses, and named entry points", () => {
    const modules = install({
      "pkg/package.json": JSON.stringify({ name: "pkg", main: "lib/index.js", exports: { ".": { types: "./lib/index.d.ts", default: "./lib/index.js" }, "./docs": "./docs/runtime.js" } }),
      "pkg/lib/index.js": "",
      "pkg/lib/index.js.map": "",
      "pkg/lib/index.d.ts": "",
      "pkg/lib/util.ts": "",
      "pkg/lib/util.test.js": "",
      "pkg/docs/runtime.js": "",
      "pkg/README.md": "",
      "pkg/CHANGELOG.md": "",
      "pkg/LICENSE": "",
      "pkg/NOTICE.md": "",
      "pkg/test/fixture.js": "",
      "pkg/examples/demo.js": "",
      "pkg/node_modules/nested/package.json": JSON.stringify({ name: "nested" }),
      "pkg/node_modules/nested/index.js": "",
      "pkg/node_modules/nested/README.md": "",
      "pi/package.json": JSON.stringify({ name: "pi" }),
      "pi/index.js": "",
      "pi/README.md": "",
      "ts-entry/package.json": JSON.stringify({ name: "ts-entry", exports: "./src/index.ts" }),
      "ts-entry/src/index.ts": "",
    });
    symlinkSync("../pkg/lib/index.js", join(modules, "pkg-bin"));
    mkdirSync(join(modules, ".bin"));
    symlinkSync("../pkg/lib/index.js", join(modules, ".bin/pkg"));

    pruneNodeModules(modules, { platform: "darwin-arm64", typeScriptSources: "remove", keepDocsFor: ["pi"] });

    const kept = ["pkg/lib/index.js", "pkg/docs/runtime.js", "pkg/LICENSE", "pkg/NOTICE.md", "pkg/node_modules/nested/index.js", "pi/README.md", "ts-entry/src/index.ts"];
    const removed = ["pkg/lib/index.js.map", "pkg/lib/index.d.ts", "pkg/lib/util.ts", "pkg/lib/util.test.js", "pkg/README.md", "pkg/CHANGELOG.md", "pkg/test", "pkg/examples", "pkg/node_modules/nested/README.md", ".bin"];
    for (const file of kept) expect(existsSync(join(modules, file)), file).toBe(true);
    for (const file of removed) expect(existsSync(join(modules, file)), file).toBe(false);
  });

  it("keeps TypeScript sources for a runtime that compiles them", () => {
    const modules = install({ "core/package.json": "{}", "core/src/app.tsx": "", "core/src/app.test.tsx": "" });
    pruneNodeModules(modules, { platform: "darwin-arm64", typeScriptSources: "keep" });
    expect(existsSync(join(modules, "core/src/app.tsx"))).toBe(true);
    expect(existsSync(join(modules, "core/src/app.test.tsx"))).toBe(false);
  });

  it("removes only binaries the target can never load", () => {
    const modules = install({
      "native/package.json": "{}",
      "native/linux.node": ELF,
      "native/win.node": Buffer.from("MZ\x90\0\x03\0\0\0"),
      "native/x64.node": machO(X86_64),
      "native/arm64.node": machO(ARM64),
      "native/x64-tool": machO(X86_64),
      "native/MZ-notes.txt": "MZ is not a binary here",
    });
    const path = (file: string) => join(modules, "native", file);
    expect(isForeignBinary(path("linux.node"), "darwin-arm64")).toBe(true);
    expect(isForeignBinary(path("linux.node"), "linux-x64")).toBe(false);
    expect(isForeignBinary(path("win.node"), "darwin-arm64")).toBe(true);
    expect(isForeignBinary(path("x64.node"), "darwin-arm64")).toBe(true);
    expect(isForeignBinary(path("x64.node"), "darwin-x64")).toBe(false);
    expect(isForeignBinary(path("arm64.node"), "darwin-arm64")).toBe(false);
    // A thin x86_64 executable still runs under Rosetta.
    expect(isForeignBinary(path("x64-tool"), "darwin-arm64")).toBe(false);
    expect(isForeignBinary(path("MZ-notes.txt"), "darwin-arm64")).toBe(false);
  });

  it("turns esbuild's copied platform binary back into a launcher", () => {
    const binary = Buffer.concat([machO(ARM64), Buffer.alloc(1024)]);
    const modules = install({
      "esbuild/package.json": JSON.stringify({ name: "esbuild", main: "lib/main.js", bin: { esbuild: "bin/esbuild" } }),
      "esbuild/lib/main.js": "",
      "esbuild/bin/esbuild": binary,
      "@esbuild/darwin-arm64/package.json": "{}",
      "@esbuild/darwin-arm64/bin/esbuild": binary,
    });
    pruneNodeModules(modules, { platform: "darwin-arm64", typeScriptSources: "remove" });
    expect(readFileSync(join(modules, "esbuild/bin/esbuild"), "utf8")).toContain("../../@esbuild/darwin-arm64/bin/esbuild");
    expect(readFileSync(join(modules, "@esbuild/darwin-arm64/bin/esbuild")).equals(binary)).toBe(true);
  });
});
