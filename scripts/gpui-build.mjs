#!/usr/bin/env node
/**
 * `node scripts/gpui-build.mjs`: builds the GPUI app (by default the release
 * build with `offscreen-shots`, which `gpui/script/e2e` runs) in one build
 * tree this machine shares, then copies the binary back into this checkout's
 * `gpui/target/<profile>/lattice-gpui`. Nothing it needs is installed by
 * pnpm, so it runs in a checkout without node_modules.
 *
 * A checkout's own `cargo build --release` started cold in every new worktree
 * (5.5 minutes on an idle machine, far longer beside other builds; agents in
 * the no-mistakes test step backgrounded it and ran out of time), and
 * sccache could not help across checkouts: for Rust it hashes the compile's
 * working directory and every `CARGO_*` variable, `SCCACHE_BASEDIRS` applies
 * only to C and C++, and each checkout's paths are different. GPUI itself is a
 * path crate here (`gpui/patches/`), so every Zed crate built on it missed
 * too. In the shared tree every checkout builds from the same paths, so Cargo
 * rebuilds only what changed since the last build there, whichever checkout
 * ran it, and sccache serves what a branch switch there undoes.
 *
 * Each run, under the machine-wide GPUI lock (scripts/lib/gpui-lock.mjs):
 *
 *   1. mirrors this checkout's files (`git ls-files`: tracked and untracked,
 *      not ignored, with uncommitted edits) into the shared tree; a file whose
 *      content changed gets a new mtime, an unchanged one keeps its mtime
 *      (scripts/lib/mirror-tree.mjs);
 *   2. fetches PDFium there (`gpui/script/fetch-pdfium`), which the binary
 *      finds next to the tree it was built in;
 *   3. runs `cargo <args>` in its gpui/, with CARGO_BUILD_JOBS=4 unless set;
 *   4. after a `cargo build` of the GPUI workspace, copies `lattice-gpui` back
 *      into this checkout.
 *
 * Validation runs (the no-mistakes pipeline's run worktrees, `pnpm signoff`)
 * send every cargo command that compiles through here, whether build, check,
 * clippy or test, for the Tauri crates as well as for gpui/. A worktree's own
 * `cargo test` or `cargo clippy` in gpui/ wrote an 8-10 GB gpui/target, and
 * one in src-tauri/ a 2-3 GB src-tauri/target, from cold, in every run
 * worktree; through here the run worktree keeps only the copied-back binary
 * (about 200 MB) and the shared tree's targets are the only ones that grow.
 * A `--manifest-path` (relative to where this was started) is rewritten to the
 * same file in the shared tree, so `-- clippy --manifest-path
 * src-tauri/Cargo.toml` checks the Tauri crates there, in their own
 * src-tauri/target. Since Cargo.toml paths are the shared tree's, every
 * checkout's build of a crate lands on the same artifacts; the lock keeps a
 * second checkout from mirroring its sources over a build still running, and
 * each run compiles exactly the sources it mirrored. The Tauri crates need
 * only a stub for the bundled Synara runtime (docs/synara-runtime.md), which
 * this creates in the shared tree.
 *
 * The shared tree is `$LATTICE_GPUI_BUILD_DIR/lattice` (default
 * ~/Library/Caches/lattice-gpui-build on macOS, ~/.cache/lattice-gpui-build
 * elsewhere). It is a cache: delete the directory to start over.
 *
 * Usage:
 *   node scripts/gpui-build.mjs                  release build, offscreen-shots
 *   node scripts/gpui-build.mjs -- test --release --locked --workspace \
 *     --features lattice-gpui/offscreen-shots -- --include-ignored
 *                                                any other cargo command there
 *   node scripts/gpui-build.mjs -- clippy --manifest-path src-tauri/Cargo.toml \
 *     --all-targets -- -D warnings                the Tauri crates, there
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireGpuiLock, releaseGpuiLock } from "./lib/gpui-lock.mjs";
import { mirrorTree } from "./lib/mirror-tree.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ARGS = ["build", "--release", "--locked", "--features", "lattice-gpui/offscreen-shots"];

function buildRoot() {
  if (process.env.LATTICE_GPUI_BUILD_DIR) return path.resolve(process.env.LATTICE_GPUI_BUILD_DIR);
  const cache = process.platform === "darwin" ? path.join(os.homedir(), "Library", "Caches") : (process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"));
  return path.join(cache, "lattice-gpui-build");
}

/** The directory under target/ a cargo command writes to. */
function profileDir(args) {
  const profile = args.indexOf("--profile");
  if (profile >= 0) return args[profile + 1] === "dev" ? "debug" : args[profile + 1];
  const inline = args.find((arg) => arg.startsWith("--profile="));
  if (inline) return inline.slice("--profile=".length) === "dev" ? "debug" : inline.slice("--profile=".length);
  return args.includes("--release") || args.includes("-r") ? "release" : "debug";
}

