// One archive pin and checksum source for Synara and the Agent-free Windows host.
import { chmodSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { run, sha256 } from './util.mjs';
const fileSha256 = (path) => sha256(readFileSync(path));

export const NODE_RELEASES = {
  "aarch64-apple-darwin": {
    platform: "darwin-arm64",
    archive: "node-v24.20.0-darwin-arm64.tar.gz",
    sha256: "40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8",
  },
  "x86_64-apple-darwin": {
    platform: "darwin-x64",
    archive: "node-v24.20.0-darwin-x64.tar.gz",
    sha256: "9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4",
  },
  "aarch64-unknown-linux-gnu": {
    platform: "linux-arm64",
    archive: "node-v24.20.0-linux-arm64.tar.gz",
    sha256: "3515603e2487879a39bc75716f1a2affd027500c64ba50e845cf72cb33219013",
  },
  "x86_64-unknown-linux-gnu": {
    platform: "linux-x64",
    archive: "node-v24.20.0-linux-x64.tar.gz",
    sha256: "855d581f8a4eb1a8117e3426de25fe02770592febcfb31369aee1ffbfee9e8ec",
  },
  "x86_64-pc-windows-msvc": {
    platform: "win32-x64",
    archive: "node-v24.20.0-win-x64.zip",
    sha256: "6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba",
  },
};

export function nodeRelease(target, version) {
  const release = NODE_RELEASES[target];
  if (!release || !release.archive.startsWith('node-v' + version + '-')) {
    throw new Error('No verified Node ' + version + ' archive for ' + target);
  }
  return release;
}

async function download(url, output) {
  mkdirSync(dirname(output), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url}: HTTP ${response.status}.`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(output));
}

export async function prepareNodeRuntime(stageRoot, { cacheRoot, target, nodeVersion }) {
  const release = nodeRelease(target, nodeVersion);
  const nodeExecutable = target.includes('windows') ? 'node.exe' : 'node';
  const archive = join(cacheRoot, release.archive);
  if (!existsSync(archive) || fileSha256(archive) !== release.sha256) {
    rmSync(archive, { force: true });
    await download(`https://nodejs.org/dist/v${nodeVersion}/${release.archive}`, archive);
  }
  if (fileSha256(archive) !== release.sha256) {
    rmSync(archive, { force: true });
    throw new Error(`Node ${nodeVersion} failed its SHA-256 check.`);
  }

  const extractionRoot = mkdtempSync(join(cacheRoot, "node-extract-"));
  try {
    if (!release.archive.endsWith(".zip")) {
      run("tar", ["-xzf", archive, "-C", extractionRoot]);
    } else if (process.platform !== "win32") {
      run("unzip", ["-q", archive, "-d", extractionRoot]);
    } else {
      run("tar", ["-xf", archive, "-C", extractionRoot]);
    }
    const extractedRoot = join(extractionRoot, release.archive.replace(/\.tar\.gz$|\.zip$/g, ""));
    mkdirSync(join(stageRoot, "bin"), { recursive: true });
    cpSync(join(extractedRoot, nodeExecutable === "node.exe" ? "node.exe" : "bin/node"), join(stageRoot, "bin", nodeExecutable));
    chmodSync(join(stageRoot, "bin", nodeExecutable), 0o755);
    mkdirSync(join(stageRoot, "licenses"), { recursive: true });
    cpSync(join(extractedRoot, "LICENSE"), join(stageRoot, "licenses/Node-LICENSE.txt"));
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}
