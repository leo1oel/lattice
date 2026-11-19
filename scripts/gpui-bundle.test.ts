import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EXECUTABLE, FLAVORS, infoPlist, updaterManifest } from "./gpui-bundle.mjs";

// The GPUI package ships two ways. Lattice Beta never reaches the Tauri app's
// users: it installs under its own identity and its feed is not the Tauri
// feed. Lattice takes the Tauri app's identity so the Tauri updater installs
// it in place, and only release.yml publishes it, on the Tauri app's feed.
const repo = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(repo, file), "utf8");
const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = { steps?: Step[]; uses?: string; needs?: string[] | string; if?: string; with?: Record<string, unknown> };
const workflow = (file: string) => parse(read(file)) as {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
};
const flavor = read("gpui/crates/lattice-gpui/src/flavor.rs");

describe("the GPUI bundle", () => {
  it("installs Lattice Beta beside Lattice.app under its own identity, with the Tauri bundle's keys", () => {
    const plist = infoPlist({ flavor: FLAVORS.beta, version: tauri.version, minimumSystemVersion: "14.0", extra: { NSMicrophoneUsageDescription: "mic" } });
    expect(FLAVORS.beta.identifier).not.toBe(tauri.identifier);
    expect(FLAVORS.beta.product).not.toBe(tauri.productName);
    expect(plist).toMatchObject({
      CFBundleIdentifier: FLAVORS.beta.identifier,
      CFBundleExecutable: EXECUTABLE,
      CFBundleShortVersionString: tauri.version,
      LSMinimumSystemVersion: "14.0",
      NSMicrophoneUsageDescription: "mic",
    });
  });

  it("makes Lattice under the Tauri app's name and identifier, with tauri-action's file names", () => {
    expect(infoPlist({ flavor: FLAVORS.main, version: "1.2.3", minimumSystemVersion: "14.0", extra: {} })).toMatchObject({
      CFBundleIdentifier: tauri.identifier,
      CFBundleName: tauri.productName,
      CFBundleDisplayName: tauri.productName,
    });
    expect(FLAVORS.main.artifact).toBe(tauri.productName);
    expect(FLAVORS.main.feed("1.2.3")).toBe("https://github.com/leo1oel/lattice/releases/download/v1.2.3");
  });

  it("names each flavor as the GPUI app names itself", () => {
    for (const { product } of Object.values(FLAVORS)) expect(flavor).toContain(`name: "${product}"`);
    expect(flavor).toContain(`lattice_settings::import::TAURI_BUNDLE_ID`);
    expect(read("gpui/crates/lattice-settings/src/import.rs")).toContain(`"${FLAVORS.main.identifier}"`);
  });

  it("writes Lattice Beta's manifest for a feed apart from the Tauri app's", () => {
    const feed = FLAVORS.beta.feed();
    const manifest = updaterManifest({ version: "1.2.3", signature: "sig", url: `${feed}/a.app.tar.gz`, pubDate: "2026-01-01T00:00:00Z" });
    expect(manifest.platforms["darwin-aarch64"]).toEqual({ signature: "sig", url: `${feed}/a.app.tar.gz` });
    for (const endpoint of tauri.plugins.updater.endpoints) expect(endpoint.startsWith(feed)).toBe(false);
    expect(flavor).toContain(`"${feed}/latest.json"`);
  });
});

describe("the GPUI package workflow", () => {
  const package_ = workflow(".github/workflows/gpui-package.yml");
  const steps = Object.values(package_.jobs).flatMap((job) => job.steps ?? []);
  const scripts = steps.map((step) => step.run ?? "").join("\n");

  it("runs by hand or from the release workflow, with read-only access", () => {
    expect(Object.keys(package_.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    expect(package_.permissions).toEqual({ contents: "read" });
    expect(scripts).toContain('--flavor "$FLAVOR"');
  });

  it("publishes nothing: no release, tag or upload, only the run's artifact", () => {
    expect(scripts).not.toMatch(/gh release|git push|git tag/);
    expect(steps.some((step) => step.uses?.startsWith("tauri-apps/"))).toBe(false);
    expect(steps.some((step) => step.uses?.startsWith("actions/upload-artifact"))).toBe(true);
    expect(steps.some((step) => step.uses?.startsWith("actions/cache/save") || step.with?.["save-if"] === true)).toBe(false);
  });
});

describe("the release workflow", () => {
  const release = workflow(".github/workflows/release.yml");
  const apps = JSON.parse(read("scripts/release-apps.json"));

  it("builds Lattice for Apple silicon from the GPUI package while release-apps.json says gpui", () => {
    expect(["gpui", "tauri"]).toContain(apps["darwin-aarch64"]);
    expect(release.jobs.gpui).toMatchObject({ uses: "./.github/workflows/gpui-package.yml", with: { flavor: "main" } });
    expect(release.jobs.gpui.if).toContain("== 'gpui'");
  });

  it("publishes only from the last job, after the GPUI app replaced the Tauri app's files", () => {
    expect(release.jobs.publish.needs).toEqual(["plan", "release", "gpui"]);
    const names = (release.jobs.publish.steps ?? []).map((step) => step.name ?? step.uses ?? "");
    const at = (name: string) => names.findIndex((candidate) => candidate.startsWith(name));
    expect(at("Use public download URLs")).toBeLessThan(at("Put the GPUI app"));
    expect(at("Put the GPUI app")).toBeLessThan(at("Upload the updater manifest"));
    expect(names.at(-1)).toBe("Publish verified release");
    for (const job of ["plan", "release", "gpui"]) {
      expect((release.jobs[job].steps ?? []).map((step) => step.run ?? "").join("\n")).not.toContain("--draft=false");
    }
  });
});
