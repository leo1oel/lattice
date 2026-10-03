// @vitest-environment node
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PERF_BENCH = fileURLToPath(new URL("../perf-bench.mjs", import.meta.url));

/**
 * The real `pnpm perf:bench` end to end: a production build served with
 * --serve --smoke --chrome, smoke checks of that page in each interface
 * language, and the SIGTERM that docs/driving-the-app.md stops it with. TMPDIR
 * is a directory of the test's own, so what the run leaves behind there is
 * this run's alone. A production build and three Chrome sessions are too slow
 * for the default suite, so it runs only with LATTICE_E2E=1
 * (`pnpm test:e2e-harness`).
 */
describe.skipIf(process.env.LATTICE_E2E !== "1")("perf-bench --serve --smoke --chrome", () => {
  let tmp;
  let server;
  let exited;
  let output = "";
  const env = () => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !["NODE_ENV", "VITEST", "TEST"].includes(name))),
    TMPDIR: tmp,
  });
  const leftovers = () => readdirSync(tmp).filter((name) => name.startsWith("lattice-perf-bench-"));

  function perfBench(args) {
    const child = spawn(process.execPath, [PERF_BENCH, ...args], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
    });
  }

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "lattice-smoke-test-"));
    server = spawn(process.execPath, [PERF_BENCH, "--serve", "--smoke", "--chrome", "--port", "0", "--lang", "zh-CN"], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    server.stderr.on("data", (chunk) => (stderr += chunk));
    exited = new Promise((resolve) => server.once("exit", (code, signal) => resolve({ code, signal })));
    await new Promise((resolve, reject) => {
      server.stdout.on("data", (chunk) => {
        output += chunk;
        if (output.includes("Press Ctrl-C to stop.")) resolve();
      });
      exited.then(({ code }) => reject(new Error(`perf-bench exited ${code} before serving:\n${output}\n${stderr}`)));
    });
  }, 240_000);

  afterAll(async () => {
    if (server && server.exitCode === null && server.signalCode === null) {
      server.kill("SIGKILL");
      await exited;
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  function pageUrl(lang) {
    const url = new URL(output.match(/^ {2}(http:\/\/\S+)$/m)[1]);
    url.searchParams.set("lang", lang);
    return url.href;
  }

  it("passes the smoke check of a page served in Chinese", () => {
    expect(output).toMatch(/Smoke check passed: .*\(interface language: zh-CN\)/);
    expect(leftovers()).toEqual(expect.arrayContaining([expect.stringMatching(/^lattice-perf-bench-dist-/), expect.stringMatching(/^lattice-perf-bench-(?!dist-)/)]));
  });

  it("passes the smoke check in English", async () => {
    const result = await perfBench(["--smoke", "--url", pageUrl("en")]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Smoke check passed: .*\(interface language: en\)/);
  }, 180_000);

  it("passes the smoke check when lang=system resolves to Chinese", async () => {
    const result = await perfBench(["--smoke", "--url", pageUrl("system"), "--locale", "zh-CN"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Smoke check passed: .*\(interface language: zh-CN\)/);
  }, 180_000);

  it("leaves neither the build nor the browser profile behind after SIGTERM", async () => {
    server.kill("SIGTERM");
    expect(await exited).toEqual({ code: 143, signal: null });
    expect(leftovers()).toEqual([]);
  }, 30_000);
});
