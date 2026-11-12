#!/usr/bin/env node

import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isMain } from "./lib/util.mjs";

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function fileInventory(root) {
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  const files = new Map();
  const visitedDirectories = new Set();
  async function visit(entry) {
    let canonical;
    try {
      canonical = await realpath(entry);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!isInside(canonicalRoot, canonical)) return;

    const info = await stat(canonical);
    const identity = `${info.dev}:${info.ino}`;
    if (info.isFile()) {
      if (!files.has(identity)) files.set(identity, { path: canonical, bytes: info.size });
      return;
    }
    if (!info.isDirectory() || visitedDirectories.has(identity)) return;
    visitedDirectories.add(identity);
    const children = await readdir(canonical);
    children.sort();
    for (const child of children) await visit(path.join(canonical, child));
  }
  await visit(canonicalRoot);
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function totalBytes(files) {
  return files?.reduce((sum, file) => sum + file.bytes, 0) ?? null;
}

function parseTagAttributes(tag) {
  const result = new Map();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.matchAll(pattern)) {
    result.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

export function eagerAssetUrls(html) {
  if (!/<html(?:\s|>)/i.test(html) || !/<\/html\s*>/i.test(html)) {
    throw new Error("dist/index.html is malformed: expected a complete <html> document");
  }
  const js = new Set();
  const css = new Set();
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const kind = match[1].toLowerCase();
    const attrs = parseTagAttributes(match[0]);
    if (kind === "script" && attrs.has("src")) js.add(attrs.get("src"));
    if (kind === "link") {
      const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
      if (rel.includes("modulepreload") && attrs.has("href")) js.add(attrs.get("href"));
      if (rel.includes("stylesheet") && attrs.has("href")) css.add(attrs.get("href"));
    }
  }
  return { js: [...js].sort(), css: [...css].sort() };
}

function localAssetPathname(value) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) return null;
  try {
    return decodeURIComponent(value.split(/[?#]/, 1)[0]).replace(/^[/\\]+/, "");
  } catch {
    throw new Error(`Invalid URL in dist/index.html: ${value}`);
  }
}

async function localAssetBytes(distRoot, urls, label) {
  const root = await realpath(distRoot);
  const identities = new Set();
  let bytes = 0;
  for (const value of urls) {
    const pathname = localAssetPathname(value);
    if (pathname === null) continue;
    const candidate = path.resolve(root, pathname);
    let canonical;
    try {
      canonical = await realpath(candidate);
    } catch (error) {
      throw new Error(`Eager ${label} asset is missing: ${value}`, { cause: error });
    }
    if (!isInside(root, canonical)) throw new Error(`Eager asset escapes dist/: ${value}`);
    const info = await stat(canonical);
    if (!info.isFile()) throw new Error(`Eager asset is not a file: ${value}`);
    const identity = `${info.dev}:${info.ino}`;
    if (!identities.has(identity)) {
      identities.add(identity);
      bytes += info.size;
    }
  }
  return bytes;
}

async function optionalTotal(target) {
  return totalBytes(await fileInventory(target));
}

async function optionalRuntimeManifest(runtime) {
  try {
    return JSON.parse(await readFile(path.join(runtime, "manifest.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function createAppSizeReport(workspace = process.cwd()) {
  const dist = path.resolve(workspace, "dist");
  let html;
  try {
    html = await readFile(path.join(dist, "index.html"), "utf8");
  } catch (error) {
    throw new Error(`Cannot read dist/index.html; build the frontend first: ${error.message}`, { cause: error });
  }
  const eager = eagerAssetUrls(html);
  const runtime = path.resolve(workspace, "src-tauri/synara-runtime");
  const presentationRuntime = path.resolve(workspace, "src-tauri/presentation-runtime");
  const runtimeFiles = await fileInventory(runtime);
  const runtimeManifest = await optionalRuntimeManifest(runtime);
  const canonicalRuntime = runtimeFiles ? await realpath(runtime) : runtime;
  const sdkExecutables = runtimeFiles
    ?.filter((file) => /node_modules[/\\]@anthropic-ai[/\\]claude-agent-sdk-[^/\\]+[/\\]claude(?:\.exe)?$/.test(file.path))
    .map((file) => ({ path: path.relative(canonicalRuntime, file.path).split(path.sep).join("/"), bytes: file.bytes })) ?? [];

  return {
    distBytes: totalBytes(await fileInventory(dist)),
    eagerJsBytes: await localAssetBytes(dist, eager.js, "JavaScript"),
    eagerCssBytes: await localAssetBytes(dist, eager.css, "CSS"),
    synaraRuntimeBytes: totalBytes(runtimeFiles),
    bundledNodeBytes: await optionalTotal(path.join(runtime, "bin/node"))
      ?? await optionalTotal(path.join(runtime, "bin/node.exe")),
    synaraServerDistBytes: await optionalTotal(path.join(runtime, "server/dist")),
    runtimeNodeModulesBytes: await optionalTotal(path.join(runtime, "server/node_modules")),
    synaraTarget: typeof runtimeManifest?.target === "string" ? runtimeManifest.target : null,
    synaraNodeRuntime: typeof runtimeManifest?.nodeRuntime === "string"
      ? runtimeManifest.nodeRuntime
      : null,
    presentationRuntimeBytes: await optionalTotal(presentationRuntime),
    claudeAgentSdkExecutables: sdkExecutables,
  };
}

// About 25 KB above the eager JS of 2026-10 (1,369,855 bytes). Compiling App
// whole under the React Compiler had added ~48 KB of memo cache; moving Yjs
// and the spreadsheet operations behind the Agent's first spreadsheet request
// (`loadAgentSpreadsheetModel`) took ~87 KB back out. Raised from 1.33 MiB
// when App's concepts moved into src/app hooks and components (#498): each is
// compiled on its own and memoizes its inputs and results, which App's single
// function had not, ~22 KB more (1,382,409 -> 1,404,478 bytes). Raised from
// 1.35 MiB on 2026-10-30 when the open documents moved into a Zustand store:
// zustand (~1 KB) and the store with its compiled hook, +3.3 KB
// (1,414,200 -> 1,417,523 bytes). Raised from 1.355 MiB on 2026-11-08: the
// per-occurrence citation reasons (#704) took main to 1,420,180 bytes, and
// Format document's stale-result guard plus the Overleaf reject resync, both
// fixes for corruption, add 1.2 KB more (1,416,180 -> 1,417,394 bytes alone).
// Raised from 1.357 MiB the same day for the implicit-state audit's S6-S10
// fixes, whose states live in hooks App runs at startup (Overleaf reconnect,
// build Stop clearing its queue and the slow-build notice, the agent frame's
// per-load readiness, compile repair's restart and unlock), +1.3 KB with the
// repair run itself already loaded on demand (1,422,354 -> 1,423,643 bytes).
// Raised from 1.358 MiB the same day for the audit's S11-S23 fixes (#720),
// small guards spread over a dozen eager modules with no one import to defer,
// +0.6 KB on top of S6-S10 (1,423,643 -> 1,424,228 bytes). Raised from 1.359
// MiB for the PDF's separate window (#725): whether each project's PDF is in
// its own window, the palette entry that moves it there and back, the guards
// that keep a build or a jump from reopening the panel, and the window page's
// start in main.tsx; the bridge and the window's page load on demand, +2.6 KB
// (1,424,228 -> 1,426,861 bytes).
// Raised from 1.361 MiB on 2026-11-09 for the updater's recovery (#730) and
// the app menu's Check for Updates… / Settings… / Report a Problem… (#731):
// the retries, the failure wording, the install's log line and the report
// export load on demand, but the provider that offers a held update again,
// answers the menu and keeps its title, and the menu's labels, run at
// startup, +1.9 KB on top of #725 (1,426,861 -> 1,428,755 bytes).
// Raised again the same day for the TeX doctor's package-update state (#726),
// a hook App runs so an approved update outlives Settings, +2.4 KB
// (1,428,755 -> 1,431,207 bytes, a local build).
// Raised from 1.365 MiB for the reference check's fix groups and Refresh entry (#750), +1.8 KB (1,433,109 bytes, a local build).
// Raised from 1.367 MiB for the build stall (#747): automatic builds hold after
// a stall, which the build pipeline decides at startup, +0.3 KB (1,433,439 bytes).
// The experimental Windows host (#702) fits under it: the host check behind
// the Ctrl/Alt/Shift key labels, the window's client-area minimum, the Agent
// notice and update gating run at startup; its LaTeX setup dialog and F11/Esc
// fullscreen keys load on demand (windows-host-ui.ts), +1.0 KB
// (1,433,439 -> 1,434,396 bytes, a local build).
// Raised from 1.368 MiB for editable figures: the project tree must know a
// drawing without a load, and the rest of pasting and opening a figure loads
// on demand, +0.6 KB (1,434,396 -> 1,434,983 bytes, a local build).
// Raised to 1.39 MiB: headroom so routine growth does not block PRs; captain 2026-11-09.
// Raised from 1.39 MiB for the model endpoint (#825): its five Settings search
// rows live in the index the command palette builds at startup; the pane and
// its probe load on demand, +0.66 KB (1,457,662 bytes on CI).
// Raised from 1.391 MiB for resuming a switched-away Overleaf document from
// its proven text: the proof rides in the live-editing hook every project
// mounts, +2.1 KB (1,456,461 -> 1,458,653 bytes, a local build and CI alike).
const EAGER_JS_BUDGET_BYTES = Math.floor(1.392 * 1024 * 1024);
// A perf-lab build (VITE_PERF_LAB=1, scripts/perf-lab.mjs) compiles in the
// lab's hooks (~0.3 KB eager on 2026-11-04). They never ship, so they must not
// spend the release budget: a release at its limit would fail every lab build.
const PERF_LAB_EAGER_JS_ALLOWANCE_BYTES = 2 * 1024;
const ROLLDOWN_RUNTIME_BUDGET_BYTES = 4 * 1024;
const CLAUDE_PATH_LAUNCHER_BUDGET_BYTES = 4 * 1024;
// The Open Slide runtime is staged for the host it is built on. Its Linux
// copy carries the larger ELF builds of rolldown, lightningcss and Tailwind's
// oxide: 70,781,079 bytes against macOS's 67,427,917 on 2026-11-07. The
// Intel-based Mac copy's x86_64 builds of the same packages are larger too:
// 69,915,321 bytes on 2026-11-07. Keys are `${platform}-${arch}` or a
// platform alone.
const PRESENTATION_RUNTIME_BUDGET_BYTES = {
  darwin: 66 * 1024 * 1024,
  "darwin-x64": 68 * 1024 * 1024,
  linux: 69 * 1024 * 1024,
  // Windows PE builds of the same frozen Open Slide closure: 78,110,553 bytes.
  "win32-x64": 76 * 1024 * 1024,
};

export async function checkAppSizeBudgets(
  workspace = process.cwd(),
  report = null,
  { lab = process.env.VITE_PERF_LAB === "1", platform = process.platform, arch = process.arch } = {},
) {
  const measuredReport = report ?? await createAppSizeReport(workspace);
  const dist = path.resolve(workspace, "dist");
  const html = await readFile(path.join(dist, "index.html"), "utf8");
  const eager = eagerAssetUrls(html);
  const eagerJsBytes = measuredReport.eagerJsBytes;
  const chunkUrls = new Map();
  for (const url of eager.js) {
    const pathname = localAssetPathname(url);
    if (pathname === null) {
      throw new Error(`External eager JavaScript is not allowed: ${url}`);
    }
    if (pathname === "polyfills.js") continue;
    // The eager startup graph is an allowlist, not a budget line: `app` and
    // `ui` are the two application-owned chunks vite.config.ts names, and
    // `rolldown-runtime` is Vite's own preload shim. A new name here means the
    // startup graph grew a chunk nobody decided on.
    const match = pathname.match(
      /^assets\/(app|ui|rolldown-runtime)-[^/]+\.js$/,
    );
    if (!match) throw new Error(`Unexpected eager JavaScript asset: ${url}`);
    const urls = chunkUrls.get(match[1]) ?? [];
    urls.push(url);
    chunkUrls.set(match[1], urls);
  }

  for (const name of ["app", "ui"]) {
    const count = chunkUrls.get(name)?.length ?? 0;
    if (count !== 1) {
      throw new Error(`Expected exactly one eager ${name} chunk, found ${count}`);
    }
  }
  const runtimeUrls = chunkUrls.get("rolldown-runtime") ?? [];
  if (runtimeUrls.length > 1) {
    throw new Error(`Expected at most one eager rolldown-runtime chunk, found ${runtimeUrls.length}`);
  }
  const runtimeBytes = runtimeUrls.length === 1
    ? await localAssetBytes(dist, runtimeUrls, "JavaScript")
    : 0;
  if (runtimeBytes > ROLLDOWN_RUNTIME_BUDGET_BYTES) {
    throw new Error(
      `Eager rolldown-runtime is ${runtimeBytes} bytes; budget is ${ROLLDOWN_RUNTIME_BUDGET_BYTES}`,
    );
  }
  const eagerJsBudgetBytes = EAGER_JS_BUDGET_BYTES + (lab ? PERF_LAB_EAGER_JS_ALLOWANCE_BYTES : 0);
  if (eagerJsBytes > eagerJsBudgetBytes) {
    throw new Error(
      `Eager JavaScript is ${eagerJsBytes} bytes; budget is ${eagerJsBudgetBytes}${lab ? " (with the perf-lab allowance)" : ""}`,
    );
  }
  for (const executable of measuredReport.claudeAgentSdkExecutables) {
    // Unix SDK packages can use the shell launcher staged by the preparation
    // script. Windows needs a native .exe launcher and is not optimized yet.
    if (executable.path.includes("-win32-") || executable.bytes <= CLAUDE_PATH_LAUNCHER_BUDGET_BYTES) {
      continue;
    }
    throw new Error(
      `Bundled Claude executable is ${executable.bytes} bytes; PATH launcher budget is ${CLAUDE_PATH_LAUNCHER_BUDGET_BYTES}`,
    );
  }
  // The Synara and Open Slide sidecars run on the standalone Node staged with
  // Synara, in release builds as in development.
  if (measuredReport.synaraNodeRuntime !== null && measuredReport.bundledNodeBytes === null) {
    throw new Error("The staged Synara runtime must bundle its standalone Node binary");
  }
  const presentationRuntimeBudgetBytes = PRESENTATION_RUNTIME_BUDGET_BYTES[`${platform}-${arch}`]
    ?? PRESENTATION_RUNTIME_BUDGET_BYTES[platform]
    ?? PRESENTATION_RUNTIME_BUDGET_BYTES.darwin;
  if (measuredReport.presentationRuntimeBytes > presentationRuntimeBudgetBytes) {
    throw new Error(
      `Presentation runtime is ${measuredReport.presentationRuntimeBytes} bytes; budget is ${presentationRuntimeBudgetBytes}`,
    );
  }
  return {
    eagerJsBytes,
    eagerJsBudgetBytes,
    lab,
    rolldownRuntimeBytes: runtimeBytes,
    rolldownRuntimeBudgetBytes: ROLLDOWN_RUNTIME_BUDGET_BYTES,
    claudePathLauncherBudgetBytes: CLAUDE_PATH_LAUNCHER_BUDGET_BYTES,
    presentationRuntimeBudgetBytes,
  };
}

// The installed app is what a user's disk pays for, so this budget counts
// allocated blocks (what `du` and Finder's "on disk" report): thousands of
// small runtime files each round up to a 4 KiB block. Synara 1.0.8 raised it
// from 315 MiB: the web bundle gained the Code OSS editor's client (about
// 7 MiB), and only about 3 MiB of it is reachable from that editor alone.
// v0.11.8 raised it from 320 MiB: Synara 1.0.8 with Open Slide 2.3.1 built
// at 320.1 MiB on disk. v0.15.0 raised it from 330 MiB: Synara 1.1.0 grew the
// sidecar about 1.9 MB and the release built at 330.8 MiB on disk. v0.16.1
// raised it from 333 MiB: the v0.16 features (Zotero import, PDF comment
// column, history review, Overleaf live sync) grew the app binary from 61.7 to
// 63.1 MiB, and the v0.16.0 build reached 333.2 MiB on disk. 2026-11-09: set
// to 400 MiB (captain's call) so routine growth stops blocking releases and PRs.
const INSTALLED_APP_BUDGET_BYTES = 400 * 1024 * 1024;
// The Intel-based Mac app (macos-intel.yml), built on an Intel host, carries x86_64
// builds of the app, Node and the runtimes' native packages, all larger: the
// first one built at 335.8 MiB on disk on 2026-11-07. 2026-11-11: raised from
// 340 to 400 MiB under the same captain's call, after v0.16.14's Intel build
// reached 340.5 MiB and published no Intel assets.
const INSTALLED_INTEL_APP_BUDGET_BYTES = 400 * 1024 * 1024;
/** The installed-size budget for an app built on a host with `arch`. */
export const installedAppBudgetBytes = (arch = process.arch) =>
  (arch === "x64" ? INSTALLED_INTEL_APP_BUDGET_BYTES : INSTALLED_APP_BUDGET_BYTES);

// Each file counts toward the longest of these prefixes it sits under; the
// runtimes are split where their size is decided.
const APP_FOLDERS = [
  "Contents/MacOS",
  "Contents/_CodeSignature",
  "Contents/Resources/synara-runtime/bin",
  "Contents/Resources/synara-runtime/server/dist",
  "Contents/Resources/synara-runtime/server/node_modules",
  "Contents/Resources/synara-runtime",
  "Contents/Resources/presentation-runtime/node_modules",
  "Contents/Resources/presentation-runtime",
  "Contents/Resources",
  "Contents",
];

/** Bytes, allocated bytes, and file count of an installed .app, total and per folder. */
export async function createInstalledAppReport(app) {
  const folders = new Map(APP_FOLDERS.map((folder) => [folder, { folder, bytes: 0, allocatedBytes: 0, files: 0 }]));
  const total = { bytes: 0, allocatedBytes: 0, files: 0 };
  async function visit(directory) {
    const children = await readdir(directory);
    children.sort();
    for (const child of children) {
      const entry = path.join(directory, child);
      // A bundle's links point inside it (framework Versions/Current); its
      // targets are counted where they live.
      const info = await lstat(entry);
      if (info.isDirectory()) {
        await visit(entry);
        continue;
      }
      if (!info.isFile()) continue;
      const relative = path.relative(app, entry).split(path.sep).join("/");
      const folder = APP_FOLDERS.find((prefix) => relative.startsWith(`${prefix}/`)) ?? "Contents";
      for (const bucket of [folders.get(folder), total]) {
        bucket.bytes += info.size;
        bucket.allocatedBytes += info.blocks * 512;
        bucket.files += 1;
      }
    }
  }
  if (!(await stat(app)).isDirectory()) throw new Error(`${app} is not an app bundle`);
  await visit(app);
  return { ...total, folders: [...folders.values()].filter((folder) => folder.files > 0) };
}

const mebibytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export function formatInstalledAppReport(report, budgetBytes = INSTALLED_APP_BUDGET_BYTES) {
  const rows = [["Folder", "On disk", "Files bytes", "Files"], ...report.folders.map((folder) => [
    folder.folder,
    mebibytes(folder.allocatedBytes),
    mebibytes(folder.bytes),
    folder.files.toLocaleString("en-US"),
  ]), ["Total", mebibytes(report.allocatedBytes), mebibytes(report.bytes), report.files.toLocaleString("en-US")]];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const lines = rows.map((row) => row.map((cell, column) => column === 0 ? cell.padEnd(widths[0]) : cell.padStart(widths[column])).join("  "));
  lines.push(`Installed-size budget: ${mebibytes(budgetBytes)} on disk`);
  return lines.join("\n");
}

export function checkInstalledAppBudget(report, budgetBytes = INSTALLED_APP_BUDGET_BYTES) {
  if (report.allocatedBytes > budgetBytes) {
    throw new Error(
      `The installed app is ${mebibytes(report.allocatedBytes)} on disk; budget is ${mebibytes(budgetBytes)}. `
        + "Find the folder that grew above, and lower the budget again when a change shrinks the app.",
    );
  }
}

function humanBytes(bytes) {
  if (bytes === null) return "missing";
  return `${bytes.toLocaleString("en-US")} bytes`;
}

export function formatSizeReport(report) {
  const lines = [
    ["Total dist", report.distBytes],
    ["Eager JS", report.eagerJsBytes],
    ["Eager CSS", report.eagerCssBytes],
    ["Total Synara runtime", report.synaraRuntimeBytes],
    ["Bundled Node bin", report.bundledNodeBytes],
    ["Synara server dist", report.synaraServerDistBytes],
    ["Runtime node_modules", report.runtimeNodeModulesBytes],
    ["Presentation runtime", report.presentationRuntimeBytes],
  ].map(([label, bytes]) => `${label}: ${humanBytes(bytes)}`);
  if (report.synaraRuntimeBytes === null) lines.push("Claude Agent SDK executables: runtime missing");
  else if (report.claudeAgentSdkExecutables.length === 0) lines.push("Claude Agent SDK executables: none found");
  else for (const file of report.claudeAgentSdkExecutables) lines.push(`Claude Agent SDK executable (${file.path}): ${humanBytes(file.bytes)}`);
  return lines.join("\n");
}

async function main() {
  // pnpm forwards its conventional `--` separator to Node scripts.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args[0] === "--app" && args.length === 2) {
    const report = await createInstalledAppReport(args[1]);
    console.log(formatInstalledAppReport(report, installedAppBudgetBytes()));
    checkInstalledAppBudget(report, installedAppBudgetBytes());
    return;
  }
  if (args.some((arg) => arg !== "--check")) {
    throw new Error("Usage: node scripts/app-size-report.mjs [--check | --app <path/to/Lattice.app>]");
  }
  if (args.includes("--check")) {
    const result = await checkAppSizeBudgets();
    const runtime = result.rolldownRuntimeBytes > 0
      ? `; rolldown runtime ${humanBytes(result.rolldownRuntimeBytes)}`
      : "";
    console.log(
      `App size guard passed: eager JS ${humanBytes(result.eagerJsBytes)} / ${humanBytes(result.eagerJsBudgetBytes)}${result.lab ? " (perf-lab build)" : ""}${runtime}`,
    );
  } else {
    const report = await createAppSizeReport();
    console.log(formatSizeReport(report));
  }
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`app-size-report: ${error.message}`);
    process.exitCode = 1;
  });
}
