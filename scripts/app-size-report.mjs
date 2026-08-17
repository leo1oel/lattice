#!/usr/bin/env node

import { readFile, readdir, realpath, stat } from "node:fs/promises";
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

function total(files) {
  return files?.reduce((sum, file) => sum + file.bytes, 0) ?? null;
}

function attributes(tag) {
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
    const attrs = attributes(match[0]);
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
  return total(await fileInventory(target));
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
  const runtimeFiles = await fileInventory(runtime);
  const canonicalRuntime = runtimeFiles ? await realpath(runtime) : runtime;
  const sdkExecutables = runtimeFiles
    ?.filter((file) => /node_modules[/\\]@anthropic-ai[/\\]claude-agent-sdk-[^/\\]+[/\\]claude(?:\.exe)?$/.test(file.path))
    .map((file) => ({ path: path.relative(canonicalRuntime, file.path).split(path.sep).join("/"), bytes: file.bytes })) ?? [];

  return {
    distBytes: total(await fileInventory(dist)),
    eagerJsBytes: await localAssetBytes(dist, eager.js, "JavaScript"),
    eagerCssBytes: await localAssetBytes(dist, eager.css, "CSS"),
    synaraRuntimeBytes: total(runtimeFiles),
    bundledNodeBytes: await optionalTotal(path.join(runtime, "bin/node")),
    synaraServerDistBytes: await optionalTotal(path.join(runtime, "server/dist")),
    runtimeNodeModulesBytes: await optionalTotal(path.join(runtime, "server/node_modules")),
    claudeAgentSdkExecutables: sdkExecutables,
  };
}

const EAGER_JS_BUDGET_BYTES = Math.floor(1.35 * 1024 * 1024);
const ROLLDOWN_RUNTIME_BUDGET_BYTES = 4 * 1024;

export async function checkAppSizeBudgets(
  workspace = process.cwd(),
  report = null,
) {
  const dist = path.resolve(workspace, "dist");
  const html = await readFile(path.join(dist, "index.html"), "utf8");
  const eager = eagerAssetUrls(html);
  const eagerJsBytes = report?.eagerJsBytes
    ?? await localAssetBytes(dist, eager.js, "JavaScript");
  const chunkUrls = new Map();
  for (const url of eager.js) {
    const pathname = localAssetPathname(url);
    if (pathname === null) {
      throw new Error(`External eager JavaScript is not allowed: ${url}`);
    }
    if (pathname === "polyfills.js") continue;
    const match = pathname.match(
      /^assets\/(app|ui|provided-icons|rolldown-runtime)-[^/]+\.js$/,
    );
    if (!match) throw new Error(`Unexpected eager JavaScript asset: ${url}`);
    const urls = chunkUrls.get(match[1]) ?? [];
    urls.push(url);
    chunkUrls.set(match[1], urls);
  }

  for (const name of ["app", "ui", "provided-icons"]) {
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
  return {
    eagerJsBytes,
    eagerJsBudgetBytes: EAGER_JS_BUDGET_BYTES,
    rolldownRuntimeBytes: runtimeBytes,
    rolldownRuntimeBudgetBytes: ROLLDOWN_RUNTIME_BUDGET_BYTES,
  };
}

function humanBytes(bytes) {
  if (bytes === null) return "missing";
  return `${bytes.toLocaleString("en-US")} bytes`;
}

export function formatHuman(report) {
  const lines = [
    ["Total dist", report.distBytes],
    ["Eager JS", report.eagerJsBytes],
    ["Eager CSS", report.eagerCssBytes],
    ["Total Synara runtime", report.synaraRuntimeBytes],
    ["Bundled Node bin", report.bundledNodeBytes],
    ["Synara server dist", report.synaraServerDistBytes],
    ["Runtime node_modules", report.runtimeNodeModulesBytes],
  ].map(([label, bytes]) => `${label}: ${humanBytes(bytes)}`);
  if (report.synaraRuntimeBytes === null) lines.push("Claude Agent SDK executables: runtime missing");
  else if (report.claudeAgentSdkExecutables.length === 0) lines.push("Claude Agent SDK executables: none found");
  else for (const file of report.claudeAgentSdkExecutables) lines.push(`Claude Agent SDK executable (${file.path}): ${humanBytes(file.bytes)}`);
  return lines.join("\n");
}

async function main() {
  // pnpm forwards its conventional `--` separator to Node scripts.
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (
    args.some((arg) => arg !== "--json" && arg !== "--check")
    || (args.includes("--json") && args.includes("--check"))
  ) {
    throw new Error("Usage: node scripts/app-size-report.mjs [--json | --check]");
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
    console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatHuman(report));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`app-size-report: ${error.message}`);
    process.exitCode = 1;
  });
}
