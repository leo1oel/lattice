// Build the pinned Synara checkout and stage its server, a standalone Node
// runtime, and the production dependencies into src-tauri/synara-runtime/,
// which tauri.conf.json bundles whole.
//
//   node scripts/prepare-synara-sidecar.mjs [--allow-dirty]
//
// The source is scripts/synara-runtime.json's `sourceDirectory` unless
// SYNARA_SOURCE_DIR names another checkout. --allow-dirty accepts uncommitted
// changes and a revision other than the pin (development builds only).
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { codesign, signMachOTree, signingIdentity } from "./lib/codesign.mjs";
import { pruneServerRuntime } from "./lib/synara-server-prune.mjs";
import { capture, projectRoot, readJson, run, sha256, treeBytes, walkFiles, writeJson } from "./lib/util.mjs";
import { SYNARA_RUNTIME_INPUTS } from "./synara-runtime-inputs.mjs";
import { patchCodexHostProcess } from "./synara-codex-host.mjs";

const runtimeConfig = readJson(join(projectRoot, "scripts/synara-runtime.json"));
const allowDirty = process.argv.includes("--allow-dirty");
const sourceRoot = resolve(projectRoot, process.env.SYNARA_SOURCE_DIR?.trim() || runtimeConfig.sourceDirectory);
const runtimeRoot = join(projectRoot, "src-tauri/synara-runtime");
const cacheRoot = join(projectRoot, "node_modules/.cache/lattice/synara");
const npmCache = join(projectRoot, "node_modules/.cache/lattice/npm");
const bibtexTidyVersion = "1.15.1";
const bibtexTidySha256 = "bea5fb60947053fe6b46efb62fdd5944f8a8be3420c0163b0cf987032b7bb2b4";
const deviceHelperFiles = [
  "build.sh",
  "device-helper.sb",
  "Sources/DeviceHelper-Bridging-Header.h",
  "Sources/main.swift",
];

// Per host triple: the npm platform directory prebuilt packages use, and the
// pinned Node release archive with its SHA-256.
const TARGETS = {
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

const git = (args) => capture("git", args, { cwd: sourceRoot }).trim();
const fileSha256 = (path) => sha256(readFileSync(path));

/**
 * Fingerprint the Synara checkout, optionally ignoring some paths.
 *
 * `excluded` narrows the fingerprint to a subset of the tree so one workspace's
 * edits do not invalidate another's build (see webFingerprint below).
 */
function sourceFingerprint(head, excluded = []) {
  const pathspec = excluded.length > 0
    ? ["--", ".", ...excluded.map((path) => `:(exclude)${path}`)]
    : [];
  // Scoped to the same pathspec as the diff below: a status line from an
  // excluded path must not perturb the fingerprint.
  const dirtyStatus = git(["status", "--short", ...pathspec]);
  const hash = createHash("sha256").update(head).update("\0").update(dirtyStatus);
  for (const path of excluded) hash.update("\0!").update(path);
  if (dirtyStatus) {
    hash.update(capture("git", ["diff", "--binary", "HEAD", ...pathspec], { cwd: sourceRoot }));
    const untracked = git(["ls-files", "--others", "--exclude-standard", ...pathspec])
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean)
      .sort();
    for (const path of untracked) {
      hash.update("\0").update(path).update("\0").update(readFileSync(join(sourceRoot, path)));
    }
  }
  return hash.digest("hex");
}

