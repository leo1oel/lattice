import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The Linux AppImage may only ever add to a release the Mac workflow already
// published (docs/release-process.md, "linux-appimage.yml"). These pin the
// wiring that keeps it so, since no pull request can run the tag-time path.
const repo = path.resolve(__dirname, "..");
const source = (name: string) => readFileSync(path.join(repo, ".github/workflows", name), "utf8");
type Job = { needs?: string[]; if?: string; permissions?: Record<string, string>; steps?: { name?: string; run?: string }[]; strategy?: { matrix?: { image?: string[] } } };
type Workflow = { name: string; on: Record<string, { workflows?: string[]; types?: string[] } | null>; permissions: Record<string, string>; jobs: Record<string, Job> };
const linux = parse(source("linux-appimage.yml")) as Workflow;
const release = parse(source("release.yml")) as Workflow;

describe("the Linux AppImage workflow", () => {
  it("starts only after the Release workflow, which knows nothing of it", () => {
    expect(linux.on.workflow_run).toEqual({ workflows: [release.name], types: ["completed"] });
    expect(linux.jobs.build.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(source("release.yml")).not.toMatch(/linux|appimage/i);
  });

  it("attaches only after every check, and is the only job that can write", () => {
    expect(linux.permissions).toEqual({ contents: "read" });
    expect(linux.jobs.attach.needs).toEqual(["build", "smoke", "e2e"]);
    expect(linux.jobs.attach.if).toContain("github.event_name == 'workflow_run'");
    const writers = Object.entries(linux.jobs).filter(([, job]) => job.permissions?.contents === "write").map(([name]) => name);
    expect(writers).toEqual(["attach"]);
  });

  it("makes no updater artifacts, so there is nothing unsigned to publish", () => {
    const build = linux.jobs.build.steps?.find((step) => step.name === "Build the AppImage");
    expect(build?.run).toContain(`--config '{"bundle":{"createUpdaterArtifacts":false}}'`);
    expect(source("linux-appimage.yml")).not.toContain("uploadUpdaterJson");
  });

  it("smokes the AppImage from the oldest supported glibc up", () => {
    expect(linux.jobs.smoke.strategy?.matrix?.image).toEqual(["ubuntu:22.04", "ubuntu:24.04", "fedora:41"]);
  });
});
