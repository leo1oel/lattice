/**
 * Two production builds of the bench page served side by side, for the
 * hand-run before/after timing drivers (divider-drag-timing.mjs,
 * tab-drag-timing.mjs): a REF's tree exported beside this checkout, and a
 * build of either served on a free port.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 256 * 2 ** 20 });

/**
 * REF's tree, exported to a temporary directory with this checkout's
 * installed packages linked in. A plugin swapping src/ files at load cannot
 * stand in for it: the stylesheets App.css imports are read from disk, not
 * loaded. When REF's packages or patches differ, that link would not
 * reproduce them: with `install`, REF's own lockfile is installed instead,
 * from the pnpm store where it has the packages; without it, the export
 * refuses.
 */
export function exportTree(ref, { prefix, install = false }) {
  const differs = git("diff", "--name-only", ref, "--", "patches", "package.json", "pnpm-lock.yaml").trim();
  if (differs && !install) {
    throw new Error(`${ref} differs from this checkout in patches/, package.json or the lockfile, so the installed packages are not its`);
  }
  const root = mkdtempSync(path.join(os.tmpdir(), `${prefix}-before-`));
  try {
    execFileSync("sh", ["-c", `git archive ${JSON.stringify(ref)} | tar -x -C ${JSON.stringify(root)}`], { cwd: repo });
    if (differs) execFileSync("pnpm", ["install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    else symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "dir");
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return root;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A production build of the bench page from the tree at `root`, served. */
export async function servePage(root, { prefix }) {
  const { build, preview } = await import("vite");
  const outDir = mkdtempSync(path.join(os.tmpdir(), `${prefix}-dist-`));
  const shared = { root, configFile: path.join(root, "vite.config.ts"), logLevel: "warn", clearScreen: false };
  // Lingui finds its config, and the catalogs it allows, from the working directory.
  const cwd = process.cwd();
  process.chdir(root);
  try {
    await build({
      ...shared,
      build: {
        outDir,
        emptyOutDir: true,
        rolldownOptions: { input: { bench: path.join(root, "tools/perf-bench/index.html") }, output: { strictExecutionOrder: true } },
      },
    });
  } finally {
    process.chdir(cwd);
  }
  const port = await freePort();
  const server = await preview({ ...shared, build: { outDir }, preview: { port, strictPort: true, host: "127.0.0.1" } });
  return {
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      await server.close();
      rmSync(outDir, { recursive: true, force: true });
    },
  };
}
