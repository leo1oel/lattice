// Install the pinned Open Slide + Vite production closure from
// tools/open-slide-runtime into src-tauri/presentation-runtime/ (a Tauri resource),
// and sign its Mach-O binaries with the Developer ID in APPLE_SIGNING_IDENTITY
// (skipped without one).
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signMachOTree, signingIdentity } from "./lib/codesign.mjs";
import { isMain, projectRoot, readJson, run, walkFiles } from "./lib/util.mjs";

export const removablePackageDirectories = [
  // main and module both resolve into dist; Open Slide never imports this source tree.
  "emoji-picker-react/src",
  // These package-specific documentation/example trees aren't package entry points or exports.
  "@base-ui/react/docs",
  "@modelcontextprotocol/sdk/dist/cjs/examples",
  "@modelcontextprotocol/sdk/dist/esm/examples",
  "react-router/docs",
  "undici/docs",
];

const removableFilePattern = /(?:\.map|\.d\.(?:ts|mts|cts))$/;

export function prunePresentationRuntime(runtimeRoot) {
  const nodeModules = join(runtimeRoot, "node_modules");
  for (const relativePath of removablePackageDirectories) {
    rmSync(join(nodeModules, relativePath), { recursive: true, force: true });
  }

  // emoji-picker-react copies locale source data alongside compiled JS.
  // Open Slide uses the package entry, and locale subpaths resolve to JS;
  // keep every locale but omit its duplicate JSON/TS when the JS exists.
  const emojiData = join(nodeModules, "emoji-picker-react/dist/data");
  if (existsSync(emojiData)) {
    for (const file of readdirSync(emojiData)) {
      if (/^emojis(?:-[\w-]+)?\.(?:json|ts)$/.test(file) &&
          existsSync(join(emojiData, file.replace(/\.(?:json|ts)$/, ".js")))) {
        rmSync(join(emojiData, file));
      }
    }
  }

  for (const path of walkFiles(nodeModules)) {
    if (removableFilePattern.test(path)) rmSync(path);
  }
}

// Tauri's resource walker omits symbolic links. A normal pnpm layout therefore
// ships the package store but drops node_modules/@open-slide/core, Vite, and
// every other package entry that Node resolves at runtime. Hoisting makes the
// package directories real; materialize the remaining executable links too so
// the staged tree is exactly the tree copied into a release app.
function materializeLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const sourcePath = realpathSync(path);
      const sourceIsDirectory = lstatSync(sourcePath).isDirectory();
      rmSync(path, { recursive: true, force: true });
      cpSync(sourcePath, path, { recursive: sourceIsDirectory, preserveTimestamps: true });
      if (sourceIsDirectory) materializeLinks(path);
    } else if (entry.isDirectory()) {
      materializeLinks(path);
    }
  }
}

function preparePresentationRuntime() {
  const source = join(projectRoot, "tools/open-slide-runtime");
  const target = join(projectRoot, "src-tauri/presentation-runtime");
  const stage = join(projectRoot, "node_modules/.cache/lattice/presentation-runtime");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const file of ["package.json", "pnpm-lock.yaml", "server.mjs", "lucide-open-slide.mjs"]) {
    cpSync(join(source, file), join(stage, file));
  }
  run(
    "pnpm",
    ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted"],
    { cwd: stage },
  );
  materializeLinks(join(stage, "node_modules"));
  prunePresentationRuntime(stage);
  const packageVersion = (name) => readJson(join(stage, "node_modules", name, "package.json")).version;
  writeFileSync(
    join(stage, "manifest.json"),
    JSON.stringify(
      { openSlideVersion: packageVersion("@open-slide/core"), viteVersion: packageVersion("vite") },
      null,
      2,
    ),
  );
  rmSync(target, { recursive: true, force: true });
  renameSync(stage, target);
  writeFileSync(
    join(target, "placeholder.txt"),
    "Run `pnpm prepare:presentation` to stage the managed Open Slide runtime here.\n",
  );
  if (!existsSync(join(target, "server.mjs"))) throw new Error("Presentation runtime staging failed");
  if (!existsSync(join(target, "node_modules/@open-slide/core/package.json"))) {
    throw new Error("Presentation runtime package materialization failed");
  }
  signPresentationRuntime(target);
}

function signPresentationRuntime(runtimeRoot) {
  const identity = signingIdentity();
  if (!identity) {
    console.log("Skipping presentation runtime signing without APPLE_SIGNING_IDENTITY");
    return;
  }
  if (process.platform !== "darwin") throw new Error("The presentation runtime can only be signed on macOS.");
  const signed = signMachOTree(runtimeRoot, { identity });
  if (signed === 0) throw new Error(`No Mach-O binaries found in ${runtimeRoot}`);
  console.log(`Signed ${signed} presentation runtime binaries`);
}

if (isMain(import.meta.url)) preparePresentationRuntime();
