import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runWorkflow, type Value, type Workflow } from "./lib/workflow-conditions";

// The Intel Mac build may only ever add to a release the Apple silicon
// workflow already published (docs/release-process.md, "macos-intel.yml"),
// and only a tag's release bakes in the release's keys and fonts.
const repo = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(repo, file), "utf8");
const intel = parse(read(".github/workflows/macos-intel.yml")) as Workflow & {
  jobs: Record<string, { "runs-on"?: string; outputs?: Record<string, string> }>;
};
const release = parse(read(".github/workflows/release.yml")) as Workflow & {
  jobs: Record<string, { steps?: { uses?: string; with?: Record<string, string> }[] }>;
};

const SECRETS = {
  LATTICE_FIRECRAWL_KEY: "firecrawl-secret",
  VITE_TLDRAW_LICENSE_KEY: "tldraw-secret",
  LATTICE_FONTS_DEPLOY_KEY: "fonts-secret",
  TAURI_SIGNING_PRIVATE_KEY: "updater-secret",
  APPLE_CERTIFICATE: "certificate-secret",
};
const runFor = (github: Record<string, Value>) => runWorkflow(intel, github, SECRETS);

const releaseRun = (workflowRun: Record<string, Value>) => ({
  event_name: "workflow_run",
  event: { workflow_run: { name: release.name, event: "push", head_branch: "v0.15.9", conclusion: "success", ...workflowRun } },
});

const BUILD = "Build and sign the Intel app";

describe("the macOS Intel workflow", () => {
  it("starts from the Release workflow's runs, which does not wait on or call it", () => {
    expect(intel.on.workflow_run).toEqual({ workflows: [release.name], types: ["completed"] });
    expect(Object.keys(release.on)).not.toContain("workflow_run");
    expect(Object.keys(release.on)).not.toContain("workflow_call");
    // release.yml still builds only Apple silicon, so its tauri-action writes darwin-aarch64 alone.
    const tauriActions = Object.values(release.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => step.uses?.startsWith("tauri-apps/tauri-action"));
    expect(tauriActions.map((step) => step.with?.args)).toEqual(["--target aarch64-apple-darwin"]);
  });

  it("builds and smokes on Intel runners", () => {
    expect(intel.jobs.build["runs-on"]).toMatch(/intel/);
    expect(intel.jobs.smoke["runs-on"]).toMatch(/intel/);
    expect(intel.env?.TARGET).toBe("x86_64-apple-darwin");
  });

  it("builds, smokes and attaches, with the release's secrets, for a published tag release", () => {
    const run = runFor(releaseRun({}));
    expect(run.jobs).toEqual(["build", "smoke", "attach"]);
    expect(run.step("build", "Check the release's version").runs).toBe(true);
    expect(run.step("build", "Fetch the licensed interface fonts").runs).toBe(true);
    expect(run.step("build", BUILD).env).toMatchObject({
      LATTICE_FIRECRAWL_KEY: SECRETS.LATTICE_FIRECRAWL_KEY,
      VITE_TLDRAW_LICENSE_KEY: SECRETS.VITE_TLDRAW_LICENSE_KEY,
      TAURI_SIGNING_PRIVATE_KEY: SECRETS.TAURI_SIGNING_PRIVATE_KEY,
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
  ])("checks %s without the release's keys and fonts, and publishes nothing", (_, github) => {
    const run = runFor(github);
    expect(run.jobs).not.toContain("attach");
    expect(run.jobs).toContain("smoke");
    expect(run.step("build", "Fetch the licensed interface fonts").runs).toBe(false);
    expect(run.step("build", BUILD).env).toMatchObject({
      LATTICE_FIRECRAWL_KEY: "",
      VITE_TLDRAW_LICENSE_KEY: "",
      TAURI_SIGNING_PRIVATE_KEY: "",
    });
  });

  it("gives only attach, which every check gates, the right to write", () => {
    expect(intel.permissions).toEqual({ contents: "read" });
    const writers = Object.entries(intel.jobs).filter(([, job]) => job.permissions?.contents === "write").map(([name]) => name);
    expect(writers).toEqual(["attach"]);
    expect(intel.jobs.attach.needs).toEqual(["build", "smoke"]);
  });

  it("never runs tauri-action or builds Lattice Beta", () => {
    const actions = Object.values(intel.jobs).flatMap((job) => job.steps ?? []).map((step) => step.uses ?? "");
    expect(actions.filter((uses) => uses.startsWith("tauri-apps/tauri-action"))).toEqual([]);
    // Lattice Beta is LATTICE_FLAVOR=beta (build.rs) over tauri.beta.conf.json.
    const envs = [intel.env, ...Object.values(intel.jobs).flatMap((job) => [job.env, ...(job.steps ?? []).map((step) => step.env)])];
    expect(envs.flatMap((env) => Object.keys(env ?? {}))).not.toContain("LATTICE_FLAVOR");
  });
});

// A release's Intel run whose first attempt fails is re-run once, including
// one GitHub failed without creating smoke and attach (v0.16.4).
describe("the macOS Intel retry workflow", () => {
  const retry = parse(read(".github/workflows/macos-intel-retry.yml")) as Workflow;
  const intelRun = (workflowRun: Record<string, Value>) => ({
    event_name: "workflow_run",
    event: { workflow_run: { name: intel.name, event: "workflow_run", conclusion: "failure", run_attempt: 1, ...workflowRun } },
  });

  it("follows the macOS Intel workflow and may re-run it, nothing more", () => {
    expect(retry.on.workflow_run).toEqual({ workflows: [intel.name], types: ["completed"] });
    expect(retry.permissions).toEqual({ actions: "write" });
  });

  it("re-runs a release's failed first attempt", () => {
    expect(runWorkflow(retry, intelRun({}), {}).jobs).toEqual(["rerun"]);
  });

  it.each([
    ["a passing attempt", { conclusion: "success" }],
    ["the skipped run after a failed Release", { conclusion: "skipped" }],
    ["a second attempt, whose failure is real", { run_attempt: 2 }],
    ["a pull request's run", { event: "pull_request" }],
    ["a run by hand", { event: "workflow_dispatch" }],
  ])("leaves %s alone", (_, workflowRun) => {
    expect(runWorkflow(retry, intelRun(workflowRun), {}).jobs).toEqual([]);
  });
});
