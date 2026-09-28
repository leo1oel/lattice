// Helpers shared by the build, release, and maintenance scripts.
//
// Nothing that ships inside a bundled runtime may import this file:
// chromium-shell.mjs and chromium-window-policy.mjs are copied into the
// Electron app on their own, so they stay self-contained.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** True when `moduleUrl` (pass `import.meta.url`) is the script Node was asked to run. */
export function isMain(moduleUrl) {
  return Boolean(process.argv[1]) && moduleUrl === pathToFileURL(resolve(process.argv[1])).href;
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Pretty-printed with a trailing newline, the shape every tracked JSON file uses. */
export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Run a command with inherited stdio. */
export function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

/** Run a command and return its stdout as text; stderr is captured into the error. */
export function capture(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // Binary Git patches easily exceed Node's 1 MiB default.
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

/**
 * Every regular file below `root`; [] when it is missing. Symbolic links are
 * skipped, not followed (unlike `readdirSync`'s `recursive` option): in a pnpm
 * or npm tree they point back at files that are already being visited.
 */
export function walkFiles(root, files = []) {
  if (!existsSync(root)) return files;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, files);
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export const treeBytes = (root) => walkFiles(root).reduce((total, path) => total + statSync(path).size, 0);

/** Delete a file or directory tree and return the bytes it held (0 when it is missing). */
export function removePath(path) {
  if (!existsSync(path)) return 0;
  const bytes = statSync(path).isDirectory() ? treeBytes(path) : statSync(path).size;
  rmSync(path, { recursive: true, force: true });
  return bytes;
}
