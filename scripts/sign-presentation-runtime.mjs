#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readSync,
  readdirSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MACH_O_MAGICS = new Set([
  "feedface", // 32-bit
  "cefaedfe",
  "feedfacf", // 64-bit
  "cffaedfe",
  "cafebabe", // universal
  "bebafeca",
  "cafebabf", // universal 64-bit
  "bfbafeca",
]);

export function isMachO(path) {
  const descriptor = openSync(path, "r");
  try {
    const magic = Buffer.allocUnsafe(4);
    if (readSync(descriptor, magic, 0, magic.length, 0) !== magic.length) return false;
    return MACH_O_MAGICS.has(magic.toString("hex"));
  } finally {
    closeSync(descriptor);
  }
}

export function findMachOBinaries(root) {
  if (!existsSync(root)) return [];
  const binaries = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && isMachO(path)) binaries.push(path);
      // pnpm's links point back into this same tree, whose real files are
      // visited above. Do not follow links and sign the same binary twice.
    }
  };
  visit(root);
  return binaries.sort();
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = resolve(projectRoot, "src-tauri/presentation-runtime");
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const listOnly = process.argv.slice(2).includes("--list");
  const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--list");
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown argument: ${unknownArguments.join(" ")}`);
  }

  const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  if (!listOnly && (!signingIdentity || signingIdentity === "-")) {
    console.log("Skipping presentation runtime signing without APPLE_SIGNING_IDENTITY");
  } else {
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
        execFileSync("/usr/bin/codesign", [
          "--force",
          "--options",
          "runtime",
          "--timestamp",
          "--sign",
          signingIdentity,
          path,
        ], { stdio: "inherit" });
        execFileSync(
          "/usr/bin/codesign",
          ["--verify", "--strict", "--verbose=2", path],
          { stdio: "inherit" },
        );
      }
      console.log(`Signed ${binaries.length} presentation runtime binaries`);
    }
  }
}
