import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DEFAULT_FEED, EXECUTABLE, IDENTIFIER, PRODUCT, infoPlist, updaterManifest } from "./gpui-bundle.mjs";

// The GPUI package must never reach the Tauri app's users: it installs under
// its own identity, its updater feed is not the Tauri feed, and the workflow
// that signs it runs only by hand and publishes nothing.
const repo = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(repo, file), "utf8");
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
const workflow = parse(read(".github/workflows/gpui-package.yml")) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, { steps: Step[] }>;
};

describe("the GPUI bundle", () => {
  it("installs beside Lattice.app under its own identity, with the Tauri bundle's keys", () => {
    const plist = infoPlist({ version: tauri.version, minimumSystemVersion: "14.0", extra: { NSMicrophoneUsageDescription: "mic" } });
    expect(IDENTIFIER).not.toBe(tauri.identifier);
    expect(PRODUCT).not.toBe(tauri.productName);
    expect(plist).toMatchObject({
      CFBundleIdentifier: IDENTIFIER,
      CFBundleExecutable: EXECUTABLE,
      CFBundleShortVersionString: tauri.version,
      LSMinimumSystemVersion: "14.0",
      NSMicrophoneUsageDescription: "mic",
    });
  });

  it("writes a manifest the GPUI updater reads, on a feed apart from the Tauri app's", () => {
    const manifest = updaterManifest({ version: "1.2.3", signature: "sig", url: `${DEFAULT_FEED}/a.app.tar.gz`, pubDate: "2026-01-01T00:00:00Z" });
    expect(manifest.platforms["darwin-aarch64"]).toEqual({ signature: "sig", url: `${DEFAULT_FEED}/a.app.tar.gz` });
    for (const endpoint of tauri.plugins.updater.endpoints) expect(endpoint.startsWith(DEFAULT_FEED)).toBe(false);
    expect(read("gpui/crates/lattice-gpui/src/updater.rs")).toContain(`"${DEFAULT_FEED}/latest.json"`);
  });
});

describe("the GPUI package workflow", () => {
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const scripts = steps.map((step) => step.run ?? "").join("\n");

  it("runs only by hand, with read-only access", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("publishes nothing: no release, tag or upload, only the run's artifact", () => {
    expect(scripts).not.toMatch(/gh release|git push|git tag/);
    expect(steps.some((step) => step.uses?.startsWith("tauri-apps/"))).toBe(false);
    expect(steps.some((step) => step.uses?.startsWith("actions/upload-artifact"))).toBe(true);
    expect(steps.some((step) => step.uses?.startsWith("actions/cache/save") || step.with?.["save-if"] === true)).toBe(false);
  });
});
