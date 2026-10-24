// Install the pinned Open Slide + Vite production closure from
// tools/open-slide-runtime into src-tauri/presentation-runtime/ (a Tauri resource),
// prune what the dev server never loads, prove the pruned tree still serves the
// editor (scripts/check-presentation-runtime.mjs), and sign its Mach-O binaries
// with the Developer ID in APPLE_SIGNING_IDENTITY (skipped without one).
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { checkPresentationRuntime } from "./check-presentation-runtime.mjs";
import { signMachOTree, signingIdentity } from "./lib/codesign.mjs";
import { pruneNodeModules } from "./lib/runtime-prune.mjs";
import { isMain, projectRoot, readJson, run, walkFiles } from "./lib/util.mjs";

export const removablePackageDirectories = [
  // main and module both resolve into dist; Open Slide never imports this source tree.
  "emoji-picker-react/src",
];

// Builds of webview-only packages that no import can resolve to: Node never
// loads these packages, and Vite serves them to the webview with the import
// and browser conditions.
const removablePackageFiles = [
  // react-router's exports map points only into dist/development.
  /^react-router\/dist\/production\//,
  // Base UI's CommonJS build, which only the require condition selects; its
  // ESM build is the .mjs beside each file.
  /^@base-ui\/(?:react|utils)\/.+\.js$/,
  // React DOM's server renderers for Node, Bun, and edge runtimes; in the
  // browser, react-dom/server and react-dom/static select the browser build.
  /^react-dom\/(?:cjs\/react-dom-server(?:-legacy)?|server|static)\.(?:bun|edge|node)\./,
];

// Packages the runtime ships only a few files of, and none of their dependencies.
const assetOnlyPackages = {
  // Open Slide's editor stylesheet imports `shadcn/tailwind.css`, which
  // Tailwind resolves through the package's exports; nothing loads the rest,
  // the shadcn CLI, whose closure (ts-morph, Babel, the MCP SDK, Express, ...)
  // was about a third of the installed tree.
  shadcn: ["package.json", "LICENSE.md", "dist/tailwind.css"],
};

// Declared dependency edges the dev server never follows.
const unusedDependencies = {
  // Vite 8 loads lightningcss only for `css.transformer: "lightningcss"` and
  // for build-time CSS minification; the dev server transforms CSS with
  // PostCSS. Tailwind pins an older lightningcss, so Vite's own copy is a
  // second native binary. Were Vite ever to load it, Node would resolve the
  // copy Tailwind loads instead.
  vite: ["lightningcss"],
};

/** The directory of the package `name` that Node resolves from `directory`, or null. */
function resolvePackage(runtimeRoot, directory, name) {
  for (let parent = directory; ; parent = dirname(parent)) {
    const candidate = join(parent, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (parent === runtimeRoot) return null;
  }
}

/**
 * The package directories the runtime's dependencies reach, resolved as Node
 * resolves them. pnpm also installs packages that only an optional peer
 * dependency names: esbuild, the runtime's own test-time devDependency,
 * satisfies Vite's optional peer, but Vite 8 imports it only for
 * `build.minify: "esbuild"` and the deprecated `transformWithEsbuild`, never
 * to serve. An optional peer is therefore not an edge here.
 */
function reachablePackages(runtimeRoot) {
  const reached = new Set();
  const visit = (directory) => {
    if (reached.has(directory)) return;
    reached.add(directory);
    const manifest = readJson(join(directory, "package.json"));
    if (directory !== runtimeRoot && manifest.name in assetOnlyPackages) return;
    const unused = new Set(directory === runtimeRoot ? [] : unusedDependencies[manifest.name]);
    const peers = Object.keys(manifest.peerDependencies ?? {})
      .filter((name) => !manifest.peerDependenciesMeta?.[name]?.optional);
    for (const name of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...peers,
    ]) {
      // Optional packages for another platform are not installed at all.
      const target = unused.has(name) ? null : resolvePackage(runtimeRoot, directory, name);
      if (target) visit(target);
    }
  };
  visit(runtimeRoot);
  return reached;
}

/** The package directories directly inside `nodeModules`, scoped ones included. */
function packageDirectories(nodeModules) {
  if (!existsSync(nodeModules)) return [];
  return readdirSync(nodeModules, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap((entry) => {
      const path = join(nodeModules, entry.name);
      if (!entry.name.startsWith("@")) return [path];
      return readdirSync(path, { withFileTypes: true })
        .filter((scoped) => scoped.isDirectory())
        .map((scoped) => join(path, scoped.name));
    });
}

/** Delete everything under `directory` except the `kept` relative file paths. */
function keepOnly(directory, kept) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (kept.includes(entry.name)) continue;
    const path = join(directory, entry.name);
    const prefix = `${entry.name}/`;
    const inside = kept.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
    if (entry.isDirectory() && inside.length > 0) keepOnly(path, inside);
    else rmSync(path, { recursive: true, force: true });
  }
}

/** Remove the packages and package files the dev server can never load. */
function pruneUnreachablePackages(nodeModules, reached) {
  // Command shims: the server imports these packages, it never runs their CLIs.
  rmSync(join(nodeModules, ".bin"), { recursive: true, force: true });
  for (const path of packageDirectories(nodeModules)) {
    if (!reached.has(path)) {
      rmSync(path, { recursive: true, force: true });
      continue;
    }
    const kept = assetOnlyPackages[readJson(join(path, "package.json")).name];
    if (kept) keepOnly(path, kept);
    else pruneUnreachablePackages(join(path, "node_modules"), reached);
  }
}

export function prunePresentationRuntime(runtimeRoot) {
  const nodeModules = join(runtimeRoot, "node_modules");
  pruneUnreachablePackages(nodeModules, reachablePackages(runtimeRoot));

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
    if (removablePackageFiles.some((pattern) => pattern.test(relative(nodeModules, path)))) rmSync(path);
  }

  // Vite compiles TypeScript straight out of node_modules (Open Slide's own
  // app ships as src/app), so TypeScript sources stay here.
  pruneNodeModules(nodeModules, { platform: `${process.platform}-${process.arch}`, typeScriptSources: "keep" });
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

async function preparePresentationRuntime() {
  const source = join(projectRoot, "tools/open-slide-runtime");
  const target = join(projectRoot, "src-tauri/presentation-runtime");
  const stage = join(projectRoot, "node_modules/.cache/lattice/presentation-runtime");
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  const runtimeFiles = [
    "package.json",
    "pnpm-lock.yaml",
    "server.mjs",
    "agent-chat.mjs",
    "agent-presence.mjs",
    "deck-error-overlay.mjs",
    "patch-contract.mjs",
    "lucide-open-slide.mjs",
    "locale-copy.mjs",
    "prebundled-dependencies.mjs",
  ];
  for (const file of runtimeFiles) {
    cpSync(join(source, file), join(stage, file));
  }
  run(
    "pnpm",
    ["install", "--prod", "--frozen-lockfile", "--ignore-scripts", "--config.node-linker=hoisted"],
    { cwd: stage },
  );
  materializeLinks(join(stage, "node_modules"));
  prunePresentationRuntime(stage);
  await checkPresentationRuntime(stage);
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

if (isMain(import.meta.url)) await preparePresentationRuntime();
