// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VitestPluginContext } from "vitest/node";
import { fsModuleCacheKey } from "./vitest-fs-cache-key.ts";

type KeyGenerator = Parameters<VitestPluginContext["experimental_defineCacheKeyGenerator"]>[0];

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "lattice-fs-cache-key-"));
  roots.push(root);
  write(root, files);
  return root;
}

function write(root: string, files: Record<string, string>) {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
}

/** The key a fresh Vitest process would seed `id` with, as Vitest calls it. */
function seed(root: string, id = join(root, "src/app.tsx")) {
  let generator: KeyGenerator | undefined;
  const plugin = fsModuleCacheKey(root);
  const configure = plugin.configureVitest as (context: Partial<VitestPluginContext>) => void;
  configure({ experimental_defineCacheKeyGenerator: (callback) => { generator = callback; } });
  return generator!({ id, sourceCode: "", environment: {} as never });
}

const installed = (version: string) => ({
  "pnpm-lock.yaml": `review-transform: ${version}\n`,
  "node_modules/.pnpm/lock.yaml": `review-transform: ${version}\n`,
});

describe("fs module cache key", () => {
  it("gives every dependency install its own key, however many installs follow one another", () => {
    // Vitest's lockfile check loses its record after one change, so it cannot
    // be what separates install B's transforms from install C's.
    const root = checkout({ "lingui.config.ts": "config", ...installed("A") });
    const keys = ["A", "B", "C"].map((version) => {
      write(root, installed(version));
      return seed(root);
    });
    expect(new Set(keys).size).toBe(3);
    write(root, installed("A"));
    expect(seed(root)).toBe(keys[0]);
  });

  it("follows the installed packages when the committed lockfile has moved ahead of them", () => {
    const root = checkout({ "lingui.config.ts": "config", ...installed("A") });
    const before = seed(root);
    write(root, { "pnpm-lock.yaml": "review-transform: B\n" });
    const pulled = seed(root);
    write(root, { "node_modules/.pnpm/lock.yaml": "review-transform: B\n" });
    expect(new Set([before, pulled, seed(root)]).size).toBe(3);
  });

  it("changes with the Lingui config the plugin and macro read", () => {
    const root = checkout({ "lingui.config.ts": "sourceLocale: en", ...installed("A") });
    const before = seed(root);
    write(root, { "lingui.config.ts": "sourceLocale: zh-CN" });
    expect(seed(root)).not.toBe(before);
  });

  it("does not let content moved between the inputs hash the same", () => {
    const a = checkout({ "lingui.config.ts": "x", "pnpm-lock.yaml": "" });
    const b = checkout({ "lingui.config.ts": "", "pnpm-lock.yaml": "x" });
    expect(seed(a)).not.toBe(seed(b));
  });

  it("keeps catalogs out of the cache, since one compiles over the source locale's strings", () => {
    const root = checkout({ "lingui.config.ts": "config", ...installed("A") });
    expect(seed(root, join(root, "src/locales/zh-CN/messages.po"))).toBe(false);
    expect(seed(root, `${join(root, "src/locales/en/messages.po")}?import`)).toBe(false);
    expect(seed(root, join(root, "src/locales/en/messages.ts"))).toEqual(expect.any(String));
    expect(seed(root, join(root, "src/report.pot.ts"))).toEqual(expect.any(String));
  });
});
