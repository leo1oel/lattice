import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vitest/node";

/**
 * Splits `vitest run --shard=k/n` by estimated cost instead of by count.
 *
 * CI runs the suite as three shards and waits for the slowest. Vitest's own
 * split sorts files by a hash of their path and cuts equal-count slices, which
 * ignores how long a file takes: the App integration suites (the files that
 * import `src/app/app-test-utils.tsx` and mount the whole app) are a handful
 * of files but over half of the suite's test time, and the hash put most of
 * them on one shard.
 *
 * Here every file is weighed by its size, an App suite four times over (each
 * of its tests mounts the app), plus a floor for the environment and setup
 * every file pays, and the files are dealt heaviest first to the lightest
 * shard. Replayed on three CI runs' per-file timings, the slowest shard's work
 * drops from 322–333 s to 255–269 s, within 9 s of an exact split. Size is
 * only a proxy, but it moves with the suites without a timing file to
 * regenerate.
 *
 * Every shard computes the whole split and keeps its own part, so the split
 * must depend on nothing but the file list and contents: ties fall back to
 * the path.
 */
export class BalancedShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { config } = this.ctx;
    const { index, count } = config.shard!;
    const weighed = files
      .map((spec) => ({ spec, path: relative(config.root, spec.moduleId), weight: weightOf(spec.moduleId) }))
      .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const loads = Array.from({ length: count }, () => 0);
    const mine: TestSpecification[] = [];
    for (const { spec, weight } of weighed) {
      const lightest = loads.indexOf(Math.min(...loads));
      loads[lightest] += weight;
      if (lightest === index - 1) mine.push(spec);
    }
    return mine;
  }
}

/** A file's estimated cost, in weighted bytes of source. */
function weightOf(file: string): number {
  const source = readFileSync(file, "utf8");
  return 5_000 + source.length * (source.includes("app-test-utils") ? 4 : 1);
}
