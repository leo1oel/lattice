#!/usr/bin/env node
// Stage Electron as "Lattice Chromium.app" in src-tauri/chromium-runtime/: the
// renderer a release build shows only when launched with
// LATTICE_RENDERER=chromium (src-tauri/src/chromium.rs), kept for one release.
//
//   node scripts/prepare-chromium-runtime.mjs

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CHROMIUM_BUNDLE_LOCALIZATIONS, pruneChromiumLocales } from "./chromium-runtime-locales.mjs";
import { codesign, signingIdentity, verifySignature } from "./lib/codesign.mjs";
import { capture, projectRoot, readJson, run, writeJson } from "./lib/util.mjs";

if (process.platform !== "darwin") {
  throw new Error("The bundled Chromium runtime is currently packaged only for macOS.");
}

const require = createRequire(import.meta.url);
const electronRoot = dirname(require.resolve("electron/package.json"));
const electronDist = join(electronRoot, "dist");
const electronApp = join(electronDist, "Electron.app");

// Electron ships its downloader as the explicit `install-electron` binary
// instead of running it during package installation. Keep ordinary installs
// small, but materialize the pinned runtime when a macOS package is prepared.
if (!existsSync(electronApp)) run(process.execPath, [join(electronRoot, "install.js")]);

const runtimeRoot = join(projectRoot, "src-tauri", "chromium-runtime");
const stageRoot = mkdtempSync(join(projectRoot, "src-tauri", ".chromium-runtime-"));
const stagedApp = join(stageRoot, "Lattice Chromium.app");
const appVersion = String(readJson(join(projectRoot, "package.json")).version);
const electronVersion = String(readJson(join(electronRoot, "package.json")).version);
const identity = signingIdentity() ?? "-";
const entitlements = join(projectRoot, "src-tauri", "Entitlements.plist");
const copyTree = (source, destination) =>
  cpSync(source, destination, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });

function plist(file, ...commands) {
  capture("/usr/libexec/PlistBuddy", [...commands.flatMap((command) => ["-c", command]), file]);
}

// Tauri's resource copier deliberately dereferences symlinks. A conventional
// macOS framework then arrives with duplicate binaries and no Resources link,
// invalidating both Electron and its signature. Convert Electron's four
// versioned frameworks to the equally valid flat framework layout before Tauri
// sees them, so every resource is an ordinary file or directory.
function flattenFramework(framework) {
  const version = join(framework, "Versions", "A");
  for (const entry of readdirSync(version)) {
    if (entry === "_CodeSignature") continue;
    rmSync(join(framework, entry), { recursive: true, force: true });
    copyTree(join(version, entry), join(framework, entry));
  }
  rmSync(join(framework, "Versions"), { recursive: true, force: true });
}

try {
  copyTree(electronApp, stagedApp);

  const resources = join(stagedApp, "Contents", "Resources");
  const appSource = join(resources, "app");
  mkdirSync(appSource, { recursive: true });
  cpSync(join(projectRoot, "scripts", "chromium-shell.mjs"), join(appSource, "chromium-shell.mjs"));
  cpSync(join(projectRoot, "scripts", "chromium-preload.cjs"), join(appSource, "chromium-preload.cjs"));
  cpSync(join(projectRoot, "scripts", "chromium-window-policy.mjs"), join(appSource, "chromium-window-policy.mjs"));
  cpSync(join(projectRoot, "scripts", "chromium-perf-lab.mjs"), join(appSource, "chromium-perf-lab.mjs"));
  cpSync(join(projectRoot, "src-tauri", "icons", "icon.icns"), join(resources, "lattice.icns"));
  cpSync(join(projectRoot, "src-tauri", "icons", "icon.png"), join(resources, "lattice.png"));
  cpSync(join(electronDist, "LICENSE"), join(resources, "LICENSE.electron.txt"));
  cpSync(join(electronDist, "LICENSES.chromium.html"), join(resources, "LICENSES.chromium.html"));
  writeJson(join(appSource, "package.json"), {
    name: "lattice-chromium-shell",
    productName: "Lattice",
    version: appVersion,
    private: true,
    type: "module",
    main: "chromium-shell.mjs",
  });

  const mainPlist = join(stagedApp, "Contents", "Info.plist");
  for (const [key, value] of Object.entries({
    CFBundleDisplayName: "Lattice",
    CFBundleName: "Lattice",
    CFBundleIdentifier: "app.leo1oel.researchwriter.chromium",
    CFBundleIconFile: "lattice.icns",
    CFBundleShortVersionString: appVersion,
    CFBundleVersion: appVersion,
    LSApplicationCategoryType: "public.app-category.productivity",
    LSMinimumSystemVersion: "14.0",
  })) {
    plist(mainPlist, `Set :${key} ${value}`);
  }
  // Electron's top-level locale directories are empty, so Tauri omits them
  // while copying this nested app into the final bundle. Declare the locales
  // explicitly or Chromium falls back to English before the web app can honor
  // its "follow system" preference.
  plist(
    mainPlist,
    "Add :CFBundleLocalizations array",
    ...CHROMIUM_BUNDLE_LOCALIZATIONS.map((locale, index) => `Add :CFBundleLocalizations:${index} string ${locale}`),
  );
  plist(mainPlist, "Set :NSMicrophoneUsageDescription Lattice uses the microphone when you record a voice note for the research agent.");
  plist(mainPlist, "Set :NSAudioCaptureUsageDescription Lattice uses audio capture when you record a voice note for the research agent.");

  const frameworks = join(stagedApp, "Contents", "Frameworks");
  for (const [name, suffix] of [
    ["Electron Helper.app", "helper"],
    ["Electron Helper (GPU).app", "helper.GPU"],
    ["Electron Helper (Plugin).app", "helper.Plugin"],
    ["Electron Helper (Renderer).app", "helper.Renderer"],
  ]) {
    plist(join(frameworks, name, "Contents", "Info.plist"), `Set :CFBundleIdentifier app.leo1oel.researchwriter.chromium.${suffix}`);
  }
  for (const name of ["Electron Framework.framework", "Mantle.framework", "ReactiveObjC.framework", "Squirrel.framework"]) {
    flattenFramework(join(frameworks, name));
  }

  // Locale resources are data-only, but they are sealed by the framework and
  // app signatures. Remove unsupported locales only after copying/flattening
  // and before any final signing pass.
  const removedLocales = pruneChromiumLocales(stagedApp);

  // `codesign --deep` signs recognized bundles after flattening, but skips raw
  // Mach-O files nested inside their resource directories. Apple notarization
  // checks those files independently, so sign them before sealing the app.
  const libraries = join(frameworks, "Electron Framework.framework", "Libraries");
  for (const name of readdirSync(libraries)) {
    if (name.endsWith(".dylib")) codesign(join(libraries, name), { identity });
  }
  codesign(join(frameworks, "Squirrel.framework", "Resources", "ShipIt"), { identity });
  codesign(stagedApp, { identity, entitlements, deep: true });
  verifySignature(stagedApp, "--deep", "--strict", "--verbose=2");

  rmSync(runtimeRoot, { recursive: true, force: true });
  renameSync(stageRoot, runtimeRoot);
  console.log(
    `Prepared Lattice Chromium runtime (Electron ${electronVersion}, removed ${removedLocales} locale directories) at ${runtimeRoot}`,
  );
} catch (error) {
  rmSync(stageRoot, { recursive: true, force: true });
  throw error;
}
