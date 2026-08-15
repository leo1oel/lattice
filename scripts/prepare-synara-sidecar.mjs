import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeConfig = JSON.parse(
  readFileSync(join(projectRoot, "scripts/synara-runtime.json"), "utf8"),
);
const allowDirty = process.argv.includes("--allow-dirty");
const sourceRoot = resolve(
  projectRoot,
  process.env.SYNARA_SOURCE_DIR?.trim() || runtimeConfig.sourceDirectory,
);
const runtimeRoot = join(projectRoot, "src-tauri/synara-runtime");
const cacheRoot = join(projectRoot, "node_modules/.cache/lattice/synara");
const npmCache = join(projectRoot, "node_modules/.cache/lattice/npm");
const deviceHelperFiles = [
  "build.sh",
  "device-helper.sb",
  "Sources/DeviceHelper-Bridging-Header.h",
  "Sources/main.swift",
];

const nodeArchives = {
  "aarch64-apple-darwin": {
    platform: "darwin-arm64",
    archive: "node-v24.13.0-darwin-arm64.tar.gz",
    sha256: "d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8",
  },
  "x86_64-apple-darwin": {
    platform: "darwin-x64",
    archive: "node-v24.13.0-darwin-x64.tar.gz",
    sha256: "6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3",
  },
  "aarch64-unknown-linux-gnu": {
    platform: "linux-arm64",
    archive: "node-v24.13.0-linux-arm64.tar.gz",
    sha256: "0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081",
  },
  "x86_64-unknown-linux-gnu": {
    platform: "linux-x64",
    archive: "node-v24.13.0-linux-x64.tar.gz",
    sha256: "6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8",
  },
  "x86_64-pc-windows-msvc": {
    platform: "win-x64",
    archive: "node-v24.13.0-win-x64.zip",
    sha256: "ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88",
  },
};

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? "inherit",
    env: options.env ?? process.env,
    // Binary Git patches easily exceed Node's 1 MiB default while fingerprinting a dirty checkout.
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
}

