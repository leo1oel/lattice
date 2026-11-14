/**
 * The machine-wide GPUI build lock, which every checkout on this machine
 * shares. It is a directory, which mkdir creates atomically; the owner's pid
 * inside lets a waiter take over a lock its holder died holding.
 *
 * It is held for one GPUI release build or test run: the host has 16 GB of
 * memory, a GPUI release build takes several GB of rustc per job, and two of
 * them at once, from two worktrees, swapped the machine to a crawl.
 * `scripts/gpui-build.mjs` holds it around the shared build tree as well,
 * which only one build may write at a time.
 *
 * The e2e input lock (`/tmp/lattice-gpui-e2e.lock`) follows the same
 * protocol, but only the GPUI scenario takes it, itself, around the steps
 * that need its window key
 * (`gpui/crates/lattice-gpui/src/scenario/input_lock.rs`, gpui/README.md,
 * "Scenarios"); no script here does any more, so this module no longer
 * exports one for it.
 *
 * A holder has a maximum hold time, counted from when it wrote its owner
 * file (that file's mtime): 30 minutes, or `LATTICE_GPUI_BUILD_LOCK_MAX_MINUTES`.
 * Past it a waiter takes the lock over even though the holder is alive. A
 * review-fix agent's looping unit test once held the build lock for over 15
 * minutes while every other lane's compile check queued behind it, and an
 * agent turn waiting silently was killed at its 30-minute budget. The holder
 * is not killed, only logged: a live pid past its limit is most likely hung,
 * but it is still someone's process. A lock directory with no owner file for
 * a minute (a holder that died between mkdir and the write) is taken over
 * too.
 *
 * Taking over renames the directory to a unique name first, which only one
 * waiter can do, so two waiters that both judged it stale cannot both remove
 * it, and the second never removes the lock the first has just taken.
 * Releasing removes the directory only while its owner is still this
 * process, so a holder that was taken over does not remove its successor's
 * lock when it finally exits.
 *
 * Each acquire, release, takeover and wait prints a line with an ISO
 * timestamp, and a waiter prints its waiting line again every minute, with
 * the holder and how long it has held, so a waiting agent turn produces
 * output and the logs show hold and wait times.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const held = new Set();
const MINUTE = 60_000;

function maxHoldFromEnv(name, minutes) {
  const value = Number(process.env[name]);
  return (Number.isFinite(value) && value > 0 ? value : minutes) * MINUTE;
}

function stamp(now = Date.now()) {
  return new Date(now).toISOString();
}

function duration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes} min ${total % 60} s` : `${total} s`;
}

/**
 * One machine-wide lock at `dir`. `options` are for tests: the poll and
 * waiting-line intervals, the maximum hold, the logger and the clock.
 */
export function machineLock(dir, waitingFor, { maxHoldMs, pollMs = 5_000, waitLogMs = MINUTE, log = console.log, now = Date.now } = {}) {
  const ownerFile = path.join(dir, "owner");

  /** The owner line and when it was written, or null when there is none. */
  function readOwner() {
    try {
      const line = readFileSync(ownerFile, "utf8").trim();
      return { line, since: statSync(ownerFile).mtimeMs };
    } catch {
      return null;
    }
  }

  /** Why the lock at `dir` may be taken over, or null while it is fair. */
  function staleness(owner) {
    if (!owner) {
      // Created but not yet written; a holder that is starting up writes
      // within milliseconds, so a minute without one means it died there.
      try {
        const age = now() - statSync(dir).mtimeMs;
        return age > MINUTE ? `no owner was written in ${duration(age)}` : null;
      } catch {
        return null;
      }
    }
    const pid = Number(owner.line.split(" ")[0]);
    if (pid && !alive(pid)) return `pid ${pid} died holding it`;
    const age = now() - owner.since;
    if (age > maxHoldMs) return `${owner.line} has held it ${duration(age)}, past the ${duration(maxHoldMs)} limit`;
    return null;
  }

  /** Moves the stale lock aside, unless another waiter or holder got there first. */
  function takeOver(owner, why) {
    const aside = `${dir}.stale-${process.pid}-${now()}`;
    try {
      renameSync(dir, aside);
    } catch (error) {
      if (error.code === "ENOENT") return; // another waiter moved it first
      throw error;
    }
    let moved = null;
    try {
      moved = readFileSync(path.join(aside, "owner"), "utf8").trim();
    } catch {
      // No owner file: the one judged stale had none either, or it is being
      // written by a holder that took the lock after it was judged.
    }
    if ((moved ?? "") !== (owner?.line ?? "")) {
      // Someone took the lock between the check and the rename: put theirs
      // back, unless the place is taken again already.
      try {
        renameSync(aside, dir);
        return;
      } catch {
        log(`${stamp(now())} gpui-lock: could not give ${dir} back to ${moved || "its new holder"}; it is at ${aside}`);
        return;
      }
    }
    rmSync(aside, { recursive: true, force: true });
    log(`${stamp(now())} gpui-lock: took over ${dir} (${why})`);
  }

  let acquiredAt = 0;
  return {
    /** Waits for the lock, then takes it; `who` is shown to anyone waiting. */
    async acquire(who) {
      const asked = now();
      let lastLog = -Infinity;
      for (;;) {
        try {
          mkdirSync(dir);
          writeFileSync(ownerFile, `${process.pid} ${who}\n`);
          held.add(dir);
          acquiredAt = now();
          const waited = acquiredAt - asked;
          log(`${stamp(acquiredAt)} gpui-lock: acquired ${dir} as pid ${process.pid}${waited >= 1000 ? `, after waiting ${duration(waited)}` : ""}`);
          return;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
        const owner = readOwner();
        const why = staleness(owner);
        if (why) {
          takeOver(owner, why);
          continue;
        }
        if (now() - lastLog >= waitLogMs) {
          const holding = owner ? `${owner.line}, for ${duration(now() - owner.since)}` : "a process starting up";
          log(`${stamp(now())}   (waiting for ${waitingFor} held by ${holding}; waited ${duration(now() - asked)})`);
          lastLog = now();
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    },
    release() {
      if (!held.delete(dir)) return;
      const owner = readOwner();
      if (owner && Number(owner.line.split(" ")[0]) !== process.pid) {
        log(`${stamp(now())} gpui-lock: ${dir} was taken over while held (now ${owner.line}); leaving it`);
        return;
      }
      rmSync(dir, { recursive: true, force: true });
      log(`${stamp(now())} gpui-lock: released ${dir} after holding ${duration(now() - acquiredAt)}`);
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
const build = machineLock("/tmp/lattice-gpui-release.lock", "the GPUI release build lock", {
  maxHoldMs: maxHoldFromEnv("LATTICE_GPUI_BUILD_LOCK_MAX_MINUTES", 30),
});
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
