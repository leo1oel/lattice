import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkWindowsPackage, releaseSource, windowsAssetNames } from "./lib/windows-package.mjs";
import { sha256, projectRoot } from "./lib/util.mjs";

const repository = "leo1oel/lattice";
const sha = "a".repeat(40);
const event = () => ({ repository: { full_name: repository }, workflow_run: {
  name: "Release", event: "push", conclusion: "success", head_branch: "v1.2.3", head_sha: sha,
  head_repository: { full_name: repository },
} });
let scratch;
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

describe("experimental Windows release publication", () => {
  it("accepts only the successful upstream tag release context", () => {
    expect(releaseSource(event(), repository)).toEqual({ tag: "v1.2.3", version: "1.2.3", sha });
    for (const patch of [{ conclusion: "failure" }, { event: "pull_request" }, { event: "workflow_dispatch" },
      { head_repository: { full_name: "someone/fork" } }, { head_branch: "main" },
      { head_branch: "v../../latest.json" }, { head_sha: "not-a-commit" }, { name: "Other workflow" }]) {
      const value = event(); Object.assign(value.workflow_run, patch);
      expect(() => releaseSource(value, repository)).toThrow();
    }
    expect(() => releaseSource(event(), "someone/fork")).toThrow();
    expect(() => releaseSource({}, repository)).toThrow();
  });

  it("rejects mismatched provenance and a modified installer before an upload", () => {
    scratch = mkdtempSync(join(tmpdir(), "windows-package-test-"));
    const names = windowsAssetNames("1.2.3");
    const bytes = Buffer.from("MZ test executable");
    const info = { version: "1.2.3", sourceCommit: sha, target: "x86_64-pc-windows-msvc", sha256: sha256(bytes),
      experimental: true, agentAvailable: false, autoUpdate: false, unsigned: true };
    writeFileSync(join(scratch, names.installer), bytes);
    writeFileSync(join(scratch, names.checksum), `${info.sha256}  ${names.installer}\n`);
    writeFileSync(join(scratch, names.metadata), JSON.stringify(info));
    writeFileSync(join(scratch, names.instructions), "unsigned build; SmartScreen may warn");
    expect(checkWindowsPackage(scratch, { version: "1.2.3", sha })).toEqual(names);
    expect(() => checkWindowsPackage(scratch, { version: "1.2.3", sha: "b".repeat(40) })).toThrow(/provenance/);
    writeFileSync(join(scratch, names.installer), "MZ modified installer");
    expect(() => checkWindowsPackage(scratch, { version: "1.2.3", sha })).toThrow(/checksum/);
    expect(() => windowsAssetNames("../../latest.json")).toThrow();
  });

  it("keeps the build read-only and publishes only its checked artifact in a separate job", () => {
    const workflow = parse(readFileSync(join(projectRoot, ".github/workflows/windows-installer.yml"), "utf8"));
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.jobs.attach.permissions).toEqual({ contents: "write" });
    expect(workflow.jobs.attach.needs).toBe("build");
    expect(workflow.on.pull_request_target).toBeUndefined();
    // Pull requests run no CI; this builds only for a release or by hand.
    expect(workflow.on.pull_request).toBeUndefined();
    const steps = workflow.jobs.build.steps;
    const check = steps.findIndex((step) => step.run?.includes("check-windows-install.ps1"));
    const upload = steps.findIndex((step) => step.id === "package");
    expect(check).toBeGreaterThan(0);
    expect(upload).toBeGreaterThan(check);
    expect(steps[upload].if).toBeUndefined(); // default success(), not always()
    expect(workflow.jobs.attach.steps[0].with.ref).toBe("${{ github.workflow_sha }}");
    expect(workflow.jobs.attach.steps.find((step) => step.uses?.startsWith("actions/download-artifact")).with["artifact-ids"])
      .toBe("${{ needs.build.outputs.artifact-id }}");
  });
});
