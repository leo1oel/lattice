#!/usr/bin/env node

import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
    bundledNodeBytes: await optionalTotal(path.join(runtime, "bin/node")),
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
// (`loadAgentSpreadsheetModel`) took ~87 KB back out.
const EAGER_JS_BUDGET_BYTES = Math.floor(1.33 * 1024 * 1024);
const ROLLDOWN_RUNTIME_BUDGET_BYTES = 4 * 1024;
const CLAUDE_PATH_LAUNCHER_BUDGET_BYTES = 4 * 1024;
const PRESENTATION_RUNTIME_BUDGET_BYTES = 66 * 1024 * 1024;

export async function checkAppSizeBudgets(
  workspace = process.cwd(),
  report = null,
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
  if (eagerJsBytes > EAGER_JS_BUDGET_BYTES) {
    throw new Error(
      `Eager JavaScript is ${eagerJsBytes} bytes; budget is ${EAGER_JS_BUDGET_BYTES}`,
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
  if (measuredReport.presentationRuntimeBytes > PRESENTATION_RUNTIME_BUDGET_BYTES) {
    throw new Error(
      `Presentation runtime is ${measuredReport.presentationRuntimeBytes} bytes; budget is ${PRESENTATION_RUNTIME_BUDGET_BYTES}`,
    );
  }
  return {
    eagerJsBytes,
    eagerJsBudgetBytes: EAGER_JS_BUDGET_BYTES,
    rolldownRuntimeBytes: runtimeBytes,
    rolldownRuntimeBudgetBytes: ROLLDOWN_RUNTIME_BUDGET_BYTES,
    claudePathLauncherBudgetBytes: CLAUDE_PATH_LAUNCHER_BUDGET_BYTES,
    presentationRuntimeBudgetBytes: PRESENTATION_RUNTIME_BUDGET_BYTES,
  };
}

// The installed app is what a user's disk pays for, so this budget counts
// allocated blocks (what `du` and Finder's "on disk" report): thousands of
// small runtime files each round up to a 4 KiB block. Synara 1.0.8 raised it
// from 315 MiB: the web bundle gained the Code OSS editor's client (about
// 7 MiB), and only about 3 MiB of it is reachable from that editor alone.
// v0.11.8 raised it from 320 MiB: Synara 1.0.8 with Open Slide 2.3.1 built
// at 320.1 MiB on disk.
const INSTALLED_APP_BUDGET_BYTES = 330 * 1024 * 1024;

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
    console.log(formatInstalledAppReport(report));
    checkInstalledAppBudget(report);
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
      `App size guard passed: eager JS ${humanBytes(result.eagerJsBytes)} / ${humanBytes(result.eagerJsBudgetBytes)}${runtime}`,
    );
  } else {
    const report = await createAppSizeReport();
    console.log(formatSizeReport(report));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`app-size-report: ${error.message}`);
    process.exitCode = 1;
  });
}
