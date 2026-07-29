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
  mkdirSync(join(stageRoot, "licenses"), { recursive: true });
  cpSync(join(sourceRoot, "LICENSE"), join(stageRoot, "licenses/Synara-MIT.txt"));
  return serverPackage.version;
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
  .digest("hex");
const existingManifestPath = join(runtimeRoot, "manifest.json");
if (existsSync(existingManifestPath)) {
  const existingManifest = JSON.parse(readFileSync(existingManifestPath, "utf8"));
  const executableName = target.includes("windows") ? "node.exe" : "node";
  if (
    existingManifest.buildKey === buildKey &&
    existsSync(join(runtimeRoot, "bin", executableName)) &&
    existsSync(join(runtimeRoot, "server/dist/index.mjs")) &&
    existsSync(join(runtimeRoot, "server/dist/client/index.html"))
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
run(bun, ["run", "--filter", "@synara/web", "build"], {
  cwd: sourceRoot,
  env: buildEnv,
});
run(bun, ["run", "--filter", "@synara/cli", "build"], {
  cwd: sourceRoot,
  env: buildEnv,
});

mkdirSync(cacheRoot, { recursive: true });
const stageRoot = mkdtempSync(join(dirname(runtimeRoot), ".synara-runtime-"));
try {
  await prepareNodeRuntime(stageRoot, target, release);
  const synaraVersion = installServerRuntime(stageRoot);
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
        sourceRepository: runtimeConfig.repository,
        upstreamRepository: runtimeConfig.upstream,
      },
      null,
      2,
    )}\n`,
  );
  rmSync(runtimeRoot, { recursive: true, force: true });
  renameSync(stageRoot, runtimeRoot);
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
