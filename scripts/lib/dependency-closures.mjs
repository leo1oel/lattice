/**
 * The two dependency closures resolved from lockfiles rather than scanned from
 * a staged directory — the npm production tree and the crates linked into the
 * Rust binary — read into notice entries for scripts/generate-notices.mjs.
 */

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { declaredNpmLicense, isFile, makeEntry, readDirectory, readJson } from "./package-notices.mjs";
import { projectRoot } from "./util.mjs";

// ---------------------------------------------------------------------------
// Closure 1 — npm production dependencies (the web assets)
// ---------------------------------------------------------------------------

/**
 * Node's own resolution, minus the loader: look for node_modules/<name> beside
 * the requiring package and then in every parent. Works for pnpm's symlinked
 * store, npm's flat tree, and yarn alike, which is why this walks the tree
 * rather than parsing pnpm-lock.yaml.
 */
function resolveDependency(fromDir, name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (isFile(join(candidate, "package.json"))) {
      try {
        return realpathSync(candidate);
      } catch {
        return candidate;
      }
    }
    if (dirname(dir) === dir) return null;
  }
}

/**
 * Package roots physically nested inside `rootDir`.
 *
 * Some packages vendor their own node_modules into what they publish —
 * @pierre/diffs ships an entire pnpm store under dist/ — and those files are
 * distributed just like the package that contains them. Symlinks are skipped
 * on purpose: in a pnpm store they are the dependency edges, which the graph
 * walk already covers, and following them would drag the whole tree in.
 */
export function collectNestedPackageRoots(rootDir) {
  const roots = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    const inNodeModules = basename(dir) === "node_modules";
    for (const entry of readDirectory(dir)) {
      if (!entry.isDirectory() || entry.name === ".bin") continue;
      const full = join(dir, entry.name);
      if (inNodeModules && entry.name.startsWith("@")) {
        for (const child of readDirectory(full)) {
          if (child.isDirectory()) roots.push(join(full, child.name));
        }
      } else if (inNodeModules && entry.name !== ".pnpm") {
        roots.push(full);
      }
      stack.push(full);
    }
  }
  // readdirSync order is filesystem-dependent; sort so callers see the same
  // tree on every machine.
  return roots.sort();
}

export function collectNpm() {
  const rootPkg = readJson(join(projectRoot, "package.json"));
  if (!rootPkg) throw new Error("Cannot read the root package.json.");

  const entries = [];
  const visited = new Set();
  const seenIds = new Set();
  // parent -> spec pairs for optional deps we deliberately do not resolve.
  const platformOptional = new Set();
  const unresolvedRequired = [];
  const queue = Object.keys(rootPkg.dependencies ?? {}).map((name) => ({
    name,
    from: projectRoot,
    parent: rootPkg.name ?? "(root)",
    optional: false,
  }));

  const addPackage = (dir, pkg, note) => {
    const id = `${pkg.name}@${pkg.version}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    entries.push(makeEntry({ closure: "npm", name: pkg.name, version: pkg.version, declared: declaredNpmLicense(pkg), dir, note }));
  };

  while (queue.length > 0) {
    const item = queue.shift();
    const spec = `${item.parent} → ${item.name}@${item.range ?? "*"}`;
    const dir = resolveDependency(item.from, item.name);
    if (!dir) {
      // An optional dependency that is not installed is almost always a
      // platform-gated native binary; record the declared spec so the answer is
      // the same on macOS and on Linux CI.
      if (item.optional) platformOptional.add(spec);
      else unresolvedRequired.push(`${item.parent} → ${item.name} (${item.range ?? "*"})`);
      continue;
    }
    const pkg = readJson(join(dir, "package.json"));
    if (!pkg?.name) continue;
    // Gated binaries differ per host. Treat them as declared specs, not installs.
    if (item.optional && (pkg.os || pkg.cpu)) {
      platformOptional.add(spec);
      continue;
    }
    if (visited.has(dir)) continue;
    visited.add(dir);
    addPackage(dir, pkg);

    for (const nested of collectNestedPackageRoots(dir)) {
      const nestedPkg = readJson(join(nested, "package.json"));
      if (nestedPkg?.name && nestedPkg?.version) {
        addPackage(nested, nestedPkg, `bundled inside ${pkg.name}@${pkg.version}`);
      }
    }

    const parent = `${pkg.name}@${pkg.version}`;
    const enqueue = (dependencies, optional, include = () => true) => {
      for (const [name, range] of Object.entries(dependencies ?? {})) {
        if (include(name)) queue.push({ name, range, from: dir, parent, optional });
      }
    };
    enqueue(pkg.dependencies, false);
    enqueue(pkg.optionalDependencies, true);
    // A peer is supplied by whoever installed the tree; a missing one is a
    // resolution detail, not an attribution gap, so it is not reported.
    enqueue(pkg.peerDependencies, false, (name) =>
      !pkg.peerDependenciesMeta?.[name]?.optional && resolveDependency(dir, name) !== null);
  }

  return {
    entries,
    platformOptional: [...platformOptional].sort(),
    unresolvedRequired: [...new Set(unresolvedRequired)].sort(),
  };
}

// ---------------------------------------------------------------------------
// Closure 2 — crates linked into the Rust binary
// ---------------------------------------------------------------------------

/**
 * `cargo metadata` only reads manifests — it never compiles anything — but it
 * does need each crate's source in the registry cache, so a cold run may
 * download .crate archives. That is the only network this script does.
 */
export function collectCrates() {
  let raw;
  try {
    raw = execFileSync(
      "cargo",
      ["metadata", "--manifest-path", join(projectRoot, "src-tauri/Cargo.toml"), "--format-version", "1", "--locked"],
      { cwd: projectRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    throw new Error(
      `cargo metadata failed — the crates closure cannot be generated.\n${error.stderr || error.message}`,
      { cause: error },
    );
  }
  const metadata = JSON.parse(raw);
  const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  const nodes = new Map((metadata.resolve?.nodes ?? []).map((node) => [node.id, node]));

  // Walk normal and build edges only. dev-dependencies are compiled for `cargo
  // test`, never linked into a shipped binary, so attributing them would
  // overstate what we distribute. Target platforms are NOT filtered: Lattice
  // ships macOS, Linux and Windows builds, and a per-host closure would make
  // --check host-dependent.
  const members = new Set(metadata.workspace_members ?? []);
  const reachable = new Set();
  const stack = [...members];
  while (stack.length > 0) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      const kinds = dep.dep_kinds ?? [];
      if (kinds.length === 0 || kinds.some((k) => k.kind === null || k.kind === "build")) stack.push(dep.pkg);
    }
  }

  const entries = [];
  for (const id of reachable) {
    if (members.has(id)) continue; // Lattice itself; its LICENSE is the repo root.
    const pkg = byId.get(id);
    if (!pkg) continue;
    const dir = dirname(pkg.manifest_path);
    entries.push(makeEntry({
      closure: "crates",
      name: pkg.name,
      version: pkg.version,
      declared: pkg.license ?? (pkg.license_file ? `see ${pkg.license_file}` : null),
      dir,
      extraTextPaths: pkg.license_file ? [resolve(dir, pkg.license_file)] : [],
    }));
  }
  return { entries };
}
