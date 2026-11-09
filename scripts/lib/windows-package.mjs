import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./util.mjs";

export function windowsAssetNames(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("Invalid package version");
  const stem = `Lattice_${version}_windows-x64-experimental`;
  return { installer: `${stem}-setup.exe`, checksum: `${stem}.sha256`, metadata: `${stem}.build-info.json`, instructions: `${stem}.README.txt` };
}

// A workflow_run is privileged only when it follows this repository's own
// successful tag release. Manual and PR builds are downloadable artifacts only.
export function releaseSource(event, repository) {
  const run = event.workflow_run;
  if (repository !== "leo1oel/lattice" || event.repository?.full_name !== repository
    || run?.head_repository?.full_name !== repository || run.name !== "Release"
    || run.event !== "push" || run.conclusion !== "success"
    || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(run.head_branch ?? "")
    || !/^[a-f0-9]{40}$/.test(run.head_sha ?? "")) {
    throw new Error("Not a successful upstream tag release");
  }
  return { tag: run.head_branch, sha: run.head_sha, version: run.head_branch.slice(1) };
}

export function checkWindowsPackage(directory, expected) {
  const names = windowsAssetNames(expected.version);
  const info = JSON.parse(readFileSync(join(directory, names.metadata), "utf8"));
  if (info.version !== expected.version || info.sourceCommit !== expected.sha
    || info.target !== "x86_64-pc-windows-msvc" || info.experimental !== true
    || info.agentAvailable !== false || info.autoUpdate !== false || info.unsigned !== true) {
    throw new Error("Windows package provenance or feature policy does not match");
  }
  const bytes = readFileSync(join(directory, names.installer));
  if (bytes.subarray(0, 2).toString() !== "MZ") throw new Error("Installer is not a Windows executable");
  const digest = sha256(bytes);
  if (info.sha256 !== digest
    || readFileSync(join(directory, names.checksum), "utf8").trim() !== `${digest}  ${names.installer}`) {
    throw new Error("Windows installer checksum does not match");
  }
  const instructions = readFileSync(join(directory, names.instructions), "utf8");
  if (!instructions.includes("SmartScreen") || !instructions.includes("unsigned")) throw new Error("Missing unsigned-build instructions");
  return names;
}
