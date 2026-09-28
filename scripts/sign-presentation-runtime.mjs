#!/usr/bin/env node
// Sign every Mach-O binary in the staged Open Slide runtime with the Developer
// ID in APPLE_SIGNING_IDENTITY (skipped without one). `--list` only prints them.
import { relative, resolve } from "node:path";
import { codesign, findMachOBinaries, signingIdentity, verifySignature } from "./lib/codesign.mjs";
import { projectRoot } from "./lib/util.mjs";

const runtimeRoot = resolve(projectRoot, "src-tauri/presentation-runtime");
const listOnly = process.argv.slice(2).includes("--list");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--list");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument: ${unknownArguments.join(" ")}`);
}

const identity = signingIdentity();
if (!listOnly && !identity) {
  console.log("Skipping presentation runtime signing without APPLE_SIGNING_IDENTITY");
  process.exit(0);
}
if (process.platform !== "darwin") {
  throw new Error("The presentation runtime can only be signed on macOS.");
}
const binaries = findMachOBinaries(runtimeRoot);
if (binaries.length === 0) {
  throw new Error(`No Mach-O binaries found in ${runtimeRoot}`);
}
if (listOnly) {
  for (const path of binaries) console.log(relative(runtimeRoot, path));
  console.log(`Found ${binaries.length} Mach-O binaries`);
} else {
  for (const path of binaries) {
    codesign(path, { identity });
    verifySignature(path, "--strict", "--verbose=2");
  }
  console.log(`Signed ${binaries.length} presentation runtime binaries`);
}
