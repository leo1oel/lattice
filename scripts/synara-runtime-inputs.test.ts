import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SYNARA_RUNTIME_INPUTS } from "./synara-runtime-inputs.mjs";

const repo = path.resolve(__dirname, "..");
type Workflow = {
  on?: { push?: { paths?: string[] } };
  jobs: Record<string, { steps?: { id?: string; with?: { key?: string } }[] }>;
};
const workflow = (name: string) => parse(readFileSync(path.join(repo, ".github/workflows", name), "utf8")) as Workflow;

/** The file patterns a `hashFiles('a', 'b')` expression hashes, in order. */
function hashedPatterns(key: string): string[] {
  const call = /hashFiles\(([^)]*)\)/.exec(key);
  if (!call) throw new Error(`no hashFiles() in ${key}`);
  return call[1].split(",").map((argument) => argument.trim().replace(/^'|'$/g, ""));
}

/** GitHub's glob for these patterns: `*` stays within one path segment. */
const matches = (pattern: string, file: string) =>
  new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`).test(file);

/** Every input is covered, and every pattern still names an input. */
function expectSameSet(patterns: string[]) {
  for (const input of SYNARA_RUNTIME_INPUTS) expect(patterns.some((pattern) => matches(pattern, input)), input).toBe(true);
  for (const pattern of patterns) expect(SYNARA_RUNTIME_INPUTS.some((input) => matches(pattern, input)), pattern).toBe(true);
}

describe("the prepared Synara runtime cache", () => {
  it.each(["release.yml", "release-cache.yml"])("keys %s on every file the sidecar build key hashes", (name) => {
    const steps = Object.values(workflow(name).jobs).flatMap((job) => job.steps ?? []);
    const cache = steps.find((step) => step.id === "synara-runtime-cache");
    expect(cache?.with?.key).toBeDefined();
    expectSameSet(hashedPatterns(cache!.with!.key!));
  });

  it("is rebuilt on main whenever one of those files changes", () => {
    const paths = workflow("release-cache.yml").on?.push?.paths ?? [];
    for (const input of SYNARA_RUNTIME_INPUTS) expect(paths.some((pattern) => matches(pattern, input)), input).toBe(true);
  });
});
