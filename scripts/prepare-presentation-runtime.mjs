import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

  function removeBuildMetadata(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) removeBuildMetadata(path);
      else if (entry.isFile() && removableFilePattern.test(entry.name))
        rmSync(path);
    }
  }
  removeBuildMetadata(nodeModules);
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
      cpSync(sourcePath, path, {
        recursive: sourceIsDirectory,
        preserveTimestamps: true,
      });
      if (sourceIsDirectory) materializeLinks(path);
    } else if (entry.isDirectory()) {
      materializeLinks(path);
    }
  }
}

function preparePresentationRuntime() {
  const source = join(root, "tools/open-slide-runtime");
  const target = join(root, "src-tauri/presentation-runtime");
  const stage = join(root, "node_modules/.cache/lattice/presentation-runtime");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  for (const file of [
    "package.json",
    "pnpm-lock.yaml",
    "server.mjs",
    "lucide-open-slide.mjs",
  ]) {
    cpSync(join(source, file), join(stage, file));
  }
  execFileSync(
    "pnpm",
    [
      "install",
      "--prod",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--config.node-linker=hoisted",
    ],
    { cwd: stage, stdio: "inherit" },
  );
  materializeLinks(join(stage, "node_modules"));
  prunePresentationRuntime(stage);
  writeFileSync(
    join(stage, "manifest.json"),
    JSON.stringify(
      { openSlideVersion: "1.19.1", viteVersion: "5.4.10" },
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
  if (!existsSync(join(target, "server.mjs")))
    throw new Error("Presentation runtime staging failed");
  if (!existsSync(join(target, "node_modules/@open-slide/core/package.json"))) {
    throw new Error("Presentation runtime package materialization failed");
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  preparePresentationRuntime();
}
