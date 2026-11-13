#!/usr/bin/env node
/**
 * Runs a command under the machine-wide GPUI e2e lock (scripts/lib/gpui-lock.mjs),
 * for shell scripts that drive the GPUI app with native input:
 *
 *   node scripts/with-gpui-e2e-lock.mjs <label> -- <command> [args...]
 *
 * `label` (a worktree path, say) is shown to anyone waiting. The command gets
 * LATTICE_GPUI_E2E_LOCK_HELD=1, so a script that re-executes itself under
 * this wrapper knows not to wait for the lock it already holds. A signal to
 * the wrapper is passed on to the command, and the lock is released when the
 * command exits.
 */
import { spawn } from "node:child_process";
import { acquireGpuiInputLock, releaseGpuiInputLock } from "./lib/gpui-lock.mjs";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
if (sep !== 1 || args.length < 3) {
  console.error("usage: node scripts/with-gpui-e2e-lock.mjs <label> -- <command> [args...]");
  process.exit(2);
}
const [label] = args;
const [command, ...rest] = args.slice(2);

await acquireGpuiInputLock(label);
const child = spawn(command, rest, { stdio: "inherit", env: { ...process.env, LATTICE_GPUI_E2E_LOCK_HELD: "1" } });
// Replace the lock module's exit-on-signal handlers: forward the signal and
// let the command's exit end this process, so the lock outlives no input.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.removeAllListeners(signal);
  process.on(signal, () => child.kill(signal));
}
child.on("error", (error) => {
  console.error(`with-gpui-e2e-lock: ${error.message}`);
  releaseGpuiInputLock();
  process.exit(127);
});
child.on("exit", (code, signal) => {
  releaseGpuiInputLock();
  process.exit(code ?? 128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[signal] ?? 1));
});
