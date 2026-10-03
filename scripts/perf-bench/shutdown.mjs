/**
 * Graceful exit on SIGINT, SIGTERM and SIGHUP. A signal's default action ends
 * the process without running anything, and a bare process.exit() runs only
 * the synchronous exit hooks: enough to kill a browser, not to wait for it to
 * let go of its profile and remove it. `--serve --chrome` is only ever stopped
 * by a signal, so without this every stop left a Chrome profile (tens of
 * megabytes) in TMPDIR.
 *
 * A resource registers its asynchronous close with onShutdown(); the first
 * signal awaits every registered close (within GRACE_MS) and then exits with
 * the signal's status, which still runs the exit hooks as a last resort. A
 * second signal exits at once.
 */
import os from "node:os";

/** Long enough for Chrome to exit and its profile removal to retry (cdp.mjs). */
const GRACE_MS = 15_000;
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

const closers = new Set();
let stopping = null;

/** Runs `close` before a signal exits the process; returns its unregistration. */
export function onShutdown(close) {
  closers.add(close);
  return () => closers.delete(close);
}

/** Whether a signal is closing everything down: an error from a resource torn out from under its user is expected then. */
export function shuttingDown() {
  return stopping !== null;
}

/** Calls `close` once, however many times it is called and by whom (its owner, a signal, or both). */
export function once(close) {
  let closing = null;
  return () => (closing ??= Promise.resolve().then(close));
}

/**
 * Runs `start` and removes any SIGTERM listener it added. Vite's servers
 * install one that closes the server and calls process.exit() at once, which
 * would end the process before a browser's close (or anything else
 * registered here) finished: the build went, the Chrome profile stayed.
 * This module owns the process's signals; a server registers its close with
 * onShutdown() instead.
 */
export async function withoutSigtermExit(start) {
  const before = new Set(process.listeners("SIGTERM"));
  try {
    return await start();
  } finally {
    for (const listener of process.listeners("SIGTERM")) {
      if (!before.has(listener)) process.off("SIGTERM", listener);
    }
  }
}

/**
 * Installs the signal handlers. `describe(signal)` may return a line to print
 * first, saying what the process was doing.
 */
export function exitOnSignals({ describe = () => null, graceMs = GRACE_MS } = {}) {
  for (const signal of SIGNALS) {
    process.on(signal, () => {
      const status = 128 + os.constants.signals[signal];
      if (stopping) {
        console.error(`perf-bench: ${signal} again, exiting without waiting for cleanup`);
        process.exit(status);
      }
      const line = describe(signal);
      if (line) console.error(line);
      stopping = signal;
      const closes = [...closers].map((close) => Promise.resolve().then(close).catch((error) => {
        console.error(`perf-bench: cleanup after ${signal} failed: ${error.message}`);
      }));
      let timer;
      const expired = new Promise((resolve) => {
        timer = setTimeout(() => {
          console.error(`perf-bench: cleanup after ${signal} took over ${graceMs / 1000} s, exiting without it`);
          resolve();
        }, graceMs);
      });
      Promise.race([Promise.all(closes), expired]).then(() => {
        clearTimeout(timer);
        process.exit(status);
      });
    });
  }
}
