import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runWorkflow, type Value, type Workflow } from "./lib/workflow-conditions";

// The Linux AppImage may only ever add to a release the Mac workflow already
// published (docs/release-process.md, "linux-appimage.yml").
const repo = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(repo, file), "utf8");
const linux = parse(read(".github/workflows/linux-appimage.yml")) as Workflow;
const release = parse(read(".github/workflows/release.yml")) as Workflow;

const SECRETS = { LATTICE_FIRECRAWL_KEY: "firecrawl-secret", VITE_TLDRAW_LICENSE_KEY: "tldraw-secret", LATTICE_FONTS_DEPLOY_KEY: "fonts-secret" };

const runFor = (github: Record<string, Value>) => runWorkflow(linux, github, SECRETS);

/** The `github` context of a completed Release run for a tag push, with `workflowRun` changed. */
const releaseRun = (workflowRun: Record<string, Value>) => ({
  event_name: "workflow_run",
  event: { workflow_run: { name: release.name, event: "push", head_branch: "v0.15.8", conclusion: "success", ...workflowRun } },
});

/** The Tauri CLI's arguments in a `pnpm tauri build` step, read as the shell would split them. */
function tauriBuildArguments(run: string) {
  const words = [...run.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
  expect(words.slice(0, 3)).toEqual(["pnpm", "tauri", "build"]);
  return words.slice(3);
}

describe("the Linux AppImage workflow", () => {
  it("starts from the Release workflow's runs, which does not wait on or call it", () => {
    expect(linux.on.workflow_run).toEqual({ workflows: [release.name], types: ["completed"] });
    expect(Object.keys(release.on)).not.toContain("workflow_run");
    expect(Object.keys(release.on)).not.toContain("workflow_call");
    expect(Object.values(release.jobs).filter((job) => "uses" in job)).toEqual([]);
  });

  it("builds, checks and attaches, with the release's secrets, for a published tag release", () => {
    const run = runFor(releaseRun({}));
    expect(run.jobs).toEqual(["build", "smoke", "e2e", "attach"]);
    expect(run.step("build", "Fetch the licensed interface fonts").runs).toBe(true);
    expect(run.step("build", "Build the AppImage").env).toMatchObject({
      LATTICE_FIRECRAWL_KEY: SECRETS.LATTICE_FIRECRAWL_KEY,
      VITE_TLDRAW_LICENSE_KEY: SECRETS.VITE_TLDRAW_LICENSE_KEY,
    });
  });

  it.each([
    ["a failed Release run", releaseRun({ conclusion: "failure" })],
    ["a cancelled Release run", releaseRun({ conclusion: "cancelled" })],
  ])("does nothing after %s, which published nothing", (_, github) => {
    expect(runFor(github).jobs).toEqual([]);
  });

  it.each([
    ["a pull request", { event_name: "pull_request" }],
    ["a run by hand", { event_name: "workflow_dispatch" }],
    ["a Release run that no tag push started", releaseRun({ event: "workflow_dispatch", head_branch: "main" })],
  ])("checks %s without its secrets, and publishes nothing", (_, github) => {
    const run = runFor(github);
    expect(run.jobs).not.toContain("attach");
    expect(run.step("build", "Fetch the licensed interface fonts").runs).toBe(false);
    expect(run.step("build", "Build the AppImage").env).toMatchObject({ LATTICE_FIRECRAWL_KEY: "", VITE_TLDRAW_LICENSE_KEY: "" });
  });

  it("checks a pull request's AppImage on every job but attach", () => {
    expect(runFor({ event_name: "pull_request" }).jobs).toEqual(["build", "smoke", "e2e"]);
  });

  it("gives only attach, which every check gates, the right to write", () => {
    expect(linux.permissions).toEqual({ contents: "read" });
    const writers = Object.entries(linux.jobs).filter(([, job]) => job.permissions?.contents === "write").map(([name]) => name);
    expect(writers).toEqual(["attach"]);
    expect(linux.jobs.attach.steps?.map((step) => step.uses).filter(Boolean)).toEqual(["actions/download-artifact@v8"]);
  });

  it("builds release Lattice's AppImage with no updater artifacts, so there is nothing unsigned to publish", () => {
    const build = linux.jobs.build.steps?.find((step) => step.name === "Build the AppImage");
    const args = tauriBuildArguments(build?.run ?? "");
    const option = (name: string) => args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []));
    expect(option("--bundles")).toEqual(["appimage"]);
    const overrides = option("--config").map((config) => JSON.parse(config) as { bundle?: { createUpdaterArtifacts?: boolean } });
    const shipped = JSON.parse(read("src-tauri/tauri.conf.json")) as { bundle: { createUpdaterArtifacts: boolean } };
    expect(shipped.bundle.createUpdaterArtifacts).toBe(true);
    expect(overrides.reduce((on, override) => override.bundle?.createUpdaterArtifacts ?? on, shipped.bundle.createUpdaterArtifacts)).toBe(false);
    // tauri-action is what writes latest.json and uploads updater archives.
    const actions = Object.values(linux.jobs).flatMap((job) => job.steps ?? []).map((step) => step.uses ?? "");
    expect(actions.filter((uses) => uses.startsWith("tauri-apps/tauri-action"))).toEqual([]);
    // Lattice Beta is LATTICE_FLAVOR=beta (build.rs) over tauri.beta.conf.json.
    const envs = [linux.env, ...Object.values(linux.jobs).flatMap((job) => [job.env, ...(job.steps ?? []).map((step) => step.env)])];
    expect(envs.flatMap((env) => Object.keys(env ?? {}))).not.toContain("LATTICE_FLAVOR");
  });
});