function git(args) {
  return run("git", args, { cwd: sourceRoot, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sourceFingerprint(head, dirtyStatus) {
  const hash = createHash("sha256").update(head).update("\0").update(dirtyStatus);
  if (dirtyStatus) {
    hash.update(
      run("git", ["diff", "--binary", "HEAD"], {
        cwd: sourceRoot,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const untracked = git(["ls-files", "--others", "--exclude-standard"])
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

function resolveBun() {
  const configured = process.env.BUN_BIN?.trim();
  const local = join(projectRoot, "node_modules/.bin", process.platform === "win32" ? "bun.exe" : "bun");
  if (configured && existsSync(configured)) return configured;
  if (existsSync(local)) return local;
  try {
    return run(process.platform === "win32" ? "where" : "which", ["bun"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error(
      "Bun is required to build Synara. Install dependencies or set BUN_BIN to a Bun 1.3 executable.",
    );
  }
}

function walkFiles(root, output = []) {
  if (!existsSync(root)) return output;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkFiles(path, output);
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function hasDeviceHelperSources(root, target) {
  if (!deviceHelperFiles.every((path) => existsSync(join(root, path)))) return false;
  return (
    target.startsWith("x86_64-pc-windows") ||
    (statSync(join(root, "build.sh")).mode & 0o111) !== 0
  );
}

function deviceHelperTreeMatches(source, candidate, target) {
  if (!hasDeviceHelperSources(candidate, target)) return false;
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

async function prepareNodeRuntime(stageRoot, target, release) {
  const archive = join(cacheRoot, release.archive);
  if (!existsSync(archive) || sha256File(archive) !== release.sha256) {
    rmSync(archive, { force: true });
    await download(
      `https://nodejs.org/dist/v${runtimeConfig.nodeVersion}/${release.archive}`,
      archive,
    );
  }
  if (sha256File(archive) !== release.sha256) {
    rmSync(archive, { force: true });
    throw new Error(`Node ${runtimeConfig.nodeVersion} failed its SHA-256 check.`);
  }

  const extractionRoot = mkdtempSync(join(cacheRoot, "node-extract-"));
  try {
    if (release.archive.endsWith(".zip")) {
      if (process.platform !== "win32") {
        run("unzip", ["-q", archive, "-d", extractionRoot]);
      } else {
        run("powershell", [
          "-NoProfile",
          "-Command",
          `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${extractionRoot.replaceAll("'", "''")}' -Force`,
        ]);
      }
    } else {
      run("tar", ["-xzf", archive, "-C", extractionRoot]);
    }
    const extractedRoot = join(
      extractionRoot,
      release.archive.replace(/\.tar\.gz$|\.zip$/g, ""),
    );
    const executableName = target.includes("windows") ? "node.exe" : "node";
    const sourceNode = join(extractedRoot, executableName === "node.exe" ? "node.exe" : "bin/node");
    const binDir = join(stageRoot, "bin");
    mkdirSync(binDir, { recursive: true });
    cpSync(sourceNode, join(binDir, executableName));
    chmodSync(join(binDir, executableName), 0o755);
    mkdirSync(join(stageRoot, "licenses"), { recursive: true });
    cpSync(join(extractedRoot, "LICENSE"), join(stageRoot, "licenses/Node-LICENSE.txt"));
  } finally {
    rmSync(extractionRoot, { recursive: true, force: true });
  }
}

function resolveServerDependencies() {
  const rootPackage = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  const serverPackage = JSON.parse(
    readFileSync(join(sourceRoot, "apps/server/package.json"), "utf8"),
  );
  const catalog = rootPackage.workspaces?.catalog ?? {};
  const dependencies = {};
  for (const [name, version] of Object.entries(serverPackage.dependencies ?? {})) {
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

function installServerRuntime(stageRoot) {
  const { serverPackage, dependencies } = resolveServerDependencies();
  const serverRoot = join(stageRoot, "server");
  mkdirSync(serverRoot, { recursive: true });
  cpSync(join(sourceRoot, "apps/server/dist"), join(serverRoot, "dist"), {
    recursive: true,
  });
  writeFileSync(
    join(serverRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@lattice/synara-runtime",
        private: true,
        version: serverPackage.version,
        type: "module",
        engines: serverPackage.engines,
        dependencies,
      },
      null,
      2,
    )}\n`,
  );
  mkdirSync(npmCache, { recursive: true });
  run(
    process.platform === "win32" ? "npm.cmd" : "npm",
    [
      "install",
      "--omit=dev",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
    ],
    {
      cwd: serverRoot,
      env: {
        ...process.env,
        npm_config_cache: npmCache,
      },
    },
  );
  silenceExpectedSessionProbeWarnings(serverRoot);
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
function silenceExpectedSessionProbeWarnings(serverRoot) {
  const bundle = join(serverRoot, "dist/index.mjs");
  const source = readFileSync(bundle, "utf8");
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
  writeFileSync(bundle, source.replace(probe, quiet));
}

function runtimePlatformDirectory(target) {
  return {
    "aarch64-apple-darwin": "darwin-arm64",
    "x86_64-apple-darwin": "darwin-x64",
    "aarch64-unknown-linux-gnu": "linux-arm64",
    "x86_64-unknown-linux-gnu": "linux-x64",
    "x86_64-pc-windows-msvc": "win32-x64",
  }[target];
}

/**
 * npm packages often publish source maps, Windows debug symbols, and native
 * binaries for every supported platform. They are useful to package authors,
 * but never loaded by the staged production runtime and previously inflated
 * the installed app by hundreds of megabytes.
 */
function pruneServerRuntime(stageRoot, target) {
  const serverRoot = join(stageRoot, "server");
  let removedBytes = 0;
  for (const path of walkFiles(serverRoot)) {
    // TypeScript declarations are dev-time only; the staged runtime never
    // typechecks. Keep .d.ts inside dist/ untouched anyway — nothing loads
    // from node_modules typings at runtime.
    const isTypings = path.includes("/node_modules/") && (path.endsWith(".d.ts") || path.endsWith(".d.mts") || path.endsWith(".d.cts"));
    if (!path.endsWith(".map") && !path.endsWith(".pdb") && !isTypings) continue;
    removedBytes += statSync(path).size;
    rmSync(path, { force: true });
  }

  // Documentation, examples, and TS sources published inside node_modules are
  // never read by the running agent.
  const junkDirectories = [
    "node_modules/@types",
    "node_modules/@earendil-works/pi-coding-agent/docs",
    "node_modules/@earendil-works/pi-coding-agent/examples",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@types",
    "node_modules/@anthropic-ai/sdk/src",
    // ConPTY is Windows-only; keep it when staging a Windows runtime.
    ...(target === "x86_64-pc-windows-msvc" ? [] : ["node_modules/node-pty/third_party"]),
  ];
  // Top-level copies of the provider SDKs and their support libraries satisfy
  // the top-level @earendil-works/pi-ai, which the running server never
  // imports: the bundled dist externalizes a fixed module list, and
  // pi-coding-agent (the only consumer of pi-ai) ships an npm-shrinkwrap that
  // resolves its own nested copies. Verified by walking declared dependency
  // edges from the bundle's externalized import roots — none of these are
  // resolvable from reachable code. ajv, ajv-formats, and zod must stay at
  // top level: the agent SDKs require them at runtime without declaring them.
  const unreachableTopLevelPackages = [
    "@anthropic-ai/sdk",
    "@aws-sdk",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@google",
    "@hono/node-server",
    "@mistralai",
    "@modelcontextprotocol",
    "@opentelemetry",
    "@smithy",
    "express",
    "hono",
    "ioredis",
    "jose",
    "openai",
    "protobufjs",
    "react",
    "react-dom",
    "scheduler",
    "typebox",
    "web-streams-polyfill",
  ];
  for (const name of unreachableTopLevelPackages) {
    junkDirectories.push(`node_modules/${name}`);
  }
  for (const relative of junkDirectories) {
    const path = join(serverRoot, relative);
    if (!existsSync(path)) continue;
    removedBytes += walkFiles(path).reduce((total, file) => total + statSync(file).size, 0);
    rmSync(path, { recursive: true, force: true });
  }

  // The launcher runs dist/index.mjs; the parallel CommonJS build of the same
  // server (index.cjs and its chunks) is never executed.
  const distRoot = join(serverRoot, "dist");
  if (existsSync(distRoot)) {
    for (const entry of readdirSync(distRoot)) {
      if (!entry.endsWith(".cjs")) continue;
      const path = join(distRoot, entry);
      removedBytes += statSync(path).size;
      rmSync(path, { force: true });
    }
  }

  // Precompressed .br/.gz sidecars for the embedded client UI: the static
  // server falls back to the identity file when a sidecar is missing, and the
  // iframe loads over loopback where transfer compression buys nothing.
  const clientRoot = join(distRoot, "client");
  if (existsSync(clientRoot)) {
    for (const path of walkFiles(clientRoot)) {
      if (!path.endsWith(".br") && !path.endsWith(".gz")) continue;
      removedBytes += statSync(path).size;
      rmSync(path, { force: true });
    }
  }

  // Vitest suites shipped inside the ACP SDK's published dist.
  const acpDist = join(serverRoot, "node_modules/@agentclientprotocol/sdk/dist");
  if (existsSync(acpDist)) {
    for (const path of walkFiles(acpDist)) {
      if (!path.endsWith(".test.js")) continue;
      removedBytes += statSync(path).size;
      rmSync(path, { force: true });
    }
  }

  // Pruned packages leave dangling npm .bin symlinks behind, and tauri-build
  // hard-errors on any broken link inside the bundled resources glob.
  for (const binDirectory of [
    join(serverRoot, "node_modules/.bin"),
    join(serverRoot, "node_modules/@earendil-works/pi-coding-agent/node_modules/.bin"),
  ]) {
    if (!existsSync(binDirectory)) continue;
    for (const entry of readdirSync(binDirectory)) {
      const path = join(binDirectory, entry);
      if (existsSync(path)) continue; // existsSync follows symlinks; false = dangling
      rmSync(path, { force: true });
    }
  }

  const platformDirectory = runtimePlatformDirectory(target);
  const nodePtyPrebuilds = join(serverRoot, "node_modules/node-pty/prebuilds");
  if (platformDirectory && existsSync(nodePtyPrebuilds)) {
    for (const entry of readdirSync(nodePtyPrebuilds)) {
      if (entry === platformDirectory) continue;
      const path = join(nodePtyPrebuilds, entry);
      removedBytes += walkFiles(path).reduce((total, file) => total + statSync(file).size, 0);
      rmSync(path, { recursive: true, force: true });
    }
  }

  const clipboardPackages = join(
    serverRoot,
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@mariozechner",
  );
  if (platformDirectory && existsSync(clipboardPackages)) {
    for (const entry of readdirSync(clipboardPackages)) {
      if (!entry.startsWith("clipboard-") || entry === `clipboard-${platformDirectory}`) continue;
      const path = join(clipboardPackages, entry);
      removedBytes += walkFiles(path).reduce((total, file) => total + statSync(file).size, 0);
      rmSync(path, { recursive: true, force: true });
    }
  }
  return removedBytes;
}

function restoreHelperExecutableBits(stageRoot, target) {
  if (target.startsWith("x86_64-pc-windows")) return;
  chmodSync(join(stageRoot, "server/dist/device-helper/build.sh"), 0o755);
  // bun installs package prebuilds without their executable bit, and only the
  // signing pass below (skipped without APPLE_SIGNING_IDENTITY) used to put it
  // back. node-pty execs spawn-helper for every PTY, so a dev-staged runtime
  // shipped a helper the kernel refuses to run: every agent turn that touches
  // a terminal dies with posix_spawnp failure.
  for (const path of walkFiles(stageRoot)) {
    if (path.split(/[\\/]/).at(-1) === "spawn-helper") {
      chmodSync(path, 0o755);
    }
  }
}

function signMacRuntime(stageRoot, target) {
  if (!target.endsWith("-apple-darwin")) return;
  const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  if (!signingIdentity || signingIdentity === "-") return;
  const entitlements = join(projectRoot, "src-tauri/Entitlements.plist");
  const signableFiles = walkFiles(stageRoot).filter((path) => {
    const name = path.split(/[\\/]/).at(-1);
    return (
      path.endsWith("/bin/node") ||
      path.endsWith(".node") ||
      name === "spawn-helper"
    );
  });
  for (const path of signableFiles) {
    chmodSync(path, 0o755);
    run("codesign", [
      "--force",
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      entitlements,
      "--sign",
      signingIdentity,
      path,
    ]);
  }
}

if (!existsSync(join(sourceRoot, ".git"))) {
  throw new Error(
    `Synara source is missing at ${sourceRoot}. Clone ${runtimeConfig.repository} there or set SYNARA_SOURCE_DIR.`,
  );
}

const rustVersion = run("rustc", ["-vV"], { stdio: ["ignore", "pipe", "pipe"] });
const target = rustVersion.match(/^host:\s*(.+)$/m)?.[1];
const release = target ? nodeArchives[target] : null;
if (!target || !release) {
  throw new Error(`The bundled Synara runtime is not configured for ${target ?? "this target"}.`);
}
if (!release.archive.includes(runtimeConfig.nodeVersion)) {
  throw new Error("The pinned Node version and archive map are out of sync.");
}

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

const fingerprint = sourceFingerprint(head, dirtyStatus);
const buildKey = createHash("sha256")
  .update(JSON.stringify(runtimeConfig))
  .update(target)
  .update(fingerprint)
  .update(readFileSync(fileURLToPath(import.meta.url)))
  .digest("hex");
const existingManifestPath = join(runtimeRoot, "manifest.json");
const sourceDeviceHelperRoot = join(sourceRoot, "apps/server/native/device-helper");
if (existsSync(existingManifestPath)) {
  const existingManifest = JSON.parse(readFileSync(existingManifestPath, "utf8"));
  const executableName = target.includes("windows") ? "node.exe" : "node";
  if (
    existingManifest.buildKey === buildKey &&
    existsSync(join(runtimeRoot, "bin", executableName)) &&
    existsSync(join(runtimeRoot, "server/dist/index.mjs")) &&
    existsSync(join(runtimeRoot, "server/dist/client/index.html")) &&
    deviceHelperTreeMatches(
      sourceDeviceHelperRoot,
      join(runtimeRoot, "server/dist/device-helper"),
      target,
    )
  ) {
    console.log(
      `Synara runtime ${existingManifest.synaraVersion} is already prepared for ${target}.`,
    );
    process.exit(0);
  }
}

const bun = resolveBun();
const bunDir = dirname(bun);
const buildEnv = {
  ...process.env,
  PATH: `${bunDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
};
const pathSeparator = process.platform === "win32" ? ";" : ":";

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
function buildWorkspace(workspaceDirectory) {
  const workspaceRoot = join(sourceRoot, workspaceDirectory);
  const manifest = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8"));
  const command = manifest.scripts?.build;
  if (!command) {
    throw new Error(`${manifest.name ?? workspaceDirectory} does not define a build script.`);
  }
  console.log(`Building ${manifest.name ?? workspaceDirectory}: ${command}`);
  run(process.platform === "win32" ? "cmd" : "sh", [
    process.platform === "win32" ? "/c" : "-c",
    command,
  ], {
    cwd: workspaceRoot,
    env: {
      ...buildEnv,
      PATH: [
        join(workspaceRoot, "node_modules/.bin"),
        join(sourceRoot, "node_modules/.bin"),
        buildEnv.PATH,
      ].join(pathSeparator),
    },
  });
}

const buildStartedAt = Date.now();
buildWorkspace("apps/web");
buildWorkspace("apps/server");

// Device input, accessibility, and video use a native helper compiled against
// the user's Xcode on first attach. The server build must stage its sources
// beside the bundle; otherwise the pane appears normally but attach fails only
// in the packaged app, where the repository fallback path does not exist.
const builtDeviceHelperRoot = join(sourceRoot, "apps/server/dist/device-helper");
if (!deviceHelperTreeMatches(sourceDeviceHelperRoot, builtDeviceHelperRoot, target)) {
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
try {
  await prepareNodeRuntime(stageRoot, target, release);
  const synaraVersion = installServerRuntime(stageRoot);
  restoreHelperExecutableBits(stageRoot, target);
  const stagedDeviceHelperRoot = join(stageRoot, "server/dist/device-helper");
  if (!deviceHelperTreeMatches(sourceDeviceHelperRoot, stagedDeviceHelperRoot, target)) {
    throw new Error("The staged Synara runtime is missing part of the iOS device helper source tree.");
  }
  const prunedBytes = pruneServerRuntime(stageRoot, target);
  signMacRuntime(stageRoot, target);
  writeFileSync(
    join(stageRoot, "manifest.json"),
    `${JSON.stringify(
      {
        buildKey,
        target,
        nodeVersion: runtimeConfig.nodeVersion,
        synaraVersion,
        synaraRevision: dirtyStatus ? `${head}+dirty` : head,
        deviceHelperSource: "server/dist/device-helper",
        sourceRepository: runtimeConfig.repository,
        upstreamRepository: runtimeConfig.upstream,
      },
      null,
      2,
    )}\n`,
  );
  rmSync(runtimeRoot, { recursive: true, force: true });
  renameSync(stageRoot, runtimeRoot);
  console.log(`Pruned ${(prunedBytes / 1024 / 1024).toFixed(1)} MB of unused runtime artifacts.`);
} catch (error) {
  rmSync(stageRoot, { recursive: true, force: true });
  throw error;
}

const stagedMegabytes = (
  walkFiles(runtimeRoot).reduce((total, path) => total + statSync(path).size, 0) /
  1024 /
  1024
).toFixed(1);
console.log(
  `Prepared Synara ${JSON.parse(readFileSync(join(runtimeRoot, "manifest.json"), "utf8")).synaraVersion} ` +
    `(${relative(sourceRoot, join(sourceRoot, ".")) || runtimeConfig.branch}) for ${target}, ${stagedMegabytes} MB.`,
);
