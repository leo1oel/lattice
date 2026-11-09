// Windows needs Node for Open Slide, but cannot run the guarded Synara Agent.
// Keep the resource location the host already resolves, with no server stub.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { prepareNodeRuntime } from "./lib/node-runtime.mjs";
import { isMain, projectRoot, readJson, writeJson } from "./lib/util.mjs";

export async function prepareWindowsRuntime() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The experimental Windows package requires Windows x64.");
  }
  const { nodeVersion } = readJson(join(projectRoot, "scripts/synara-runtime.json"));
  const target = "x86_64-pc-windows-msvc";
  const destination = join(projectRoot, "src-tauri/synara-runtime");
  const stage = mkdtempSync(join(projectRoot, "src-tauri/.windows-runtime-"));
  const cacheRoot = join(projectRoot, "node_modules/.cache/lattice/node");
  mkdirSync(cacheRoot, { recursive: true });
  try {
    await prepareNodeRuntime(stage, { cacheRoot, target, nodeVersion });
    const version = execFileSync(join(stage, "bin/node.exe"), ["--version"], { encoding: "utf8", windowsHide: true }).trim();
    if (version !== `v${nodeVersion}`) throw new Error(`Unexpected bundled Node version: ${version}`);
    writeJson(join(stage, "manifest.json"), { target, nodeVersion, nodeRuntime: "standalone", agentAvailable: false });
    rmSync(destination, { recursive: true, force: true });
    renameSync(stage, destination);
    console.log(`Prepared Node ${nodeVersion} for Windows; the embedded Agent remains disabled.`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) await prepareWindowsRuntime();
