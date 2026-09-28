// Mach-O detection and codesign invocations shared by the runtime staging
// scripts (Synara, Open Slide, and the bundled Chromium).
import { closeSync, openSync, readSync } from "node:fs";
import { run, walkFiles } from "./util.mjs";

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

/**
 * Every Mach-O file below `root`, sorted. Packages can introduce extensionless
 * binaries such as esbuild, so detect native code rather than maintain a
 * filename list. Links are not followed: pnpm's point back into the same tree,
 * and following them would sign one binary twice.
 */
export function findMachOBinaries(root) {
  return walkFiles(root).filter(isMachO).sort();
}

/** The Developer ID from APPLE_SIGNING_IDENTITY, or null when unset or ad hoc ("-"). */
export function signingIdentity() {
  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  return identity && identity !== "-" ? identity : null;
}

/** Sign with the hardened runtime. An ad-hoc ("-") signature cannot carry a timestamp. */
export function codesign(path, { identity, entitlements, deep = false }) {
  run("/usr/bin/codesign", [
    "--force",
    ...(deep ? ["--deep"] : []),
    "--options",
    "runtime",
    ...(identity === "-" ? [] : ["--timestamp"]),
    ...(entitlements ? ["--entitlements", entitlements] : []),
    "--sign",
    identity,
    path,
  ]);
}

export function verifySignature(path, ...flags) {
  run("/usr/bin/codesign", ["--verify", ...flags, path]);
}
