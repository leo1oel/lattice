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

/**
 * A minimal 64-bit little-endian ELF file: one PT_LOAD over the whole file,
 * an optional PT_INTERP, and a PT_DYNAMIC naming `needed` through a string
 * table, the way a real executable or Node addon records what it links.
 */
function elf({ machine, interp, needed }: { machine: number; interp?: string; needed: string[] }) {
  const base = 0x400000;
  const segments = interp ? 3 : 2;
  const dataStart = 64 + 56 * segments;
  const strings = Buffer.concat([Buffer.from([0]), ...needed.map((name) => Buffer.from(`${name}\0`))]);
  const interpBytes = interp ? Buffer.from(`${interp}\0`) : Buffer.alloc(0);
  const dynamicStart = dataStart + strings.length + interpBytes.length;
  const dynamic = Buffer.alloc(16 * (needed.length + 2));
  let nameOffset = 1;
  needed.forEach((name, index) => {
    dynamic.writeBigInt64LE(1n, index * 16);
    dynamic.writeBigUInt64LE(BigInt(nameOffset), index * 16 + 8);
    nameOffset += name.length + 1;
  });
  dynamic.writeBigInt64LE(5n, needed.length * 16);
  dynamic.writeBigUInt64LE(BigInt(base + dataStart), needed.length * 16 + 8);
  const size = dynamicStart + dynamic.length;
  const header = Buffer.alloc(dataStart);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(header);
  header.writeUInt16LE(machine, 18);
  header.writeBigUInt64LE(64n, 32);
  header.writeUInt16LE(56, 54);
  header.writeUInt16LE(segments, 56);
  const segment = (index: number, type: number, offset: number, length: number) => {
    const at = 64 + index * 56;
    header.writeUInt32LE(type, at);
    header.writeBigUInt64LE(BigInt(offset), at + 8);
    header.writeBigUInt64LE(BigInt(base + offset), at + 16);
    header.writeBigUInt64LE(BigInt(length), at + 32);
  };
  segment(0, 1, 0, size);
  segment(1, 2, dynamicStart, dynamic.length);
  if (interp) segment(2, 3, dataStart + strings.length, interpBytes.length);
  return Buffer.concat([header, strings, interpBytes, dynamic]);
}
const X86_64_ELF = 0x3e;
const AARCH64_ELF = 0xb7;

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
      "ts-entry/package.json": JSON.stringify({ name: "ts-entry", exports: "./src/index.ts" }),
      "ts-entry/src/index.ts": "",
    });
    symlinkSync("../pkg/lib/index.js", join(modules, "pkg-bin"));
    mkdirSync(join(modules, ".bin"));
    symlinkSync("../pkg/lib/index.js", join(modules, ".bin/pkg"));

    pruneNodeModules(modules, { platform: "darwin-arm64", typeScriptSources: "remove" });

    const kept = ["pkg/lib/index.js", "pkg/docs/runtime.js", "pkg/LICENSE", "pkg/NOTICE.md", "pkg/node_modules/nested/index.js", "ts-entry/src/index.ts"];
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

  it("keeps only the glibc build for the Linux CPU, read from what each file links", () => {
    const modules = install({
      "native/package.json": "{}",
      "native/gnu-x64.node": elf({ machine: X86_64_ELF, needed: ["libgcc_s.so.1", "libc.so.6", "ld-linux-x86-64.so.2"] }),
      "native/gnu-arm64.node": elf({ machine: AARCH64_ELF, needed: ["libc.so.6"] }),
      "native/musl-x64.node": elf({ machine: X86_64_ELF, needed: ["libc.so"] }),
      "native/alpine-tool": elf({ machine: X86_64_ELF, interp: "/lib/ld-musl-x86_64.so.1", needed: ["libc.musl-x86_64.so.1"] }),
      // A glibc tool may name musl in its own text; only its links count.
      "native/gnu-tool": Buffer.concat([elf({ machine: X86_64_ELF, interp: "/lib64/ld-linux-x86-64.so.2", needed: ["libc.so.6"] }), Buffer.from("ld-musl-x86_64.so.1")]),
      "native/static-tool": elf({ machine: X86_64_ELF, needed: [] }),
    });
    const foreign = (file: string, platform: string) => isForeignBinary(join(modules, "native", file), platform);
    expect(foreign("gnu-x64.node", "linux-x64")).toBe(false);
    expect(foreign("gnu-arm64.node", "linux-x64")).toBe(true);
    expect(foreign("gnu-arm64.node", "linux-arm64")).toBe(false);
    expect(foreign("gnu-x64.node", "linux-arm64")).toBe(true);
    expect(foreign("musl-x64.node", "linux-x64")).toBe(true);
    expect(foreign("alpine-tool", "linux-x64")).toBe(true);
    expect(foreign("gnu-tool", "linux-x64")).toBe(false);
    expect(foreign("static-tool", "linux-x64")).toBe(false);
    expect(foreign("gnu-x64.node", "darwin-arm64")).toBe(true);
  });

  it("removes a Linux platform package whose manifest rules the target out, and only on Linux", () => {
    const packages = {
      "lightningcss-linux-x64-gnu/package.json": JSON.stringify({ name: "lightningcss-linux-x64-gnu", main: "lightningcss.node", os: ["linux"], cpu: ["x64"], libc: ["glibc"] }),
      "lightningcss-linux-x64-gnu/lightningcss.node": elf({ machine: X86_64_ELF, needed: ["libc.so.6"] }),
      "lightningcss-linux-x64-musl/package.json": JSON.stringify({ name: "lightningcss-linux-x64-musl", main: "lightningcss.node", os: ["linux"], cpu: ["x64"], libc: ["musl"] }),
      "lightningcss-linux-x64-musl/lightningcss.node": elf({ machine: X86_64_ELF, needed: ["libc.so"] }),
      "@rolldown/binding-linux-arm64-gnu/package.json": JSON.stringify({ name: "@rolldown/binding-linux-arm64-gnu", main: "binding.node", cpu: ["arm64"], libc: ["glibc"] }),
      "@rolldown/binding-linux-arm64-gnu/binding.node": elf({ machine: AARCH64_ELF, needed: ["libc.so.6"] }),
      "pure-js/package.json": JSON.stringify({ name: "pure-js", main: "index.js", cpu: ["!ia32"] }),
      "pure-js/index.js": "",
    };
    const linux = install(packages);
    pruneNodeModules(linux, { platform: "linux-x64", typeScriptSources: "remove" });
    expect(existsSync(join(linux, "lightningcss-linux-x64-gnu/lightningcss.node"))).toBe(true);
    expect(existsSync(join(linux, "lightningcss-linux-x64-musl"))).toBe(false);
    expect(existsSync(join(linux, "@rolldown/binding-linux-arm64-gnu"))).toBe(false);
    expect(existsSync(join(linux, "pure-js/index.js"))).toBe(true);

    const mac = install({ "fsevents/package.json": JSON.stringify({ name: "fsevents", main: "fsevents.js", os: ["darwin"], libc: ["musl"] }), "fsevents/fsevents.js": "" });
    pruneNodeModules(mac, { platform: "darwin-arm64", typeScriptSources: "remove" });
    expect(existsSync(join(mac, "fsevents/fsevents.js"))).toBe(true);
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
