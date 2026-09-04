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
import {
  CHROMIUM_BUNDLE_LOCALIZATIONS,
  pruneChromiumLocales,
} from "./chromium-runtime-locales.mjs";
import { configureSynaraNodeRuntime } from "./synara-node-runtime.mjs";

if (process.platform !== "darwin") {
  throw new Error("The bundled Chromium runtime is currently packaged only for macOS.");
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const runtimeArgument = arguments_.find((argument) =>
  argument.startsWith("--synara-node-runtime="),
);
if (arguments_.length !== 1 || !runtimeArgument) {
  throw new Error(
    "Usage: prepare-chromium-runtime.mjs --synara-node-runtime=electron|standalone",
  );
}
const synaraNodeRuntime = runtimeArgument.slice(runtimeArgument.indexOf("=") + 1);
if (synaraNodeRuntime !== "electron" && synaraNodeRuntime !== "standalone") {
  throw new Error(`Unsupported Synara Node runtime: ${synaraNodeRuntime}`);
}
const require = createRequire(import.meta.url);
const electronRoot = dirname(require.resolve("electron/package.json"));
const electronDist = join(electronRoot, "dist");
const electronApp = join(electronDist, "Electron.app");

// Electron ships its downloader as the explicit `install-electron` binary
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
const standaloneNodeVersion = String(
  JSON.parse(readFileSync(join(projectRoot, "scripts", "synara-runtime.json"), "utf8"))
    .nodeVersion,
);
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim() || "-";
const entitlements = join(projectRoot, "src-tauri", "Entitlements.plist");

function plistSet(plist, key, value) {
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
}

function readElectronNodeVersion(app) {
  const executable = join(app, "Contents", "MacOS", "Electron");
  const version = execFileSync(executable, ["-p", "process.versions.node"], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`The bundled Electron Node runtime reported an invalid version: ${version}`);
  }
  return version;
}

function sign(path, { deep = false, includeEntitlements = false } = {}) {
  const codesignArguments = ["--force"];
  if (deep) codesignArguments.push("--deep");
  codesignArguments.push("--options", "runtime");
  if (signingIdentity !== "-") codesignArguments.push("--timestamp");
  if (includeEntitlements) codesignArguments.push("--entitlements", entitlements);
  codesignArguments.push("--sign", signingIdentity, path);
  execFileSync("/usr/bin/codesign", codesignArguments, { stdio: "inherit" });
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
  cpSync(
    join(projectRoot, "scripts", "chromium-window-policy.mjs"),
    join(appSource, "chromium-window-policy.mjs"),
  );
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
  // Electron's top-level locale directories are empty, so Tauri omits them
  // while copying this nested app into the final bundle. Declare the locales
  // explicitly or Chromium falls back to English before the web app can honor
  // its "follow system" preference.
  execFileSync("/usr/libexec/PlistBuddy", [
    "-c", "Add :CFBundleLocalizations array",
    ...CHROMIUM_BUNDLE_LOCALIZATIONS.flatMap((locale, index) => [
      "-c", `Add :CFBundleLocalizations:${index} string ${locale}`,
    ]),
    mainPlist,
  ]);
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

  // Locale resources are data-only, but they are sealed by the framework and
  // app signatures. Remove unsupported locales only after copying/flattening
  // and before any final signing pass.
  const removedLocales = pruneChromiumLocales(stagedApp);

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
  const electronNodeVersion = readElectronNodeVersion(stagedApp);

  rmSync(runtimeRoot, { recursive: true, force: true });
  renameSync(stageRoot, runtimeRoot);
  const configuredSynara = configureSynaraNodeRuntime({
    synaraRoot: join(projectRoot, "src-tauri", "synara-runtime"),
    nodeRuntime: synaraNodeRuntime,
    electronNodeVersion,
    standaloneNodeVersion,
  });
  const synaraDescription = !configuredSynara
    ? ""
    : synaraNodeRuntime === "electron"
      ? ", shared Node with Synara"
      : ", retained standalone Synara Node";
  console.log(
    `Prepared Lattice Chromium runtime (Electron ${electronVersion}, Node ${electronNodeVersion}, removed ${removedLocales} locale directories${synaraDescription}) at ${runtimeRoot}`,
  );
} catch (error) {
  rmSync(stageRoot, { recursive: true, force: true });
  throw error;
}