/**
 * Points a `--manifest-path` at the same file in the shared tree: relative to
 * the directory this was started in, which must be inside the checkout. Only
 * arguments before a bare `--` are cargo's; the rest belong to the test binary
 * or the lint driver. Returns the rewritten arguments and whether they name a
 * manifest outside the shared tree's gpui/ (no binary to copy back then).
 */
function sharedManifest(args, tree) {
  const end = args.indexOf("--") >= 0 ? args.indexOf("--") : args.length;
  let elsewhere = false;
  const map = (value) => {
    const relative = path.relative(repo, path.resolve(value));
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`--manifest-path ${value} is outside ${repo}`);
    if (!relative.startsWith(`gpui${path.sep}`)) elsewhere = true;
    return path.join(tree, relative);
  };
  const out = args.map((arg, index) => {
    if (index >= end) return arg;
    if (arg.startsWith("--manifest-path=")) return `--manifest-path=${map(arg.slice("--manifest-path=".length))}`;
    if (index > 0 && args[index - 1] === "--manifest-path") return map(arg);
    return arg;
  });
  return { args: out, elsewhere };
}

function seconds(since) {
  return `${((Date.now() - since) / 1000).toFixed(0)} s`;
}

/**
 * Runs cargo without blocking the event loop, so a SIGTERM or Ctrl-C reaches
 * the lock module's handler at once, and stops cargo on the way out rather
 * than leaving it building in the shared tree after the lock is released.
 */
function runCargo(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn("cargo", args, { ...options, stdio: "inherit" });
    const stop = () => child.exitCode === null && child.kill("SIGTERM");
    process.on("exit", stop);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      process.off("exit", stop);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function main() {
  const separator = process.argv.indexOf("--");
  const givenArgs = separator >= 0 ? process.argv.slice(separator + 1) : DEFAULT_ARGS;
  if (separator < 0 && process.argv.length > 2) throw new Error(`unknown option ${process.argv[2]}; pass cargo arguments after --`);
  if (givenArgs.length === 0) throw new Error("no cargo arguments after --");

  const root = buildRoot();
  const tree = path.join(root, "lattice");
  mkdirSync(tree, { recursive: true });
  const { args: cargoArgs, elsewhere } = sharedManifest(givenArgs, tree);

  await acquireGpuiLock(repo);
  try {
    let started = Date.now();
    const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
    const { written, deleted } = mirrorTree(repo, tree, files, path.join(root, "manifest.json"));
    console.log(`gpui-build: mirrored ${repo} into ${tree} (${written} written, ${deleted} deleted, ${seconds(started)})`);

    const gpui = path.join(tree, "gpui");
    const fetched = spawnSync(path.join(gpui, "script", "fetch-pdfium"), [], { cwd: gpui, stdio: "inherit" });
    if (fetched.status !== 0) throw new Error("gpui/script/fetch-pdfium failed in the shared tree");
    // Ignored, so the mirror never writes or deletes it; Tauri's resource
    // manifest only needs the directory to exist.
    const synara = path.join(tree, "src-tauri", "synara-runtime");
    if (!existsSync(synara)) {
      mkdirSync(synara, { recursive: true });
      writeFileSync(path.join(synara, "placeholder.txt"), "");
    }

    // The shared tree's own target/, whatever this shell points Cargo at.
    const env = { ...process.env, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? "4" };
    delete env.CARGO_TARGET_DIR;
    delete env.CARGO_BUILD_TARGET_DIR;
    started = Date.now();
    console.log(`gpui-build: cargo ${cargoArgs.join(" ")} (in ${gpui})`);
    const status = await runCargo(cargoArgs, { cwd: gpui, env });
    if (status !== 0) {
      process.exitCode = status;
      console.error(`gpui-build: cargo failed after ${seconds(started)}`);
      return;
    }
    console.log(`gpui-build: cargo finished in ${seconds(started)}`);

    if ((cargoArgs[0] === "build" || cargoArgs[0] === "b") && !elsewhere) {
      const profile = profileDir(cargoArgs);
      const built = path.join(gpui, "target", profile, "lattice-gpui");
      if (!existsSync(built)) throw new Error(`${built} is missing after the build`);
      const dest = path.join(repo, "gpui", "target", profile, "lattice-gpui");
      mkdirSync(path.dirname(dest), { recursive: true });
      // Through a temporary name: a running copy of the old binary keeps its
      // file, and nothing ever sees a half-copied one.
      const temporary = `${dest}.gpui-build-tmp`;
      copyFileSync(built, temporary);
      chmodSync(temporary, 0o755);
      renameSync(temporary, dest);
      console.log(`gpui-build: ${dest}`);
    }
  } finally {
    releaseGpuiLock();
  }
}

await main().catch((error) => {
  console.error(`gpui-build: ${error.message}`);
  process.exit(1);
});
