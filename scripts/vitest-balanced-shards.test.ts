// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TestSpecification } from "vitest/node";
import { BalancedShardSequencer } from "./vitest-balanced-shards.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Test files of the given sizes in a fresh checkout, as Vitest hands them to `shard`. */
function suite(files: Record<string, string>): { root: string; specs: TestSpecification[] } {
  const root = mkdtempSync(join(tmpdir(), "lattice-balanced-shards-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return { root, specs: Object.keys(files).map((file) => ({ moduleId: join(root, file) }) as TestSpecification) };
}

async function shards(root: string, specs: TestSpecification[], count: number): Promise<string[][]> {
  const split: string[][] = [];
  for (let index = 1; index <= count; index += 1) {
    const sequencer = new BalancedShardSequencer({ config: { root, shard: { index, count } } } as never);
    split.push((await sequencer.shard(specs)).map((spec) => spec.moduleId.slice(root.length + 1)).sort());
  }
  return split;
}

describe("BalancedShardSequencer", () => {
  const files = {
    "src/app/app-big.test.tsx": `import "./app-test-utils";${"x".repeat(30_000)}`,
    "src/app/app-small.test.tsx": `import "./app-test-utils";${"x".repeat(10_000)}`,
    "src/editor/large.test.ts": "x".repeat(40_000),
    ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`src/unit/u${index}.test.ts`, "x".repeat(1_000 * (index + 1))])),
  };

  it("puts every file in exactly one shard", async () => {
    const { root, specs } = suite(files);
    const split = await shards(root, specs, 3);
    expect(split.flat().sort()).toEqual(Object.keys(files).sort());
  });

  it("splits the same way whatever order the files arrive in", async () => {
    const { root, specs } = suite(files);
    expect(await shards(root, [...specs].reverse(), 3)).toEqual(await shards(root, specs, 3));
  });

  it("weighs a suite that mounts the app above a plain file of the same size", async () => {
    const { root, specs } = suite(files);
    const split = await shards(root, specs, 3);
    // At 30 kB the App suite counts as 90 kB, about a third of the whole, so
    // it fills a shard alone; weighed by size only, it would share one.
    expect(split.find((shard) => shard.includes("src/app/app-big.test.tsx"))).toEqual(["src/app/app-big.test.tsx"]);
  });
});