// A candidate counts only if it runs: pnpm 10 skips dependency install scripts
// unless package.json allowlists them, and an unbuilt bun package leaves a
// node_modules/.bin/bun stub that exists but exits with "Bun's postinstall
// script was not run", which would otherwise shadow a working bun on PATH.
function runsBun(candidate) {
  try {
    capture(candidate, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function resolveBun() {
  const configured = process.env.BUN_BIN?.trim();
  const local = join(projectRoot, "node_modules/.bin", process.platform === "win32" ? "bun.exe" : "bun");
  if (configured && existsSync(configured) && runsBun(configured)) return configured;
  if (existsSync(local) && runsBun(local)) return local;
  try {
    return capture(process.platform === "win32" ? "where" : "which", ["bun"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "Bun is required to build Synara. Install dependencies or set BUN_BIN to a Bun 1.4.2 or newer executable.",
    );
  }
}

function deviceHelperTreeMatches(source, candidate) {
  if (!deviceHelperFiles.every((path) => existsSync(join(candidate, path)))) return false;
  if (!target.startsWith("x86_64-pc-windows") && (statSync(join(candidate, "build.sh")).mode & 0o111) === 0) {
    return false;
  }
  const relativeFiles = (root) => walkFiles(root).map((path) => relative(root, path)).sort();
  const sourceFiles = relativeFiles(source);
  const candidateFiles = relativeFiles(candidate);
  return (
    sourceFiles.length > 0 &&
    sourceFiles.length === candidateFiles.length &&
    sourceFiles.every(
      (path, index) =>
        path === candidateFiles[index] &&
        readFileSync(join(source, path)).equals(readFileSync(join(candidate, path))),
    )
  );
}

async function download(url, output) {
  mkdirSync(dirname(output), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url}: HTTP ${response.status}.`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(output));
}

async function prepareNodeRuntime(stageRoot) {
  const archive = join(cacheRoot, release.archive);
  if (!existsSync(archive) || fileSha256(archive) !== release.sha256) {
    rmSync(archive, { force: true });
    await download(`https://nodejs.org/dist/v${runtimeConfig.nodeVersion}/${release.archive}`, archive);
  }
  if (fileSha256(archive) !== release.sha256) {
    rmSync(archive, { force: true });
    throw new Error(`Node ${runtimeConfig.nodeVersion} failed its SHA-256 check.`);
  }

  const extractionRoot = mkdtempSync(join(cacheRoot, "node-extract-"));
  try {
    if (!release.archive.endsWith(".zip")) {
      run("tar", ["-xzf", archive, "-C", extractionRoot]);
    } else if (process.platform !== "win32") {
      run("unzip", ["-q", archive, "-d", extractionRoot]);
    } else {
      const quote = (path) => `'${path.replaceAll("'", "''")}'`;
      run("powershell", [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(extractionRoot)} -Force`,
      ]);
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

// Pi and OpenCode are left out of the bundle: the fork installs one on demand, from the
// integrity-pinned lockfile in apps/server/providerRuntimes/<runtime>/, when the user
// picks that provider (apps/server/src/provider/providerRuntimes.ts). Together with
// their trees they were roughly half of the staged runtime.
const OPTIONAL_PROVIDER_RUNTIMES = ["pi", "opencode"];

/**
 * The packages each optional runtime installs, checked against the versions Synara is
 * built with: an on-demand install of a different release than bun.lock's would load
 * an adapter against an API it was never compiled or tested with.
 */
function optionalRuntimePackages() {
  const lockfile = readFileSync(join(sourceRoot, "bun.lock"), "utf8");
  const packages = new Set();
  for (const runtime of OPTIONAL_PROVIDER_RUNTIMES) {
    const directory = join(sourceRoot, "apps/server/providerRuntimes", runtime);
    const lock = readJson(join(directory, "package-lock.json"));
    for (const name of Object.keys(readJson(join(directory, "package.json")).dependencies)) {
      const escaped = name.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&");
      const built = new RegExp(`^\\s*"${escaped}": \\["${escaped}@([^"]+)"`, "m").exec(lockfile)?.[1];
      const installed = lock.packages[`node_modules/${name}`]?.version;
      if (!built || built !== installed) {
        throw new Error(
          `The ${runtime} runtime lockfile installs ${name} ${installed ?? "(missing)"}, but Synara builds against ${built ?? "(missing)"}. `
            + "Run node apps/server/providerRuntimes/update-lockfiles.mjs in the Synara checkout.",
        );
      }
      packages.add(name);
    }
  }
  return packages;
}

function resolveServerDependencies() {
  const catalog = readJson(join(sourceRoot, "package.json")).workspaces?.catalog ?? {};
  const serverPackage = readJson(join(sourceRoot, "apps/server/package.json"));
  const optional = optionalRuntimePackages();
  const dependencies = {};
  for (const [name, version] of Object.entries(serverPackage.dependencies ?? {})) {
    if (optional.has(name)) continue;
    if (version === "catalog:") {
      const catalogVersion = catalog[name];
      if (typeof catalogVersion !== "string" || !catalogVersion) {
        throw new Error(`Synara catalog does not define ${name}.`);
      }
      dependencies[name] = catalogVersion;
    } else if (typeof version === "string" && version.startsWith("workspace:")) {
      throw new Error(`Unexpected runtime workspace dependency ${name}: ${version}.`);
    } else {
      dependencies[name] = version;
    }
  }
  return { serverPackage, dependencies };
}

// Runs the tool on the standalone Node next to this launcher.
const BIBTEX_TIDY_LAUNCHER = `#!/bin/sh
set -eu
bin_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
runtime_dir="$(dirname -- "$bin_dir")"
tool="$runtime_dir/tools/bibtex-tidy.mjs"
if [ -x "$bin_dir/node" ]; then
  exec "$bin_dir/node" "$tool" "$@"
fi
echo "Lattice's bundled JavaScript runtime is unavailable." >&2
exit 127
`;

function installServerRuntime(stageRoot) {
  const { serverPackage, dependencies } = resolveServerDependencies();
  // bibcite is a Python CLI, but its canonical formatter is the Node-based
  // bibtex-tidy executable. Ship an exact version beside the JavaScript runtime
  // Lattice already owns so paper imports never depend on a user's Node/npm.
  dependencies["bibtex-tidy"] = bibtexTidyVersion;
  const serverRoot = join(stageRoot, "server");
  mkdirSync(serverRoot, { recursive: true });
  cpSync(join(sourceRoot, "apps/server/dist"), join(serverRoot, "dist"), { recursive: true });
  writeJson(join(serverRoot, "package.json"), {
    name: "@lattice/synara-runtime",
    private: true,
    version: serverPackage.version,
    type: "module",
    engines: serverPackage.engines,
    dependencies,
  });
  mkdirSync(npmCache, { recursive: true });
  run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "--omit=dev", "--package-lock=false", "--no-audit", "--no-fund"],
    { cwd: serverRoot, env: { ...process.env, npm_config_cache: npmCache } },
  );
  const installedVersion = readJson(join(serverRoot, "node_modules/bibtex-tidy/package.json")).version;
  if (installedVersion !== bibtexTidyVersion) {
    throw new Error(`Installed bibtex-tidy ${installedVersion} instead of ${bibtexTidyVersion}.`);
  }
  const installedBin = join(serverRoot, "node_modules/bibtex-tidy/bin/bibtex-tidy");
  if (fileSha256(installedBin) !== bibtexTidySha256) {
    throw new Error(`bibtex-tidy ${bibtexTidyVersion} failed its SHA-256 check.`);
  }
  mkdirSync(join(stageRoot, "bin"), { recursive: true });
  mkdirSync(join(stageRoot, "tools"), { recursive: true });
  cpSync(installedBin, join(stageRoot, "tools/bibtex-tidy.mjs"));
  writeFileSync(join(stageRoot, "bin/bibtex-tidy"), BIBTEX_TIDY_LAUNCHER);
  chmodSync(join(stageRoot, "bin/bibtex-tidy"), 0o755);
  writeFileSync(
    join(stageRoot, "bin/bibtex-tidy.cmd"),
    "@echo off\r\n\"%~dp0node.exe\" \"%~dp0..\\tools\\bibtex-tidy.mjs\" %*\r\n",
  );
  const bundle = join(serverRoot, "dist/index.mjs");
  writeFileSync(bundle, patchCodexHostProcess(silenceExpectedSessionProbeWarnings(readFileSync(bundle, "utf8"))));
  mkdirSync(join(stageRoot, "licenses"), { recursive: true });
  cpSync(join(sourceRoot, "LICENSE"), join(stageRoot, "licenses/Synara-MIT.txt"));
  return serverPackage.version;
}

// The one thing the desktop app hands the runtime is a bare token — two UUIDs
// with nothing between them (SYNARA_AUTH_TOKEN in synara.rs). On loopback the
// runtime authorises that directly, comparing it to its configured token, so
// the agent works. But the session verifier expects `payload.signature` and
// splits on ".", so anything that also offers the bare token there is rejected
// as "Malformed session token." — and the caller, a routine "am I signed in?"
// probe, treats that as its normal answer and carries on.
//
// The layer underneath logs a warning every time regardless. At roughly two a
// second that was 90% of a 6 MB sidecar.log, which never rotates, burying the
// lines that do mean something.
//
// So drop the log for that one reason and leave every other rejection —
// notably a bad signature — logged as before.
function silenceExpectedSessionProbeWarnings(source) {
  const probe = 'Effect.tapError((cause) => Effect.logWarning("Rejected authenticated session credential.")';
  const quiet = 'Effect.tapError((cause) => (cause.message === "Malformed session token." ? Effect.void : Effect.logWarning("Rejected authenticated session credential."))';
  const count = source.split(probe).length - 1;
  if (count !== 1) {
    // Loud on purpose: a runtime bump that reshapes this must be re-checked,
    // not silently left unpatched or patched twice.
    throw new Error(
      `Expected exactly one session-rejection log site in the Synara bundle, found ${count}. `
        + "Re-check silenceExpectedSessionProbeWarnings against the pinned runtime.",
    );
  }
  return source.replace(probe, quiet);
}

/**
 * The Claude adapter and its health check both execute the user's `claude`
 * command (or the path selected in Provider settings). The Agent SDK still
 * installs its own 200+ MB optional CLI because one account-metadata fallback
 * lets the SDK resolve its default executable. Preserve that fallback with a
 * PATH launcher rather than shipping a second Claude installation that turns
 * never use.
 */
function replaceUnusedClaudeBinary(stageRoot) {
  if (target === "x86_64-pc-windows-msvc") return 0;
  const executable = join(
    stageRoot,
    "server/node_modules/@anthropic-ai",
    `claude-agent-sdk-${release.platform}`,
    "claude",
  );
  if (!existsSync(executable)) {
    throw new Error(`The Claude Agent SDK platform executable is missing at ${executable}.`);
  }
  const originalBytes = statSync(executable).size;
  const launcher = "#!/bin/sh\nexec claude \"$@\"\n";
  writeFileSync(executable, launcher);
  chmodSync(executable, 0o755);
  return Math.max(0, originalBytes - Buffer.byteLength(launcher));
}

/**
 * The official Node binary keeps its local symbol table, about a fifth of the
 * file. Nothing reads it while Node runs: dyld binds addons (node-pty) through
 * the export trie, which `strip -x` keeps together with every global symbol;
 * the local names only label native frames in a debugger or crash report.
 * Stripping drops Node's signature, so restore an ad hoc one for development
 * staging (arm64 refuses unsigned code); releases re-sign with the Developer ID
 * below.
 */
function stripNodeSymbols(stageRoot) {
  if (!target.endsWith("-apple-darwin")) return 0;
  const node = join(stageRoot, "bin", nodeExecutable);
  const before = statSync(node).size;
  run("/usr/bin/strip", ["-x", node]);
  if (!signingIdentity()) {
    codesign(node, { identity: "-", entitlements: join(projectRoot, "src-tauri/Entitlements.plist") });
  }
  return before - statSync(node).size;
}

function restoreHelperExecutableBits(stageRoot) {
  if (target.startsWith("x86_64-pc-windows")) return;
  chmodSync(join(stageRoot, "server/dist/device-helper/build.sh"), 0o755);
  // bun installs package prebuilds without their executable bit, and only the
  // signing pass below (skipped without APPLE_SIGNING_IDENTITY) used to put it
  // back. node-pty execs spawn-helper for every PTY, so a dev-staged runtime
  // shipped a helper the kernel refuses to run: every agent turn that touches
  // a terminal dies with posix_spawnp failure.
  for (const path of walkFiles(stageRoot)) {
    if (basename(path) === "spawn-helper") chmodSync(path, 0o755);
  }
}

function signMacRuntime(stageRoot) {
  const identity = signingIdentity();
  if (!target.endsWith("-apple-darwin") || !identity) return;
  signMachOTree(stageRoot, { identity, entitlements: join(projectRoot, "src-tauri/Entitlements.plist") });
}

/**
 * Run a workspace's own `build` script.
 *
 * This used to call `bun run --filter <package> build` from the repository
 * root. On some Bun builds that prints `bun run` usage and exits 0 without
 * running anything, so preparation silently continued and staged whatever
 * `dist` happened to be left on disk -- a release could ship code months older
 * than the pinned revision while the manifest reported the pin. Resolving the
 * command from the workspace and running it directly removes that failure mode.
 */
function buildWorkspace(workspaceDirectory, bun) {
  const workspaceRoot = join(sourceRoot, workspaceDirectory);
  const manifest = readJson(join(workspaceRoot, "package.json"));
  const command = manifest.scripts?.build;
  if (!command) {
    throw new Error(`${manifest.name ?? workspaceDirectory} does not define a build script.`);
  }
  console.log(`Building ${manifest.name ?? workspaceDirectory}: ${command}`);
  const PATH = [
    join(workspaceRoot, "node_modules/.bin"),
    join(sourceRoot, "node_modules/.bin"),
    dirname(bun),
    process.env.PATH ?? "",
  ].join(delimiter);
  const [shell, flag] = process.platform === "win32" ? ["cmd", "/c"] : ["sh", "-c"];
  run(shell, [flag, command], { cwd: workspaceRoot, env: { ...process.env, PATH } });
}

// ---------------------------------------------------------------------------

if (!existsSync(join(sourceRoot, ".git"))) {
  throw new Error(
    `Synara source is missing at ${sourceRoot}. Clone ${runtimeConfig.repository} there or set SYNARA_SOURCE_DIR.`,
  );
}

const target = capture("rustc", ["-vV"]).match(/^host:\s*(.+)$/m)?.[1];
const release = target ? TARGETS[target] : null;
if (!target || !release) {
  throw new Error(`The bundled Synara runtime is not configured for ${target ?? "this target"}.`);
}
if (!release.archive.includes(runtimeConfig.nodeVersion)) {
  throw new Error("The pinned Node version and archive map are out of sync.");
}
const nodeExecutable = target.includes("windows") ? "node.exe" : "node";

const head = git(["rev-parse", "HEAD"]);
const dirtyStatus = git(["status", "--short"]);
if (!allowDirty && dirtyStatus) {
  throw new Error(
    "Synara has uncommitted changes. Commit them to the maintained fork before building a release.",
  );
}
if (!allowDirty && head !== runtimeConfig.revision) {
  throw new Error(
    `Synara is at ${head}, but Lattice pins ${runtimeConfig.revision}. Update scripts/synara-runtime.json intentionally after syncing and validating upstream.`,
  );
}

// Everything that decides what gets staged: the pin, the host, the source
// tree, and the repository files listed in SYNARA_RUNTIME_INPUTS (this script
// with every module it stages through).
const buildKeyHash = createHash("sha256")
  .update(JSON.stringify(runtimeConfig))
  .update(target)
  .update(sourceFingerprint(head));
for (const input of SYNARA_RUNTIME_INPUTS) {
  buildKeyHash.update(readFileSync(resolve(projectRoot, input)));
}
const buildKey = buildKeyHash.digest("hex");
const sourceDeviceHelperRoot = join(sourceRoot, "apps/server/native/device-helper");
const existingManifestPath = join(runtimeRoot, "manifest.json");
if (existsSync(existingManifestPath)) {
  const existingManifest = readJson(existingManifestPath);
  const stagedFiles = [
    `bin/${nodeExecutable}`,
    "bin/bibtex-tidy",
    "tools/bibtex-tidy.mjs",
    "server/dist/index.mjs",
    "server/dist/client/index.html",
  ];
  if (
    existingManifest.buildKey === buildKey &&
    existingManifest.nodeRuntime === "standalone" &&
    existingManifest.nodeVersion === runtimeConfig.nodeVersion &&
    existingManifest.bibtexTidyVersion === bibtexTidyVersion &&
    stagedFiles.every((path) => existsSync(join(runtimeRoot, path))) &&
    deviceHelperTreeMatches(sourceDeviceHelperRoot, join(runtimeRoot, "server/dist/device-helper"))
  ) {
    // Release-cache.yml stores the prepared runtime unsigned so every release
    // can apply its current Developer ID certificate after restoring it.
    // Re-signing is also required after a certificate rotation even though the
    // source-derived build key is unchanged.
    signMacRuntime(runtimeRoot);
    console.log(`Synara runtime ${existingManifest.synaraVersion} is already prepared for ${target}.`);
    process.exit(0);
  }
}

const bun = resolveBun();

/**
 * Reuse the previous `apps/web` build when nothing outside `apps/server` moved.
 *
 * The web build is the slow half (a full Vite production build) and the server
 * build copies `apps/web/dist` into `dist/client` on every run, so a hit here
 * still stages the client. The fingerprint deliberately covers the whole
 * checkout minus `apps/server`: root configs, the lockfile, and shared
 * workspace packages all feed the web bundle. The reverse skip is not safe —
 * the server bundles the web output, so it rebuilds whenever anything does.
 */
const webBuildCachePath = join(cacheRoot, "web-build.json");
const webArtifact = join(sourceRoot, "apps/web/dist/index.html");
const webBuildKey = createHash("sha256")
  .update(sourceFingerprint(head, ["apps/server"]))
  .update("\0")
  .update(JSON.stringify(runtimeConfig))
  .digest("hex");

function cachedWebBuildKey() {
  if (!existsSync(webBuildCachePath) || !existsSync(webArtifact)) return null;
  try {
    return readJson(webBuildCachePath).webBuildKey ?? null;
  } catch {
    return null;
  }
}

const buildStartedAt = Date.now();
if (cachedWebBuildKey() === webBuildKey) {
  console.log("Reusing the existing Synara web build (no change outside apps/server).");
} else {
  mkdirSync(cacheRoot, { recursive: true });
  rmSync(webBuildCachePath, { force: true });
  buildWorkspace("apps/web", bun);
  if (!existsSync(webArtifact)) {
    throw new Error("The Synara web build did not produce apps/web/dist/index.html.");
  }
  writeJson(webBuildCachePath, { webBuildKey });
}
buildWorkspace("apps/server", bun);

// Device input, accessibility, and video use a native helper compiled against
// the user's Xcode on first attach. The server build must stage its sources
// beside the bundle; otherwise the pane appears normally but attach fails only
// in the packaged app, where the repository fallback path does not exist.
if (!deviceHelperTreeMatches(sourceDeviceHelperRoot, join(sourceRoot, "apps/server/dist/device-helper"))) {
  throw new Error(
    "The Synara build did not stage the complete iOS device helper source tree under apps/server/dist/device-helper.",
  );
}

// Belt and braces: even with a working build command, refuse to stage artifacts
// the build did not just write. Staging stale bytes under a fresh revision is
// far worse than failing here.
for (const artifact of ["apps/server/dist/index.mjs", "apps/server/dist/client/index.html"]) {
  const artifactPath = join(sourceRoot, artifact);
  if (!existsSync(artifactPath)) {
    throw new Error(`The Synara build did not produce ${artifact}.`);
  }
  if (statSync(artifactPath).mtimeMs < buildStartedAt) {
    throw new Error(
      `${artifact} was not rewritten by the build, so the staged runtime would ship stale code. ` +
        `Check that the workspace build command actually ran.`,
    );
  }
}

mkdirSync(cacheRoot, { recursive: true });
const stageRoot = mkdtempSync(join(dirname(runtimeRoot), ".synara-runtime-"));
let synaraVersion;
try {
  await prepareNodeRuntime(stageRoot);
  synaraVersion = installServerRuntime(stageRoot);
  restoreHelperExecutableBits(stageRoot);
  if (!deviceHelperTreeMatches(sourceDeviceHelperRoot, join(stageRoot, "server/dist/device-helper"))) {
    throw new Error("The staged Synara runtime is missing part of the iOS device helper source tree.");
  }
  const prunedBytes =
    replaceUnusedClaudeBinary(stageRoot) + pruneServerRuntime(stageRoot, { target, platform: release.platform })
    + stripNodeSymbols(stageRoot);
  for (const scope of ["@earendil-works", "@opencode", "@opencode-ai"]) {
    if (existsSync(join(stageRoot, "server/node_modules", scope))) {
      throw new Error(`The staged Synara runtime still contains ${scope}, which installs on demand.`);
    }
  }
  // Exercise lazy provider imports after pruning, using the shipped Node rather
  // than the development install that can hide missing production dependencies.
  // The provider smoke does not cover the server entry's static imports, so
  // load that too. Pi and OpenCode must report themselves as installable rather
  // than load, since the slimmed layout leaves them out.
  const stagedNode = join(stageRoot, "bin", nodeExecutable);
  const smoke = capture(stagedNode, [join(stageRoot, "server/dist/runtimeDependencySmoke.mjs")], {
    cwd: join(stageRoot, "server"),
  });
  process.stdout.write(smoke);
  for (const runtime of OPTIONAL_PROVIDER_RUNTIMES) {
    if (!smoke.includes(`Provider runtime ${runtime}: missing.`)) {
      throw new Error(`The packaged runtime smoke did not report ${runtime} as an on-demand install.`);
    }
  }
  run(stagedNode, [join(stageRoot, "server/dist/index.mjs"), "--help"], { cwd: join(stageRoot, "server") });
  signMacRuntime(stageRoot);
  writeJson(join(stageRoot, "manifest.json"), {
    buildKey,
    target,
    nodeVersion: runtimeConfig.nodeVersion,
    nodeRuntime: "standalone",
    bibtexTidyVersion,
    synaraVersion,
    synaraRevision: dirtyStatus ? `${head}+dirty` : head,
    deviceHelperSource: "server/dist/device-helper",
    sourceRepository: runtimeConfig.repository,
    upstreamRepository: runtimeConfig.upstream,
  });
  rmSync(runtimeRoot, { recursive: true, force: true });
  renameSync(stageRoot, runtimeRoot);
  console.log(`Pruned ${(prunedBytes / 1024 / 1024).toFixed(1)} MB of unused runtime artifacts.`);
} catch (error) {
  rmSync(stageRoot, { recursive: true, force: true });
  throw error;
}

const stagedMegabytes = (treeBytes(runtimeRoot) / 1024 / 1024).toFixed(1);
console.log(`Prepared Synara ${synaraVersion} (${runtimeConfig.branch}) for ${target}, ${stagedMegabytes} MB.`);
