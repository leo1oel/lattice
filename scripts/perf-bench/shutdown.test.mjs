// @vitest-environment node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const SHUTDOWN = new URL("./shutdown.mjs", import.meta.url).href;

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Runs `body` in a real Node process with the signal handlers installed, as
 * perf-bench is, sends it `signals` once it says "ready", and resolves with
 * how it exited and the lines it logged to `log` (a file, so the exit hook
 * can write to it too).
 */
function runUntilSignalled(body, signals = ["SIGTERM"], graceMs = 10_000) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lattice-shutdown-test-"));
  dirs.push(dir);
  const log = path.join(dir, "log");
  const script = `
    import { appendFileSync } from "node:fs";
    import { exitOnSignals, once, onShutdown, withoutSigtermExit } from ${JSON.stringify(SHUTDOWN)};
    const log = (line) => appendFileSync(${JSON.stringify(log)}, line + "\\n");
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    process.on("exit", () => log("exit hook"));
    exitOnSignals({ graceMs: ${graceMs} });
    ${body}
    console.log("ready");
    setInterval(() => {}, 1_000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.stdout.on("data", async (chunk) => {
      if (!String(chunk).includes("ready")) return;
      for (const signal of signals) {
        child.kill(signal);
        await new Promise((next) => setTimeout(next, 50));
      }
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({
      code,
      signal,
      stderr,
      lines: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    }));
  });
}

describe("perf-bench signal shutdown", () => {
  // The leak this prevents: --serve --chrome is only ever stopped by a signal,
  // and exiting at once killed Chrome without removing its profile.
  it("awaits every registered close before exiting with the signal's status", async () => {
    const result = await runUntilSignalled(`
      onShutdown(async () => { await sleep(300); log("browser profile removed"); });
      onShutdown(async () => { await sleep(100); log("build removed"); });
    `);
    expect(result.stderr).toBe("");
    expect(result).toMatchObject({ code: 143, signal: null });
    expect(result.lines).toEqual(["build removed", "browser profile removed", "exit hook"]);
  });

  it("exits with each signal's own status", async () => {
    expect((await runUntilSignalled("", ["SIGINT"])).code).toBe(130);
    expect((await runUntilSignalled("", ["SIGHUP"])).code).toBe(129);
  });

  it("skips a close its owner unregistered", async () => {
    const result = await runUntilSignalled(`
      const unregister = onShutdown(() => log("closed"));
      unregister();
    `);
    expect(result.lines).toEqual(["exit hook"]);
  });

  it("closes a resource once when its owner and a signal both close it", async () => {
    const result = await runUntilSignalled(`
      const close = once(async () => { log("closing"); await sleep(200); });
      onShutdown(close);
      process.on("SIGTERM", () => close());
    `);
    expect(result.lines).toEqual(["closing", "exit hook"]);
  });

  it("still exits, and runs the exit hook, when a close fails", async () => {
    const result = await runUntilSignalled(`
      onShutdown(async () => { throw new Error("profile busy"); });
      onShutdown(async () => log("other cleanup ran"));
    `);
    expect(result.code).toBe(143);
    expect(result.lines).toEqual(["other cleanup ran", "exit hook"]);
    expect(result.stderr).toContain("cleanup after SIGTERM failed: profile busy");
  });

  // The cause of the leak once the close was awaited: Vite's servers exit on
  // SIGTERM themselves, ending the process while Chrome's profile was still
  // being removed.
  it("keeps a real Vite preview server from exiting before the closes finish", async () => {
    const result = await runUntilSignalled(`
      const { preview } = await import("vite");
      const server = await withoutSigtermExit(() => preview({ configFile: false, logLevel: "silent", root: ${JSON.stringify(os.tmpdir())}, preview: { port: 0, host: "127.0.0.1" } }));
      onShutdown(async () => { await server.close(); log("server closed"); });
      onShutdown(async () => { await sleep(300); log("browser profile removed"); });
    `);
    expect(result.code).toBe(143);
    expect(result.lines).toEqual(["server closed", "browser profile removed", "exit hook"]);
  });

  it("exits at once on a second signal", async () => {
    const result = await runUntilSignalled(`onShutdown(() => new Promise(() => {}));`, ["SIGTERM", "SIGINT"]);
    expect(result.code).toBe(130);
    expect(result.lines).toEqual(["exit hook"]);
  });

  it("gives up on a close that overruns its grace", async () => {
    const result = await runUntilSignalled(`onShutdown(() => new Promise(() => {}));`, ["SIGTERM"], 200);
    expect(result.code).toBe(143);
    expect(result.lines).toEqual(["exit hook"]);
    expect(result.stderr).toContain("exiting without it");
  });
});
