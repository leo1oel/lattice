// @vitest-environment node
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const CDP = new URL("./cdp.mjs", import.meta.url).href;
const SHUTDOWN = new URL("./shutdown.mjs", import.meta.url).href;

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A "browser" that cannot shut down: it ignores SIGTERM, and its startup
 * line points DevTools at a port nothing listens on (or it prints nothing,
 * so startup waits until a signal arrives). It records its pid.
 *
 * The `.cjs` extension pins the stub to CommonJS: an extensionless script
 * takes its module format from the nearest package.json, so under a
 * `"type": "module"` package (this repo, when TMPDIR points into it) its
 * `require` throws before the stub records its pid or ignores SIGTERM. The
 * dir gets such a package.json so every run proves the stub is immune.
 */
function stubbornBrowser(dir, { announce }) {
  writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n');
  const executable = path.join(dir, "stubborn-chrome.cjs");
  writeFileSync(executable, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "browser.pid"))}, String(process.pid));
process.on("SIGTERM", () => {});
${announce ? 'process.stderr.write("DevTools listening on ws://127.0.0.1:9/devtools/browser/x\\n");' : ""}
setInterval(() => {}, 1_000);
`);
  chmodSync(executable, 0o755);
  return executable;
}

/** Runs `body` in a Node process whose TMPDIR is `dir/tmp`; resolves with how it exited. */
function run(dir, body, { signalWhenPidFile = false } = {}) {
  const tmp = path.join(dir, "tmp");
  mkdirSync(tmp, { recursive: true });
  const script = `
    import { launchChrome } from ${JSON.stringify(CDP)};
    import { exitOnSignals } from ${JSON.stringify(SHUTDOWN)};
    ${body}
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TMPDIR: tmp },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  if (signalWhenPidFile) {
    const poll = setInterval(() => {
      if (!existsSync(path.join(dir, "browser.pid"))) return;
      clearInterval(poll);
      child.kill("SIGTERM");
    }, 50);
    child.once("exit", () => clearInterval(poll));
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr, leftovers: readdirSync(tmp) }));
  });
}

function browserPid(dir) {
  return Number(readFileSync(path.join(dir, "browser.pid"), "utf8"));
}

describe("launchChrome cleanup", () => {
  it("kills a browser that ignores SIGTERM and removes its profile when startup fails", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lattice-cdp-test-"));
    dirs.push(dir);
    const executable = stubbornBrowser(dir, { announce: true });
    const result = await run(dir, `
      try { await launchChrome({ executable: ${JSON.stringify(executable)} }); }
      catch (error) { console.log("caught: " + error.message); }
    `);
    expect(result.stdout).toContain("caught: Could not connect to ws://127.0.0.1:9/");
    expect(result.code).toBe(0);
    expect(alive(browserPid(dir))).toBe(false);
    expect(result.leftovers).toEqual([]);
  }, 20_000);

  // The shutdown handler exits after its grace whether or not close() is done,
  // so close() must reap a stuck browser and remove its profile before then.
  it("reaps a browser that ignores SIGTERM within a signal's grace", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lattice-cdp-test-"));
    dirs.push(dir);
    const executable = stubbornBrowser(dir, { announce: false });
    const result = await run(dir, `
      exitOnSignals();
      await launchChrome({ executable: ${JSON.stringify(executable)} });
    `, { signalWhenPidFile: true });
    expect(result.stderr).not.toContain("exiting without it");
    expect(result.code).toBe(143);
    expect(alive(browserPid(dir))).toBe(false);
    expect(result.leftovers).toEqual([]);
  }, 20_000);

  it.each([
    ["is missing", (dir) => path.join(dir, "missing-chrome"), "ENOENT"],
    ["is not executable", (dir) => {
      const executable = path.join(dir, "plain-file");
      writeFileSync(executable, "");
      return executable;
    }, "EACCES"],
  ])("rejects with a useful error and leaves no profile when the browser %s", async (_, make, code) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "lattice-cdp-test-"));
    dirs.push(dir);
    const executable = make(dir);
    const result = await run(dir, `
      try { await launchChrome({ executable: ${JSON.stringify(executable)} }); }
      catch (error) { console.log("caught: " + error.message); }
    `);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(`caught: Could not start Chrome at ${executable}`);
    expect(result.stdout).toContain(code);
    expect(result.code).toBe(0);
    expect(result.leftovers).toEqual([]);
  }, 10_000);
});
