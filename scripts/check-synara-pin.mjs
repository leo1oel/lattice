import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pinPath = "scripts/synara-runtime.json";

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function succeeds(cwd, args) {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

// CI's half of check-synara-upgrade.mjs: it needs no local checkout, only the
// published fork, so it runs on every pull request that moves the pin. It
// proves two things about the pushed history and nothing about behavior:
// - the pin is reachable from its declared branch, so the next lane that starts
//   from the branch tip carries it, and release-cache.yml's shallow fetch of
//   the revision never depends on a side branch that may be deleted;
// - the previous pin is an ancestor of the new one, so a pin cut from a stale
//   or parallel branch cannot silently drop another lane's Synara change.
// Only commits are fetched (`--filter=tree:0`): ancestry needs no trees or
// blobs, which keeps the fetch to a few seconds.
export function checkSynaraPin({ projectRoot, baseRef }) {
  const next = JSON.parse(readFileSync(resolve(projectRoot, pinPath), "utf8"));
  let previous = null;
  try {
    previous = JSON.parse(git(projectRoot, ["show", `${baseRef}:${pinPath}`]));
  } catch {
    // A base without the pin file has nothing to preserve.
  }
  if (
    previous &&
    previous.repository === next.repository &&
    previous.branch === next.branch &&
    previous.revision === next.revision
  ) {
    return { changed: false, revision: next.revision };
  }

  if (!/^[0-9a-f]{40}$/.test(next.revision ?? "")) {
    throw new Error(`${pinPath} revision must be a full 40-character commit SHA, got "${next.revision}".`);
  }

  const scratch = mkdtempSync(join(tmpdir(), "synara-pin-"));
  try {
    git(scratch, ["init", "-q"]);
    // Fetch otherwise starts a detached auto-maintenance that is still
    // writing into the scratch repository when it is removed below.
    git(scratch, ["config", "gc.auto", "0"]);
    git(scratch, ["config", "maintenance.auto", "false"]);
    git(scratch, ["remote", "add", "origin", next.repository]);
    const branchRef = `refs/remotes/origin/${next.branch}`;
    if (!succeeds(scratch, ["fetch", "-q", "--no-tags", "--filter=tree:0", "origin", `refs/heads/${next.branch}:${branchRef}`])) {
      throw new Error(`Branch ${next.branch} does not exist on ${next.repository}. Push it, or set "branch" in ${pinPath} to the fork branch that carries the pin.`);
    }
    // A commit that is not on the branch can still be fetched by SHA while
    // some other ref reaches it, which lets the messages below say which
    // check failed instead of only "not found".
    const ensure = (revision) =>
      succeeds(scratch, ["cat-file", "-e", `${revision}^{commit}`]) ||
      succeeds(scratch, ["fetch", "-q", "--no-tags", "--filter=tree:0", "origin", revision]);

    if (!ensure(next.revision)) {
      throw new Error(`Pinned revision ${next.revision} is not published on ${next.repository}. Push the fork commit before publishing the pin.`);
    }
    if (!succeeds(scratch, ["merge-base", "--is-ancestor", next.revision, branchRef])) {
      throw new Error(`Pinned revision ${next.revision} is not on ${next.branch}. Merge it into ${next.branch} and push the branch, so later pins cut from its tip keep this change.`);
    }

    if (previous?.revision && previous.revision !== next.revision) {
      if (!ensure(previous.revision)) {
        throw new Error(`The previous pin ${previous.revision} (from ${baseRef}) is not published on ${next.repository}, so the new pin cannot prove it keeps that history.`);
      }
      if (!succeeds(scratch, ["merge-base", "--is-ancestor", previous.revision, next.revision])) {
        const dropped = git(scratch, ["log", "--oneline", "--no-decorate", "-n", "20", `${next.revision}..${previous.revision}`]);
        throw new Error(
          `The new pin ${next.revision} does not contain the previous pin ${previous.revision} (from ${baseRef}), so it drops these Synara commits (up to 20 shown):\n${dropped}\n` +
            `Merge ${next.branch} into the Synara change (or rebase it onto the previous pin), push, and pin the result.`,
        );
      }
    }
    return { changed: true, previousRevision: previous?.revision ?? null, revision: next.revision };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const baseRef = process.argv[2];
  if (!baseRef || process.argv.length !== 3) {
    console.error("Usage: node scripts/check-synara-pin.mjs <base-lattice-ref>");
    process.exitCode = 1;
  } else {
    try {
      const result = checkSynaraPin({
        projectRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
        baseRef,
      });
      console.log(
        result.changed
          ? `Synara pin ${result.revision} is on its declared branch and keeps ${result.previousRevision ?? "(no previous pin)"}.`
          : `Synara pin unchanged from ${baseRef}.`,
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
