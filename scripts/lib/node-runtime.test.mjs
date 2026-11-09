import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NODE_RELEASES, nodeRelease, prepareNodeRuntime } from "./node-runtime.mjs";
import { projectRoot, readJson } from "./util.mjs";

let scratch;
afterEach(() => { vi.unstubAllGlobals(); if (scratch) rmSync(scratch, { recursive: true, force: true }); });
describe("shared standalone Node archives", () => {
  it("keeps every platform's archive tied to the configured Node version", () => {
    const { nodeVersion } = readJson(join(projectRoot, "scripts/synara-runtime.json"));
    for (const target of Object.keys(NODE_RELEASES)) {
      expect(nodeRelease(target, nodeVersion).sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(nodeRelease("x86_64-pc-windows-msvc", nodeVersion).archive).toMatch(/-win-x64\.zip$/);
    expect(() => nodeRelease("x86_64-pc-windows-msvc", "0.0.0")).toThrow(/No verified Node/);
    expect(() => nodeRelease("unsupported", nodeVersion)).toThrow();
  });
  it("refuses an archive with the wrong digest before extraction", async () => {
    scratch = mkdtempSync(join(tmpdir(), "node-runtime-test-"));
    const { nodeVersion } = readJson(join(projectRoot, "scripts/synara-runtime.json"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not the pinned archive")));
    await expect(prepareNodeRuntime(join(scratch, "stage"), { cacheRoot: scratch, target: "x86_64-pc-windows-msvc", nodeVersion }))
      .rejects.toThrow(/SHA-256/);
  });
});
