import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMachOBinaries, isMachO } from "./sign-presentation-runtime.mjs";

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe("presentation runtime signing", () => {
  it("detects thin and universal Mach-O files without following pnpm-style links", () => {
    const workspace = mkdtempSync(join(tmpdir(), "lattice-presentation-signing-"));
    workspaces.push(workspace);
    const packages = join(workspace, "node_modules/.pnpm/native");
    mkdirSync(packages, { recursive: true });
    const addon = join(packages, "addon.node");
    const executable = join(packages, "executable");
    const javascript = join(packages, "index.js");
    writeFileSync(addon, Buffer.from("cffaedfe00000000", "hex"));
    writeFileSync(executable, Buffer.from("cafebabe00000000", "hex"));
    writeFileSync(javascript, "export default true;\n");
    symlinkSync(addon, join(workspace, "node_modules/addon.node"));

    expect(isMachO(addon)).toBe(true);
    expect(isMachO(javascript)).toBe(false);
    expect(findMachOBinaries(workspace)).toEqual([addon, executable]);
  });

  it("ignores files shorter than a Mach-O header and missing roots", () => {
    const workspace = mkdtempSync(join(tmpdir(), "lattice-presentation-signing-"));
    workspaces.push(workspace);
    const shortFile = join(workspace, "short");
    writeFileSync(shortFile, Buffer.from([0xca, 0xfe]));

    expect(isMachO(shortFile)).toBe(false);
    expect(findMachOBinaries(join(workspace, "missing"))).toEqual([]);
  });
});
