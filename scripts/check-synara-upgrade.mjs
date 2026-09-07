import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pinPath = "scripts/synara-runtime.json";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Run before publishing a new pin, while the previous source checkout is still
// available. An ancestor check preserves history, not behavior: browser tests
// must still catch changes lost while resolving a merge conflict.
export function checkSynaraUpgrade({ projectRoot, previousRef, sourceDirectory }) {
  const previous = JSON.parse(git(projectRoot, ["show", `${previousRef}:${pinPath}`]));
  const next = JSON.parse(readFileSync(resolve(projectRoot, pinPath), "utf8"));
  const sourceRoot = resolve(projectRoot, sourceDirectory || next.sourceDirectory);
  const previousSourceRoot = resolve(projectRoot, previous.sourceDirectory);

  for (const root of new Set([sourceRoot, previousSourceRoot])) {
    if (!existsSync(root)) {
      throw new Error(`Synara checkout is missing at ${root}; restore it to audit local patches before upgrading.`);
    }
    const dirty = git(root, ["status", "--short", "--untracked-files=all"]);
    if (dirty) {
      throw new Error(`Synara has uncommitted or untracked changes at ${root}:\n${dirty}\nPreserve intended patches and regression tests in the fork before changing the pin.`);
    }
  }

  if (git(sourceRoot, ["rev-parse", "HEAD"]) !== next.revision) {
    throw new Error("The new Synara checkout does not match scripts/synara-runtime.json.");
  }
  // Include local commits in the old checkout, not only its previously pinned
  // commit. Otherwise a committed-but-unpinned fix can also disappear silently.
  const previousHead = git(previousSourceRoot, ["rev-parse", "HEAD"]);
  for (const revision of new Set([previous.revision, previousHead])) {
    try {
      git(sourceRoot, ["merge-base", "--is-ancestor", revision, next.revision]);
    } catch {
      throw new Error(`The new Synara pin does not prove preservation of ${revision}. Fetch the fork's full history and merge the previous Lattice integration; do not replace it with a clean upstream checkout.`);
    }
  }
  return { previousRevision: previous.revision, revision: next.revision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const previousRef = process.argv[2];
  if (!previousRef || process.argv.length !== 3) {
    console.error("Usage: node scripts/check-synara-upgrade.mjs <previous-lattice-ref>");
    process.exitCode = 1;
  } else {
    try {
      checkSynaraUpgrade({
        projectRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        previousRef,
        sourceDirectory: process.env.SYNARA_SOURCE_DIR?.trim(),
      });
      console.log("Synara upgrade history and local-patch checks passed. Run the Lattice embed browser regressions before publishing the pin.");
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
