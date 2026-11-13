/**
 * A lock every checkout on this machine shares, held for one GPUI release
 * build or test run: the host has 16 GB of memory, a GPUI release build takes
 * several GB of rustc per job, and two of them at once, from two worktrees,
 * swapped the machine to a crawl. `scripts/gpui-build.mjs` holds it around
 * the shared build tree as well, which only one build may write at a time.
 *
 * It is a directory, which mkdir creates atomically; the owner's pid inside
 * lets a waiter take over a lock its holder died holding.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// /tmp, not os.tmpdir(): macOS gives each user session its own TMPDIR.
const LOCK = "/tmp/lattice-gpui-release.lock";
let holding = false;

/** Waits for the lock, then takes it; `who` is shown to anyone waiting. */
export async function acquireGpuiLock(who) {
  let announced = false;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(path.join(LOCK, "owner"), `${process.pid} ${who}\n`);
      holding = true;
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    let owner = "";
    try {
      owner = readFileSync(path.join(LOCK, "owner"), "utf8").trim();
    } catch {
      // Created but not yet written; the next poll reads it.
    }
    const pid = Number(owner.split(" ")[0]);
    if (pid && !alive(pid)) {
      rmSync(LOCK, { recursive: true, force: true });
      continue;
    }
    if (!announced) {
      console.log(`  (waiting for another GPUI release build to finish: ${owner || "starting"})`);
      announced = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

export function releaseGpuiLock() {
  if (!holding) return;
  holding = false;
  rmSync(LOCK, { recursive: true, force: true });
}
// An `exit` handler runs on a normal exit and after process.exit(); a signal's
// default action skips it, so the signals a stage timeout or Ctrl-C sends exit
// through it instead. A SIGKILL leaves the lock behind for the next waiter to
// take over from the dead pid.
process.on("exit", releaseGpuiLock);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => process.exit(128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal]));
}
