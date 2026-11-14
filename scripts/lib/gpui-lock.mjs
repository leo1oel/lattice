/**
 * The GPUI release build lock every checkout on this machine shares. It is a
 * directory, which mkdir creates atomically; the owner's pid inside lets a
 * waiter take over a lock its holder died holding.
 *
 * It is held for one GPUI release build or test run: the host has 16 GB of
 * memory, a GPUI release build takes several GB of rustc per job, and two of
 * them at once, from two worktrees, swapped the machine to a crawl.
 * `scripts/gpui-build.mjs` holds it around the shared build tree as well,
 * which only one build may write at a time.
 *
 * The e2e input lock (`/tmp/lattice-gpui-e2e.lock`, held while a scenario
 * needs its window key) follows the same protocol but lives entirely on the
 * Rust side, around just those steps
 * (`gpui/crates/lattice-gpui/src/scenario/input_lock.rs`, gpui/README.md,
 * "Scenarios"). It is separate from this lock, so one worktree's build and
 * another's e2e run overlap.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const held = new Set();

function machineLock(dir, waitingFor) {
  return {
    /** Waits for the lock, then takes it; `who` is shown to anyone waiting. */
    async acquire(who) {
      let announced = false;
      for (;;) {
        try {
          mkdirSync(dir);
          writeFileSync(path.join(dir, "owner"), `${process.pid} ${who}\n`);
          held.add(dir);
          return;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        let owner = "";
        try {
          owner = readFileSync(path.join(dir, "owner"), "utf8").trim();
        } catch {
          // Created but not yet written; the next poll reads it.
        }
        const pid = Number(owner.split(" ")[0]);
        if (pid && !alive(pid)) {
          console.log(`  (taking over ${dir} from pid ${pid}, which died holding it)`);
          rmSync(dir, { recursive: true, force: true });
          continue;
        }
        if (!announced) {
          console.log(`  (waiting for ${waitingFor} held by ${owner || "a process starting up"})`);
          announced = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    },
    release() {
      if (!held.delete(dir)) return;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// /tmp, not os.tmpdir(): macOS gives each user session its own TMPDIR.
const build = machineLock("/tmp/lattice-gpui-release.lock", "the GPUI release build lock");
export const acquireGpuiLock = build.acquire;
export const releaseGpuiLock = build.release;

// An `exit` handler runs on a normal exit and after process.exit(); a signal's
// default action skips it, so the signals a stage timeout or Ctrl-C sends exit
// through it instead. A SIGKILL leaves the lock behind for the next waiter to
// take over from the dead pid.
process.on("exit", () => {
  build.release();
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => process.exit(128 + { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 }[signal]));
}
