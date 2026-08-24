#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("The bundled Chromium runtime is currently packaged only for macOS.");
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const electronRoot = dirname(require.resolve("electron/package.json"));
const electronDist = join(electronRoot, "dist");
const electronApp = join(electronDist, "Electron.app");

// Electron 43 ships its downloader as the explicit `install-electron` binary
// instead of running it during package installation. Keep ordinary installs
// small, but materialize the pinned runtime when a macOS package is prepared.
if (!existsSync(electronApp)) {
  execFileSync(process.execPath, [join(electronRoot, "install.js")], {
    stdio: "inherit",
  });
}

const runtimeRoot = join(projectRoot, "src-tauri", "chromium-runtime");
const stageRoot = mkdtempSync(join(projectRoot, "src-tauri", ".chromium-runtime-"));
const stagedApp = join(stageRoot, "Lattice Chromium.app");
const packageJson = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const appVersion = String(packageJson.version);
const electronVersion = String(
  JSON.parse(readFileSync(join(electronRoot, "package.json"), "utf8")).version,
);
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim() || "-";
const entitlements = join(projectRoot, "src-tauri", "Entitlements.plist");

function plistSet(plist, key, value) {
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
}

function sign(path, { deep = false, includeEntitlements = false } = {}) {
  const arguments_ = ["--force"];
  if (deep) arguments_.push("--deep");
  arguments_.push("--options", "runtime");
  if (signingIdentity !== "-") arguments_.push("--timestamp");
  if (includeEntitlements) arguments_.push("--entitlements", entitlements);
  arguments_.push("--sign", signingIdentity, path);
  execFileSync("/usr/bin/codesign", arguments_, { stdio: "inherit" });
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
    const destination = join(framework, entry);
    rmSync(destination, { recursive: true, force: true });
    cpSync(join(version, entry), destination, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
    });
  }
  rmSync(join(framework, "Versions"), { recursive: true, force: true });
}

try {
  cpSync(electronApp, stagedApp, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });

  const resources = join(stagedApp, "Contents", "Resources");
  const appSource = join(resources, "app");
  mkdirSync(appSource, { recursive: true });
  cpSync(join(projectRoot, "scripts", "chromium-shell.mjs"), join(appSource, "chromium-shell.mjs"));
  cpSync(join(projectRoot, "src-tauri", "icons", "icon.icns"), join(resources, "lattice.icns"));
  cpSync(join(projectRoot, "src-tauri", "icons", "icon.png"), join(resources, "lattice.png"));
  cpSync(join(electronDist, "LICENSE"), join(resources, "LICENSE.electron.txt"));
  cpSync(join(electronDist, "LICENSES.chromium.html"), join(resources, "LICENSES.chromium.html"));
  writeFileSync(join(appSource, "package.json"), `${JSON.stringify({
    name: "lattice-chromium-shell",
    productName: "Lattice",
    version: appVersion,
    private: true,
    type: "module",
    main: "chromium-shell.mjs",
  }, null, 2)}\n`);

  const mainPlist = join(stagedApp, "Contents", "Info.plist");
  plistSet(mainPlist, "CFBundleDisplayName", "Lattice");
  plistSet(mainPlist, "CFBundleName", "Lattice");
  plistSet(mainPlist, "CFBundleIdentifier", "app.leo1oel.researchwriter.chromium");
  plistSet(mainPlist, "CFBundleIconFile", "lattice.icns");
  plistSet(mainPlist, "CFBundleShortVersionString", appVersion);
  plistSet(mainPlist, "CFBundleVersion", appVersion);
  plistSet(mainPlist, "LSApplicationCategoryType", "public.app-category.productivity");
  plistSet(mainPlist, "LSMinimumSystemVersion", "14.0");
  plistSet(
    mainPlist,
    "NSMicrophoneUsageDescription",
    "Lattice uses the microphone when you record a voice note for the research agent.",
  );
  plistSet(
    mainPlist,
    "NSAudioCaptureUsageDescription",
    "Lattice uses audio capture when you record a voice note for the research agent.",
  );

  const helpers = [
    ["Electron Helper.app", "helper"],
    ["Electron Helper (GPU).app", "helper.GPU"],
    ["Electron Helper (Plugin).app", "helper.Plugin"],
    ["Electron Helper (Renderer).app", "helper.Renderer"],
  ];
  for (const [name, suffix] of helpers) {
    const plist = join(stagedApp, "Contents", "Frameworks", name, "Contents", "Info.plist");
    plistSet(plist, "CFBundleIdentifier", `app.leo1oel.researchwriter.chromium.${suffix}`);
  }

  const frameworks = join(stagedApp, "Contents", "Frameworks");
  for (const name of [
    "Electron Framework.framework",
    "Mantle.framework",
    "ReactiveObjC.framework",
    "Squirrel.framework",
  ]) {
    flattenFramework(join(frameworks, name));
  }

  // `codesign --deep` signs recognized bundles after flattening, but skips raw
  // Mach-O files nested inside their resource directories. Apple notarization
  // checks those files independently, so sign them before sealing the app.
  const electronFramework = join(frameworks, "Electron Framework.framework");
  for (const name of readdirSync(join(electronFramework, "Libraries"))) {
    if (name.endsWith(".dylib")) sign(join(electronFramework, "Libraries", name));
  }
  sign(join(frameworks, "Squirrel.framework", "Resources", "ShipIt"));
  sign(stagedApp, { deep: true, includeEntitlements: true });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", stagedApp], {
    stdio: "inherit",
  });

  rmSync(runtimeRoot, { recursive: true, force: true });
  renameSync(stageRoot, runtimeRoot);
  console.log(
    `Prepared Lattice Chromium runtime (Electron ${electronVersion}) at ${runtimeRoot}`,
  );
} catch (error) {
  rmSync(stageRoot, { recursive: true, force: true });
  throw error;
}
